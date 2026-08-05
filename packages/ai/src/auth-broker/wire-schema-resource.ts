/**
 * ArkType schemas for the auth-broker wire protocol.
 *
 * Shared between the server (validates inbound request bodies) and the client
 * (validates responses from the broker). Schemas mirror the TypeScript types
 * in `./types.ts` 1:1; the types remain the source of truth for static typing,
 * and `Type` is asserted-compatible with them where possible.
 *
 * Envelope and fixed-shape schemas use `"+": "reject"` so unknown keys are
 * rejected — the previous implementation used a hand-rolled `hasOnlyFields`
 * allowlist for the same effect. The OAuth credential schema is the deliberate
 * exception (standard type keeps extra keys): it preserves provider-specific extension fields so
 * they round-trip through the broker instead of being dropped (see below).
 */
import { type Type, type } from "@oh-my-pi/omptype";
import {
	type ApiKeyCredential,
	type AuthCredential,
	type AuthCredentialSnapshotEntry,
	type DisabledCredentialSummary,
	type OAuthCredential,
	REMOTE_REFRESH_SENTINEL,
	type RemoteOAuthCredential,
	type SnapshotCredential,
} from "../auth-storage";
import type {
	ClientUsageReportRequest,
	ClientUsageReportResponse,
	ClientUsageSummaryResponse,
	CredentialBlockRequest,
	CredentialBlockResponse,
	CredentialBlockSnapshot,
	CredentialBlocksDeleteResponse,
	CredentialDisableResponse,
	CredentialRefreshResponse,
	CredentialUploadRequest,
	CredentialUploadResponse,
	DisabledCredentialsResponse,
	HealthzResponse,
	RefresherSchedule,
	SnapshotEntry,
	SnapshotResponse,
	SnapshotStreamEntryEvent,
	SnapshotStreamEvent,
	SnapshotStreamRemovedEvent,
	SnapshotStreamSnapshotEvent,
	UsageHistoryResponse,
	UsageResponse,
	UsageStaleResponse,
} from "./types";

export interface AuthBrokerWireSchemas {
	readonly oauthCredentialSchema: Type<OAuthCredential>;
	readonly remoteOauthCredentialSchema: Type<RemoteOAuthCredential>;
	readonly apiKeyCredentialSchema: Type<ApiKeyCredential>;
	readonly writableAuthCredentialSchema: Type<AuthCredential>;
	readonly snapshotCredentialSchema: Type<SnapshotCredential>;
	readonly credentialSnapshotEntrySchema: Type<AuthCredentialSnapshotEntry>;
	readonly credentialBlockSnapshotSchema: Type<CredentialBlockSnapshot>;
	readonly snapshotEntrySchema: Type<SnapshotEntry>;
	readonly refresherScheduleSchema: Type<RefresherSchedule>;
	readonly snapshotResponseSchema: Type<SnapshotResponse>;
	readonly snapshotStreamSnapshotEventSchema: Type<SnapshotStreamSnapshotEvent>;
	readonly snapshotStreamEntryEventSchema: Type<SnapshotStreamEntryEvent>;
	readonly snapshotStreamRemovedEventSchema: Type<SnapshotStreamRemovedEvent>;
	readonly snapshotStreamEventSchema: Type<SnapshotStreamEvent>;
	readonly healthzResponseSchema: Type<HealthzResponse>;
	readonly usageResponseSchema: Type<UsageResponse>;
	readonly usageHistoryResponseSchema: Type<UsageHistoryResponse>;
	readonly clientUsageReportRequestSchema: Type<ClientUsageReportRequest>;
	readonly clientUsageReportResponseSchema: Type<ClientUsageReportResponse>;
	readonly clientUsageSummaryResponseSchema: Type<ClientUsageSummaryResponse>;
	readonly credentialRefreshResponseSchema: Type<CredentialRefreshResponse>;
	readonly credentialDisableRequestSchema: Type<{ cause?: string }>;
	readonly credentialDisableResponseSchema: Type<CredentialDisableResponse>;
	readonly disabledCredentialSummarySchema: Type<DisabledCredentialSummary>;
	readonly disabledCredentialsResponseSchema: Type<DisabledCredentialsResponse>;
	readonly credentialBlockRequestSchema: Type<CredentialBlockRequest>;
	readonly credentialBlockResponseSchema: Type<CredentialBlockResponse>;
	readonly credentialBlocksDeleteResponseSchema: Type<CredentialBlocksDeleteResponse>;
	readonly usageStaleResponseSchema: Type<UsageStaleResponse>;
	readonly credentialUploadRequestSchema: Type<CredentialUploadRequest>;
	readonly credentialUploadResponseSchema: Type<CredentialUploadResponse>;
}

function buildAuthBrokerWireSchemas(): AuthBrokerWireSchemas {
	// ─── Credential payloads ───────────────────────────────────────────────────

	/** Real OAuth credential (broker-side) — refresh token is the actual upstream value. */
	const oauthCredentialSchema = type({
		"apiEndpoint?": "string",
		type: "'oauth'",
		refresh: type("string").narrow(
			(value, ctx) =>
				value !== REMOTE_REFRESH_SENTINEL ||
				ctx.mustBe(`not equal to the remote sentinel (${REMOTE_REFRESH_SENTINEL})`),
		),
		access: type("string").atLeastLength(1),
		expires: "number",
		"enterpriseUrl?": "string",
		"projectId?": "string",
		"email?": "string",
		"accountId?": "string",
		"orgId?": "string",
		"orgName?": "string",
		"authorizedAt?": "number",
	});

	/** OAuth credential as it appears in broker snapshots — refresh replaced with sentinel. */
	const remoteOauthCredentialSchema = type({
		"apiEndpoint?": "string",
		type: "'oauth'",
		refresh: type.enumerated(REMOTE_REFRESH_SENTINEL),
		access: type("string").atLeastLength(1),
		expires: "number",
		"enterpriseUrl?": "string",
		"projectId?": "string",
		"email?": "string",
		"accountId?": "string",
		"orgId?": "string",
		"orgName?": "string",
		"authorizedAt?": "number",
	});

	const apiKeyCredentialSchema = type({
		"+": "reject",
		type: "'api_key'",
		key: type("string").atLeastLength(1),
		"source?": "'login'",
	});

	/** Discriminated union accepted on POST /v1/credential (writes). */
	const writableAuthCredentialSchema = oauthCredentialSchema.or(apiKeyCredentialSchema);

	/** Discriminated union returned in snapshots (refresh is sentinel for OAuth). */
	const snapshotCredentialSchema = remoteOauthCredentialSchema.or(apiKeyCredentialSchema);

	// ─── Snapshot ──────────────────────────────────────────────────────────────

	const credentialSnapshotEntrySchema = type({
		"+": "reject",
		id: "number.integer",
		provider: type("string").atLeastLength(1),
		credential: snapshotCredentialSchema,
		identityKey: "string | null",
	});

	const credentialBlockSnapshotSchema = type({
		"+": "reject",
		providerKey: type("string").atLeastLength(1),
		blockScope: "string",
		blockedUntilMs: "number",
		"updatedAtMs?": "number",
	});

	const snapshotEntrySchema = type({
		"+": "reject",
		id: "number.integer",
		provider: type("string").atLeastLength(1),
		credential: snapshotCredentialSchema,
		identityKey: "string | null",
		rotatesInMs: "number | null",
		"blocks?": credentialBlockSnapshotSchema.array(),
	});

	const refresherScheduleSchema = type({
		"+": "reject",
		enabled: "boolean",
		intervalMs: "number",
		skewMs: "number",
		nextSweepInMs: "number",
	});

	const snapshotResponseSchema = type({
		"+": "reject",
		generation: "number.integer",
		generatedAt: "number",
		serverNowMs: "number",
		refresher: refresherScheduleSchema,
		credentials: snapshotEntrySchema.array(),
	});

	// ─── Snapshot stream (SSE) ────────────────────────────────────────────────

	/** First frame on connect — full snapshot embedded inline with a `kind` tag. */
	const snapshotStreamSnapshotEventSchema = type({
		"+": "reject",
		generation: "number.integer",
		generatedAt: "number",
		serverNowMs: "number",
		refresher: refresherScheduleSchema,
		credentials: snapshotEntrySchema.array(),
		kind: "'snapshot'",
	});

	/** Per-credential upsert/refresh delta. */
	const snapshotStreamEntryEventSchema = type({
		"+": "reject",
		kind: "'entry'",
		generation: "number.integer",
		serverNowMs: "number",
		refresher: refresherScheduleSchema,
		entry: snapshotEntrySchema,
	});

	/** Per-credential delete delta. */
	const snapshotStreamRemovedEventSchema = type({
		"+": "reject",
		kind: "'removed'",
		generation: "number.integer",
		serverNowMs: "number",
		refresher: refresherScheduleSchema,
		id: "number.integer",
	});

	/** Discriminated union over every event frame the snapshot stream emits. */
	const snapshotStreamEventSchema = snapshotStreamSnapshotEventSchema
		.or(snapshotStreamEntryEventSchema)
		.or(snapshotStreamRemovedEventSchema);

	// ─── Healthz ────────────────────────────────────────────────────────────────

	const healthzResponseSchema = type({
		"+": "reject",
		ok: "boolean",
		"version?": "string",
	});

	// ─── Usage ─────────────────────────────────────────────────────────────────

	const usageUnitSchema = type("'percent' | 'tokens' | 'requests' | 'usd' | 'minutes' | 'bytes' | 'unknown'");
	const usageStatusSchema = type("'ok' | 'warning' | 'exhausted' | 'unknown'");

	const usageWindowSchema = type({
		id: "string",
		label: "string",
		"durationMs?": "number",
		"resetsAt?": "number",
	});

	const usageAmountSchema = type({
		"used?": "number",
		"limit?": "number",
		"remaining?": "number",
		"usedFraction?": "number",
		"remainingFraction?": "number",
		unit: usageUnitSchema,
	});

	const usageScopeSchema = type({
		provider: "string",
		"accountId?": "string",
		"projectId?": "string",
		"orgId?": "string",
		"modelId?": "string",
		"tier?": "string",
		"windowId?": "string",
		"shared?": "boolean",
	});

	const usageLimitSchema = type({
		id: "string",
		label: "string",
		scope: usageScopeSchema,
		"window?": usageWindowSchema,
		amount: usageAmountSchema,
		"status?": usageStatusSchema,
		"notes?": "string[]",
	});

	const usageResetCreditDetailSchema = type({
		"grantedAt?": "string",
		"expiresAt?": "string",
		"status?": "string",
	});

	const usageResetCreditsSchema = type({
		availableCount: "number",
		"credits?": usageResetCreditDetailSchema.array(),
	});

	const arkUsageReportSchema = type({
		provider: "string",
		fetchedAt: "number",
		limits: usageLimitSchema.array(),
		"resetCredits?": usageResetCreditsSchema,
		"notes?": "string[]",
		"metadata?": { "[string]": "unknown" },
		"raw?": "unknown",
	});

	/**
	 * Broker `/v1/usage` response. Reports are full {@link UsageReport}s minus the
	 * heavy provider-specific `raw` field (the server strips it before send) — we
	 * keep `raw` optional in the underlying schema so a misconfigured broker that
	 * forgot to strip still validates.
	 */
	const usageResponseSchema = type({
		"+": "reject",
		generatedAt: "number",
		reports: arkUsageReportSchema.array(),
	});

	const usageHistoryEntrySchema = type({
		recordedAt: "number",
		provider: "string",
		accountKey: "string",
		"email?": "string",
		"accountId?": "string",
		limitId: "string",
		label: "string",
		"windowLabel?": "string",
		"usedFraction?": "number",
		"status?": "'ok' | 'warning' | 'exhausted' | 'unknown'",
		"resetsAt?": "number",
	});

	/** Broker `/v1/usage/history` response — recorded usage-limit snapshots, oldest first. */
	const usageHistoryResponseSchema = type({
		"+": "reject",
		generatedAt: "number",
		entries: usageHistoryEntrySchema.array(),
	});

	const observedUsageEntrySchema = type({
		at: "number",
		provider: "string",
		model: "string",
		requests: "number",
		inputTokens: "number",
		outputTokens: "number",
		cacheReadTokens: "number",
		cacheWriteTokens: "number",
		costUsd: "number",
	});

	/** Broker `POST /v1/usage/observed` request — one client's batched observed usage. */
	const clientUsageReportRequestSchema = type({
		"+": "reject",
		installId: "string",
		"hostname?": "string",
		entries: observedUsageEntrySchema.array(),
	});

	const clientUsageReportResponseSchema = type({
		"+": "reject",
		ok: "boolean",
	});

	const clientProviderUsageSchema = type({
		provider: "string",
		requests: "number",
		inputTokens: "number",
		outputTokens: "number",
		cacheReadTokens: "number",
		cacheWriteTokens: "number",
		costUsd: "number",
	});

	const clientUsageClientSummarySchema = type({
		installId: "string",
		"hostname?": "string",
		firstSeen: "number",
		lastSeen: "number",
		providers: clientProviderUsageSchema.array(),
	});

	/** Broker `GET /v1/usage/clients` response — per-client token burn aggregates. */
	const clientUsageSummaryResponseSchema = type({
		"+": "reject",
		generatedAt: "number",
		clients: clientUsageClientSummarySchema.array(),
	});

	// ─── Refresh ───────────────────────────────────────────────────────────────

	const credentialRefreshResponseSchema = type({
		"+": "reject",
		entry: credentialSnapshotEntrySchema,
	});

	// ─── Disable ───────────────────────────────────────────────────────────────

	const credentialDisableRequestSchema = type({
		"+": "reject",
		"cause?": "string",
	});

	const credentialDisableResponseSchema = type({
		"+": "reject",
		ok: "boolean",
	});

	/** One disabled-credential tombstone — identity + cause, never token material. */
	const disabledCredentialSummarySchema = type({
		"+": "reject",
		id: "number.integer",
		provider: type("string").atLeastLength(1),
		type: "'oauth' | 'api_key'",
		"email?": "string",
		"accountId?": "string",
		"orgId?": "string",
		"orgName?": "string",
		cause: "string",
		"disabledAtMs?": "number",
	});

	/** Broker `GET /v1/credentials/disabled` response. */
	const disabledCredentialsResponseSchema = type({
		"+": "reject",
		generatedAt: "number",
		disabled: disabledCredentialSummarySchema.array(),
	});

	// ─── Credential blocks ──────────────────────────────────────────────────────

	const credentialBlockRequestSchema = credentialBlockSnapshotSchema;

	const credentialBlockResponseSchema = type({
		"+": "reject",
		ok: "boolean",
	});

	const credentialBlocksDeleteResponseSchema = type({
		"+": "reject",
		ok: "boolean",
	});

	const usageStaleResponseSchema = type({
		"+": "reject",
		ok: "boolean",
	});

	// ─── Upload ────────────────────────────────────────────────────────────────

	const credentialUploadRequestSchema = type({
		"+": "reject",
		provider: type("string").atLeastLength(1),
		credential: writableAuthCredentialSchema,
	});

	const credentialUploadResponseSchema = type({
		"+": "reject",
		entries: credentialSnapshotEntrySchema.array(),
	});

	return {
		oauthCredentialSchema,
		remoteOauthCredentialSchema,
		apiKeyCredentialSchema,
		writableAuthCredentialSchema,
		snapshotCredentialSchema,
		credentialSnapshotEntrySchema,
		credentialBlockSnapshotSchema,
		snapshotEntrySchema,
		refresherScheduleSchema,
		snapshotResponseSchema,
		snapshotStreamSnapshotEventSchema,
		snapshotStreamEntryEventSchema,
		snapshotStreamRemovedEventSchema,
		snapshotStreamEventSchema,
		healthzResponseSchema,
		usageResponseSchema,
		usageHistoryResponseSchema,
		clientUsageReportRequestSchema,
		clientUsageReportResponseSchema,
		clientUsageSummaryResponseSchema,
		credentialRefreshResponseSchema,
		credentialDisableRequestSchema,
		credentialDisableResponseSchema,
		disabledCredentialSummarySchema,
		disabledCredentialsResponseSchema,
		credentialBlockRequestSchema,
		credentialBlockResponseSchema,
		credentialBlocksDeleteResponseSchema,
		usageStaleResponseSchema,
		credentialUploadRequestSchema,
		credentialUploadResponseSchema,
	};
}

let cachedAuthBrokerWireSchemas: AuthBrokerWireSchemas | undefined;

export function getAuthBrokerWireSchemas(): AuthBrokerWireSchemas {
	if (!cachedAuthBrokerWireSchemas) cachedAuthBrokerWireSchemas = buildAuthBrokerWireSchemas();
	return cachedAuthBrokerWireSchemas;
}
