/**
 * SuperGrok (`xai-oauth`) subscription usage provider.
 *
 * Reads utilization from the Grok CLI billing endpoint. Prefer the legacy
 * weekly `format=credits` payload (creditUsagePercent / productUsage). When
 * xAI marks the account as unified billing and omits those fields, fall back
 * to the default monthly included-quota shape (`monthlyLimit` / `used`).
 * Only OAuth access credentials are accepted; paid API keys are a separate
 * product and must never be sent here.
 */

import {
	buildXAICliBillingUrl,
	extractXAIAccessTokenSubject,
	fetchXAIOAuthIdentity,
	getXAICliBillingHeaders,
} from "../registry/oauth/xai-oauth";
import type {
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";
import { isRecord } from "../utils";
import { toNumber } from "./shared";

const PROVIDER_ID = "xai-oauth";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BILLING_SOURCE = "cli-chat-proxy.grok.com/v1/billing";

interface XaiBillingPeriod {
	start: string;
	end: string;
	type: string;
}

interface XaiProductUsage {
	product: string;
	usagePercent: number;
}

/** Legacy SuperGrok weekly credits (`?format=credits`). */
interface XaiWeeklyBillingConfig {
	kind: "weekly";
	currentPeriod: XaiBillingPeriod;
	creditUsagePercent: number;
	productUsage: XaiProductUsage[];
	onDemandCap?: number;
	onDemandUsed?: number;
}

/**
 * Unified-billing monthly included quota.
 * Live `isUnifiedBillingUser` accounts omit creditUsagePercent on
 * `?format=credits` and expose monthlyLimit/used on the default billing URL.
 */
interface XaiMonthlyBillingConfig {
	kind: "monthly";
	periodStart: string;
	periodEnd: string;
	used: number;
	limit: number;
	onDemandCap?: number;
	onDemandUsed?: number;
}

type XaiBillingConfig = XaiWeeklyBillingConfig | XaiMonthlyBillingConfig;

function parseIsoMs(value: string): number | undefined {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parsePercent(value: unknown): number | undefined {
	const percent = toNumber(value);
	return percent !== undefined && percent >= 0 && percent <= 100 ? percent : undefined;
}

function parseOnDemandAmount(value: unknown): number | undefined {
	if (!isRecord(value)) return undefined;
	const amount = toNumber(value.val);
	return amount !== undefined && amount >= 0 ? amount : undefined;
}

function buildPercentAmount(usagePercent: number): UsageAmount {
	const usedFraction = usagePercent / 100;
	return {
		used: usagePercent,
		limit: 100,
		remaining: 100 - usagePercent,
		usedFraction,
		remainingFraction: 1 - usedFraction,
		unit: "percent",
	};
}

function buildUsageStatus(usedFraction: number): UsageStatus {
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

function slugifyProduct(product: string): string {
	return product
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function buildPeriodWindow(period: XaiBillingPeriod): UsageWindow {
	return {
		id: "1w",
		label: "Weekly",
		durationMs: WEEK_MS,
		resetsAt: parseIsoMs(period.end),
	};
}

function buildMonthlyWindow(periodStart: string, periodEnd: string): UsageWindow | undefined {
	const startMs = parseIsoMs(periodStart);
	const endMs = parseIsoMs(periodEnd);
	if (startMs === undefined || endMs === undefined || endMs <= startMs) return undefined;
	// Real calendar months vary; use the observed period length from the API.
	const durationMs = endMs - startMs;
	const approxDays = Math.max(1, Math.round(durationMs / DAY_MS));
	return {
		id: "1mo",
		label: approxDays === 30 || approxDays === 31 ? "Monthly" : `${approxDays}d`,
		durationMs,
		resetsAt: endMs,
	};
}

function parseWeeklyBillingConfig(raw: Record<string, unknown>): XaiWeeklyBillingConfig | null {
	if (!isRecord(raw.currentPeriod)) return null;

	const start = typeof raw.currentPeriod.start === "string" ? parseIsoMs(raw.currentPeriod.start) : undefined;
	const end = typeof raw.currentPeriod.end === "string" ? parseIsoMs(raw.currentPeriod.end) : undefined;
	const type = typeof raw.currentPeriod.type === "string" ? raw.currentPeriod.type : "";
	// Keep recently-ended weekly windows so /usage still renders across period
	// rollover while the billing API is mid-refresh. Reject only inverted ranges
	// and non-weekly period types.
	if (start === undefined || end === undefined || end <= start || !type.toUpperCase().includes("WEEK")) {
		return null;
	}

	const creditUsagePercent = parsePercent(raw.creditUsagePercent);
	if (creditUsagePercent === undefined) return null;

	const productUsage: XaiProductUsage[] = [];
	if (raw.productUsage !== undefined) {
		if (!Array.isArray(raw.productUsage)) return null;
		for (const item of raw.productUsage) {
			if (!isRecord(item)) continue;
			const product = typeof item.product === "string" ? item.product.trim() : "";
			const usagePercent = parsePercent(item.usagePercent);
			if (!product || usagePercent === undefined) continue;
			productUsage.push({ product, usagePercent });
		}
	}

	return {
		kind: "weekly",
		currentPeriod: {
			start: raw.currentPeriod.start as string,
			end: raw.currentPeriod.end as string,
			type,
		},
		creditUsagePercent,
		productUsage,
		onDemandCap: parseOnDemandAmount(raw.onDemandCap),
		onDemandUsed: parseOnDemandAmount(raw.onDemandUsed),
	};
}

function parseMonthlyBillingConfig(raw: Record<string, unknown>): XaiMonthlyBillingConfig | null {
	const periodStart = typeof raw.billingPeriodStart === "string" ? raw.billingPeriodStart : "";
	const periodEnd = typeof raw.billingPeriodEnd === "string" ? raw.billingPeriodEnd : "";
	const startMs = parseIsoMs(periodStart);
	const endMs = parseIsoMs(periodEnd);
	if (!periodStart || !periodEnd || startMs === undefined || endMs === undefined || endMs <= startMs) {
		return null;
	}

	const limit = parseOnDemandAmount(raw.monthlyLimit);
	const used = parseOnDemandAmount(raw.used);
	// Require a positive included quota; zero/missing is not a usable report.
	if (limit === undefined || limit <= 0 || used === undefined) return null;

	return {
		kind: "monthly",
		periodStart,
		periodEnd,
		used,
		limit,
		onDemandCap: parseOnDemandAmount(raw.onDemandCap),
		onDemandUsed: parseOnDemandAmount(raw.onDemandUsed),
	};
}

function buildOnDemandLimit(
	onDemandCap: number | undefined,
	onDemandUsed: number | undefined,
	accountId: string | undefined,
): UsageLimit | undefined {
	if (onDemandCap === undefined || onDemandCap <= 0 || onDemandUsed === undefined) return undefined;
	const usedFraction = Math.min(onDemandUsed / onDemandCap, 1);
	return {
		id: `${PROVIDER_ID}:on-demand`,
		label: "On-demand",
		scope: {
			provider: PROVIDER_ID,
			...(accountId ? { accountId } : {}),
			shared: true,
		},
		amount: {
			used: onDemandUsed,
			limit: onDemandCap,
			remaining: Math.max(0, onDemandCap - onDemandUsed),
			usedFraction,
			remainingFraction: 1 - usedFraction,
			unit: "unknown",
		},
		status: buildUsageStatus(usedFraction),
	};
}

function buildLimits(config: XaiBillingConfig, accountId: string | undefined): UsageLimit[] {
	if (config.kind === "weekly") {
		const window = buildPeriodWindow(config.currentPeriod);
		const scope = {
			provider: PROVIDER_ID,
			...(accountId ? { accountId } : {}),
			windowId: window.id,
			shared: true as const,
		};
		const overall = buildPercentAmount(config.creditUsagePercent);
		const limits: UsageLimit[] = [
			{
				id: `${PROVIDER_ID}:credits:1w`,
				label: "SuperGrok Weekly Credits",
				scope,
				window,
				amount: overall,
				status: buildUsageStatus(overall.usedFraction ?? 0),
			},
		];

		for (const item of config.productUsage) {
			const amount = buildPercentAmount(item.usagePercent);
			const slug = slugifyProduct(item.product);
			if (!slug) continue;
			limits.push({
				id: `${PROVIDER_ID}:product:${slug}:1w`,
				label: `${item.product === "GrokBuild" ? "Grok Build" : item.product === "Api" ? "API" : item.product} (Weekly)`,
				scope,
				window,
				amount,
				status: buildUsageStatus(amount.usedFraction ?? 0),
			});
		}
		const onDemand = buildOnDemandLimit(config.onDemandCap, config.onDemandUsed, accountId);
		if (onDemand) limits.push(onDemand);
		return limits;
	}

	const window = buildMonthlyWindow(config.periodStart, config.periodEnd);
	if (!window) return [];
	const usedFraction = Math.min(config.used / config.limit, 1);
	const limits: UsageLimit[] = [
		{
			id: `${PROVIDER_ID}:included:1mo`,
			label: "SuperGrok Monthly Included",
			scope: {
				provider: PROVIDER_ID,
				...(accountId ? { accountId } : {}),
				windowId: window.id,
				shared: true,
			},
			window,
			amount: {
				used: config.used,
				limit: config.limit,
				remaining: Math.max(0, config.limit - config.used),
				usedFraction,
				remainingFraction: 1 - usedFraction,
				// xAI does not label the unit; amounts match the dashboard quota points.
				unit: "unknown",
			},
			status: buildUsageStatus(usedFraction),
		},
	];
	const onDemand = buildOnDemandLimit(config.onDemandCap, config.onDemandUsed, accountId);
	if (onDemand) limits.push(onDemand);
	return limits;
}

async function fetchBillingPayload(
	url: string,
	accessToken: string,
	ctx: UsageFetchContext,
	signal: AbortSignal | undefined,
): Promise<unknown | null> {
	try {
		const response = await ctx.fetch(url, {
			headers: getXAICliBillingHeaders({ accessToken }),
			redirect: "error",
			signal,
		});
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	}
}

export const xaiOauthUsageProvider: UsageProvider = {
	id: PROVIDER_ID,

	supports(params: UsageFetchParams): boolean {
		return params.provider === PROVIDER_ID && params.credential.type === "oauth" && !!params.credential.accessToken;
	},

	async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
		if (params.provider !== PROVIDER_ID || params.credential.type !== "oauth") return null;
		const accessToken = params.credential.accessToken?.trim();
		if (!accessToken) return null;
		if (params.credential.expiresAt !== undefined && params.credential.expiresAt <= Date.now()) return null;

		let accountId = params.credential.accountId?.trim() || extractXAIAccessTokenSubject(accessToken);
		let email = params.credential.email?.trim().toLowerCase();
		if (!email) {
			try {
				const identity = await fetchXAIOAuthIdentity(accessToken, ctx.fetch, params.signal);
				email = identity?.email?.trim().toLowerCase() || undefined;
				accountId ??= identity?.accountId?.trim() || undefined;
			} catch {
				// Identity enrichment is best effort; billing remains authoritative.
			}
		}

		// Always probe weekly credits first (legacy SuperGrok shape).
		const creditsUrl = buildXAICliBillingUrl();
		const monthlyUrl = buildXAICliBillingUrl("");
		const creditsPayload = await fetchBillingPayload(creditsUrl, accessToken, ctx, params.signal);
		const weekly =
			creditsPayload && isRecord(creditsPayload) && isRecord(creditsPayload.config)
				? parseWeeklyBillingConfig(creditsPayload.config)
				: null;
		const creditsLooksUnified =
			!!creditsPayload &&
			isRecord(creditsPayload) &&
			isRecord(creditsPayload.config) &&
			creditsPayload.config.isUnifiedBillingUser === true;

		// Unified accounts expose a separate monthly included-quota payload on the
		// default billing URL. Fetch it when credits is missing/unusable, or when
		// credits itself marks the account unified (even if weekly percents exist —
		// live responses sometimes include both shapes).
		let monthlyPayload: unknown | null = null;
		let monthly: XaiMonthlyBillingConfig | null = null;
		const shouldProbeMonthly = (!weekly || creditsLooksUnified) && monthlyUrl !== creditsUrl;
		if (shouldProbeMonthly) {
			monthlyPayload = await fetchBillingPayload(monthlyUrl, accessToken, ctx, params.signal);
			monthly =
				monthlyPayload && isRecord(monthlyPayload) && isRecord(monthlyPayload.config)
					? parseMonthlyBillingConfig(monthlyPayload.config)
					: null;
		}

		if (!weekly && !monthly) return null;

		const limits: UsageLimit[] = [];
		if (weekly) limits.push(...buildLimits(weekly, accountId));
		if (monthly) limits.push(...buildLimits(monthly, accountId));
		// Deduplicate on-demand if both shapes carried the same cap (keep first).
		const seen = new Set<string>();
		const deduped = limits.filter(limit => {
			if (seen.has(limit.id)) return false;
			seen.add(limit.id);
			return true;
		});
		if (deduped.length === 0) return null;

		const billingKind = weekly && monthly ? "unified" : weekly ? "weekly" : "monthly";
		const endpoint = weekly && monthly ? `${creditsUrl} + ${monthlyUrl}` : weekly ? creditsUrl : monthlyUrl;
		const raw =
			weekly && monthly
				? { credits: creditsPayload, monthly: monthlyPayload }
				: weekly
					? creditsPayload
					: monthlyPayload;

		return {
			provider: PROVIDER_ID,
			fetchedAt: Date.now(),
			limits: deduped,
			metadata: {
				endpoint,
				source: BILLING_SOURCE,
				billingKind,
				...(accountId ? { accountId } : {}),
				...(email ? { email } : {}),
			},
			raw,
		};
	},
};
