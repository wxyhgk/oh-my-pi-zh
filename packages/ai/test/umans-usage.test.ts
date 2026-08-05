import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { umansUsageProvider } from "../src/usage/umans";

const DEFAULT_BASE_URL = "https://api.code.umans.ai";

function umansPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		plan: { display_name: "Code Max" },
		limits: {
			requests: { limit: 200, hard_cap: 400, burst_pct: 1.0, window_seconds: 18000 },
			concurrency: { limit: 4, hard_cap: 8, burst_pct: 1.0 },
		},
		usage: {
			requests_in_window: 48,
			remaining_requests: 152,
			concurrent_sessions: 1,
			tokens_in: 1_200_000,
			tokens_out: 340_000,
			priority: { low: false, boxed_until: null, reason: null },
		},
		...overrides,
	};
}

function fakeFetch(payload: unknown, status = 200): FetchImpl {
	const fn = async () =>
		new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		});
	return fn as unknown as typeof fetch;
}

function fetchRecorder(
	calls: Array<{ url: string; headers: Record<string, string> }>,
	payload: unknown,
	status = 200,
): FetchImpl {
	const fn = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({
			url: String(input),
			headers: (init?.headers as Record<string, string>) ?? {},
		});
		return new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		});
	};
	return fn as unknown as typeof fetch;
}

describe("umans usage provider", () => {
	it("parses the rolling 5h request window into a UsageLimit with used/remaining/fraction", async () => {
		const report = await umansUsageProvider.fetchUsage(
			{
				provider: "umans",
				credential: { type: "api_key", apiKey: "sk-test", accountId: "acct-1", email: "u@example.com" },
			},
			{ fetch: fakeFetch(umansPayload()) },
		);
		expect(report).not.toBeNull();
		const requests = report?.limits.find(l => l.id === "umans:requests");
		expect(requests).toBeDefined();
		expect(requests?.amount.used).toBe(48);
		expect(requests?.amount.limit).toBe(200);
		expect(requests?.amount.remaining).toBe(152);
		expect(requests?.amount.usedFraction).toBeCloseTo(0.24, 5);
		expect(requests?.amount.remainingFraction).toBeCloseTo(0.76, 5);
		expect(requests?.amount.unit).toBe("requests");
		// Rolling window: no fabricated reset timestamp.
		expect(requests?.window?.resetsAt).toBeUndefined();
		expect(requests?.window?.durationMs).toBe(18000_000);
		expect(requests?.window?.label).toBe("rolling 5h");
	});

	it("emits a concurrency limit from limits.concurrency", async () => {
		const report = await umansUsageProvider.fetchUsage(
			{
				provider: "umans",
				credential: { type: "api_key", apiKey: "sk-test" },
			},
			{ fetch: fakeFetch(umansPayload()) },
		);
		const concurrency = report?.limits.find(l => l.id === "umans:concurrency");
		expect(concurrency).toBeDefined();
		expect(concurrency?.amount.used).toBe(1);
		expect(concurrency?.amount.limit).toBe(4);
		expect(concurrency?.amount.unit).toBe("requests");
	});

	it("sends Authorization: Bearer <key> to the default base URL", async () => {
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		await umansUsageProvider.fetchUsage(
			{
				provider: "umans",
				credential: { type: "api_key", apiKey: "sk-test" },
			},
			{ fetch: fetchRecorder(calls, umansPayload()) },
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${DEFAULT_BASE_URL}/v1/usage`);
		expect(calls[0]?.headers.authorization).toBe("Bearer sk-test");
	});

	it("honors a custom baseUrl from params", async () => {
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		await umansUsageProvider.fetchUsage(
			{
				provider: "umans",
				credential: { type: "api_key", apiKey: "sk-test" },
				baseUrl: "https://custom.umans.example",
			},
			{ fetch: fetchRecorder(calls, umansPayload()) },
		);
		expect(calls[0]?.url).toBe("https://custom.umans.example/v1/usage");
	});

	it("strips a trailing /v1 from a custom baseUrl", async () => {
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		await umansUsageProvider.fetchUsage(
			{
				provider: "umans",
				credential: { type: "api_key", apiKey: "sk-test" },
				baseUrl: "https://api.code.umans.ai/v1",
			},
			{ fetch: fetchRecorder(calls, umansPayload()) },
		);
		expect(calls[0]?.url).toBe("https://api.code.umans.ai/v1/usage");
	});

	it("preserves a path-mounted gateway prefix while stripping /v1", async () => {
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		await umansUsageProvider.fetchUsage(
			{
				provider: "umans",
				credential: { type: "api_key", apiKey: "sk-test" },
				baseUrl: "https://gateway.example/team/umans/v1",
			},
			{ fetch: fetchRecorder(calls, umansPayload()) },
		);
		expect(calls[0]?.url).toBe("https://gateway.example/team/umans/v1/usage");
	});

	it("surfaces priority.low as a provider note", async () => {
		const payload = umansPayload({
			usage: {
				requests_in_window: 250,
				remaining_requests: 0,
				concurrent_sessions: 1,
				tokens_in: 0,
				tokens_out: 0,
				priority: { low: true, boxed_until: "2026-06-27T12:00:00Z", reason: "burst" },
			},
		});
		const report = await umansUsageProvider.fetchUsage(
			{
				provider: "umans",
				credential: { type: "api_key", apiKey: "sk-test" },
			},
			{ fetch: fakeFetch(payload) },
		);
		expect(report?.notes).toContain("Requests deprioritized after a rate-limit burst.");
	});

	it("throws on a 401 auth failure so checkCredentials flags the bad key", async () => {
		await expect(
			umansUsageProvider.fetchUsage(
				{
					provider: "umans",
					credential: { type: "api_key", apiKey: "sk-test" },
				},
				{ fetch: fakeFetch({ message: "unauthorized" }, 401) },
			),
		).rejects.toThrow(/401/);
	});

	it("throws on a 403 auth failure so checkCredentials flags the bad key", async () => {
		await expect(
			umansUsageProvider.fetchUsage(
				{
					provider: "umans",
					credential: { type: "api_key", apiKey: "sk-test" },
				},
				{ fetch: fakeFetch({ message: "forbidden" }, 403) },
			),
		).rejects.toThrow(/403/);
	});

	it("returns null on a transient non-auth HTTP failure (500)", async () => {
		const report = await umansUsageProvider.fetchUsage(
			{
				provider: "umans",
				credential: { type: "api_key", apiKey: "sk-test" },
			},
			{ fetch: fakeFetch({ message: "internal server error" }, 500) },
		);
		expect(report).toBeNull();
	});

	it("returns null when supports() is called for a different provider or credential type", () => {
		expect(umansUsageProvider.supports?.({ provider: "zai", credential: { type: "api_key", apiKey: "x" } })).toBe(
			false,
		);
		expect(
			umansUsageProvider.supports?.({ provider: "umans", credential: { type: "oauth", accessToken: "x" } }),
		).toBe(false);
		expect(umansUsageProvider.supports?.({ provider: "umans", credential: { type: "api_key", apiKey: "x" } })).toBe(
			true,
		);
	});

	it("includes plan display name and account identity in metadata", async () => {
		const report = await umansUsageProvider.fetchUsage(
			{
				provider: "umans",
				credential: { type: "api_key", apiKey: "sk-test", accountId: "acct-42", email: "dev@example.com" },
			},
			{ fetch: fakeFetch(umansPayload({ plan: { display_name: "Code Pro" } })) },
		);
		expect(report?.metadata?.plan).toBe("Code Pro");
		expect(report?.metadata?.accountId).toBe("acct-42");
		expect(report?.metadata?.email).toBe("dev@example.com");
	});
});
