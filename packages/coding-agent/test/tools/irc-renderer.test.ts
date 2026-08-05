import { describe, expect, it } from "bun:test";
import type { IrcMessage } from "@wxyhgk/pi-coding-agent/irc/bus";
import { getThemeByName } from "@wxyhgk/pi-coding-agent/modes/theme/theme";
import { type CoordinationDetails, hubToolRenderer } from "@wxyhgk/pi-coding-agent/tools/hub";
import { sanitizeText } from "@wxyhgk/pi-utils";

async function theme() {
	const t = await getThemeByName("dark");
	expect(t).toBeDefined();
	return t!;
}

const lines = (component: { render: (w: number) => readonly string[] }, width = 200) =>
	sanitizeText(component.render(width).join("\n")).split("\n");

const msg = (overrides: Partial<IrcMessage>): IrcMessage => ({
	id: "7181122334455667789",
	from: "AuthLoader",
	to: "Main",
	body: "session-store rename is merged.",
	ts: Date.now() - 30_000,
	...overrides,
});

describe("hubToolRenderer send", () => {
	it("folds a single delivery outcome into the header and shows the awaited reply", async () => {
		const uiTheme = await theme();
		const rendered = lines(
			hubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: {
						op: "send",
						from: "Main",
						to: "AuthLoader",
						receipts: [{ to: "AuthLoader", outcome: "revived" }],
						waited: msg({ body: "go ahead, auth.ts is yours." }),
					} satisfies CoordinationDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "send", to: "AuthLoader", message: "Are you done with auth.ts?", await: true },
			),
		);
		expect(rendered[0]).toContain("AuthLoader");
		expect(rendered[0]).toContain("revived");
		expect(rendered.some(line => line.includes("Are you done with auth.ts?"))).toBe(true);
		expect(rendered.some(line => line.includes("go ahead, auth.ts is yours."))).toBe(true);
	});

	it("lists per-recipient outcomes with error text when a broadcast partially fails", async () => {
		const uiTheme = await theme();
		const rendered = lines(
			hubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: {
						op: "send",
						from: "Main",
						to: "all",
						receipts: [
							{ to: "AuthLoader", outcome: "woken" },
							{ to: "RateLimiter", outcome: "failed", error: 'unknown agent "RateLimiter"' },
						],
					} satisfies CoordinationDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "send", to: "all", message: "heads up" },
			),
		);
		expect(rendered[0]).toContain("广播");
		expect(rendered[0]).toContain("1 已投递");
		expect(rendered[0]).toContain("1 失败");
		expect(rendered.some(line => line.includes("AuthLoader") && line.includes("woken"))).toBe(true);
		expect(rendered.some(line => line.includes("RateLimiter") && line.includes('unknown agent "RateLimiter"'))).toBe(
			true,
		);
	});

	it("flags an awaited send whose reply timed out", async () => {
		const uiTheme = await theme();
		const rendered = lines(
			hubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: {
						op: "send",
						from: "Main",
						to: "AuthLoader",
						receipts: [{ to: "AuthLoader", outcome: "injected" }],
						waited: null,
					} satisfies CoordinationDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "send", to: "AuthLoader", message: "ping", await: true },
			),
		);
		expect(rendered[0]).toContain("无回复");
		expect(rendered.some(line => line.includes("尚无回复"))).toBe(true);
	});

	it("surfaces pre-delivery validation failures as an error detail", async () => {
		const uiTheme = await theme();
		const rendered = lines(
			hubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: '`to` is required for op="send".' }],
					details: { op: "send", from: "Main" } satisfies CoordinationDetails,
					isError: true,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "send" },
			),
		);
		expect(rendered.some(line => line.includes('`to` is required for op="send".'))).toBe(true);
	});
});

describe("hubToolRenderer wait", () => {
	it("renders the consumed message under a sender header", async () => {
		const uiTheme = await theme();
		const rendered = lines(
			hubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: { op: "wait", from: "Main", waited: msg({}) } satisfies CoordinationDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "wait", from: "AuthLoader" },
			),
		);
		expect(rendered[0]).toContain("AuthLoader");
		expect(rendered.some(line => line.includes("session-store rename is merged."))).toBe(true);
	});

	it("marks a timed-out wait without inventing a message", async () => {
		const uiTheme = await theme();
		const rendered = lines(
			hubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "No message from AuthLoader within 2m." }],
					details: { op: "wait", from: "Main", waited: null } satisfies CoordinationDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "wait", from: "AuthLoader" },
			),
		);
		expect(rendered[0]).toContain("已超时");
		expect(rendered.some(line => line.includes("No message from AuthLoader within 2m."))).toBe(true);
	});
});

describe("hubToolRenderer inbox", () => {
	it("lists each message with sender and body preview", async () => {
		const uiTheme = await theme();
		const rendered = lines(
			hubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: {
						op: "inbox",
						from: "Main",
						inbox: [
							msg({ from: "AuthLoader", body: "bus landed." }),
							msg({ from: "RateLimiter", body: "receipts carry outcome.", replyTo: "7181122334455667791" }),
						],
					} satisfies CoordinationDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "inbox", peek: true },
			),
		);
		expect(rendered[0]).toContain("2 条消息");
		expect(rendered[0]).toContain("预览");
		expect(rendered.some(line => line.includes("bus landed."))).toBe(true);
		expect(rendered.some(line => line.includes("RateLimiter"))).toBe(true);
		expect(rendered.some(line => line.includes("receipts carry outcome."))).toBe(true);
	});
});

describe("hubToolRenderer list", () => {
	it("summarizes status counts and flags unread peers", async () => {
		const uiTheme = await theme();
		const rendered = lines(
			hubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: {
						op: "list",
						from: "Main",
						peers: [
							{
								id: "RateLimiter",
								displayName: "task",
								kind: "sub",
								status: "parked",
								parentId: "Main",
								unread: 2,
								lastActivity: Date.now() - 12 * 60_000,
							},
							{
								id: "AuthLoader",
								displayName: "task",
								kind: "sub",
								status: "running",
								parentId: "Main",
								unread: 0,
								lastActivity: Date.now() - 2 * 60_000,
							},
						],
					} satisfies CoordinationDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "list" },
			),
		);
		expect(rendered[0]).toContain("1 运行中");
		expect(rendered[0]).toContain("1 已暂停");
		expect(rendered[0]).toContain("2 条未读");
		// Running peers sort above parked ones regardless of input order.
		const authIndex = rendered.findIndex(line => line.includes("AuthLoader"));
		const rateIndex = rendered.findIndex(line => line.includes("RateLimiter"));
		expect(authIndex).toBeGreaterThan(0);
		expect(authIndex).toBeLessThan(rateIndex);
		expect(rendered.some(line => line.includes("RateLimiter") && line.includes("2 条未读"))).toBe(true);
	});

	it("renders a peer's role displayName and current activity in the row", async () => {
		const uiTheme = await theme();
		const rendered = lines(
			hubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: {
						op: "list",
						from: "Main",
						peers: [
							{
								id: "AuthScout",
								displayName: "Auth-flow security reviewer",
								kind: "sub",
								status: "running",
								parentId: "Main",
								unread: 0,
								lastActivity: Date.now() - 5_000,
								activity: "auditing the token refresh path",
							},
						],
					} satisfies CoordinationDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "list" },
			),
		);
		const row = rendered.find(line => line.includes("AuthScout"));
		expect(row).toBeDefined();
		expect(row).toContain("Auth-flow security reviewer");
		expect(row).toContain("auditing the token refresh path");
	});
});

describe("hubToolRenderer body truncation", () => {
	it("collapses long bodies with an elision counter and expands on demand", async () => {
		const uiTheme = await theme();
		const body = Array.from({ length: 6 }, (_, i) => `reply line ${i + 1}`).join("\n");
		const details: CoordinationDetails = { op: "wait", from: "Main", waited: msg({ body }) };
		const result = { content: [{ type: "text", text: "" }], details };

		const collapsed = lines(
			hubToolRenderer.renderResult(result, { expanded: false, isPartial: false }, uiTheme, { op: "wait" }),
		);
		expect(collapsed.some(line => line.includes("reply line 2"))).toBe(true);
		expect(collapsed.some(line => line.includes("reply line 3"))).toBe(false);
		expect(collapsed.some(line => line.includes("… 还有 4 行"))).toBe(true);

		const expanded = lines(
			hubToolRenderer.renderResult(result, { expanded: true, isPartial: false }, uiTheme, { op: "wait" }),
		);
		expect(expanded.some(line => line.includes("reply line 6"))).toBe(true);
		expect(expanded.some(line => line.includes("还有 4 行"))).toBe(false);
	});
});
