import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolView } from "../src/tool-render/ToolView";

describe("ToolView xd:// dispatches", () => {
	it("renders successful execute-mode xdev writes as the inner generate_image tool", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				result={{
					content: [],
					details: {
						xdev: {
							tool: "generate_image",
							mode: "execute",
							args: { subject: "alpine lake" },
							inner: {
								images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
							},
						},
					},
				}}
			/>,
		);

		expect(html).toContain("xd://generate_image");
		expect(html).toContain("alpine lake");
		expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
	});

	it("renders xd://resolve apply cards from unwrapped inner details", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				result={{
					content: [{ type: "text", text: "Applied 1 replacement in 1 file." }],
					details: {
						xdev: {
							tool: "resolve",
							mode: "execute",
							args: { reason: "looks correct" },
							inner: {
								action: "apply",
								reason: "looks correct",
								sourceToolName: "ast_edit",
								label: "ast_edit: edit foo.ts",
							},
						},
					},
				}}
			/>,
		);

		expect(html).toContain("xd://resolve");
		expect(html).toContain("proposed → resolved");
		expect(html).toContain("tv-badge--ok");
		expect(html).toContain("ast_edit: edit foo.ts");
		// The historical args-only path once left the badge as a warn "?".
		expect(html).not.toContain('tv-badge--warn">?');
	});

	it("renders xd://reject discard cards with reject semantics", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				result={{
					content: [{ type: "text", text: "Discarded pending action." }],
					details: {
						xdev: {
							tool: "reject",
							mode: "execute",
							args: { reason: "not right" },
							inner: { action: "discard", reason: "not right", sourceToolName: "edit" },
						},
					},
				}}
			/>,
		);

		expect(html).toContain("xd://reject");
		expect(html).toContain("proposed → rejected");
		expect(html).toContain("tv-badge--warn");
		// Not the generic JSON dump.
		expect(html).not.toContain("tv-out-title");
	});

	it("defaults a running xd://reject to discard before details arrive", () => {
		const html = renderToStaticMarkup(
			<ToolView name="reject" defaultOpen running args={{ reason: "" }} />,
		);

		expect(html).toContain("proposed → rejected");
	});

	it("renders xd://propose plan metadata from unwrapped inner details", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				result={{
					content: [{ type: "text", text: "Plan ready for review." }],
					details: {
						xdev: {
							tool: "propose",
							mode: "execute",
							args: { title: "ship it" },
							inner: { planFilePath: "local://ship-it-plan.md", title: "ship it", planExists: true },
						},
					},
				}}
			/>,
		);

		expect(html).toContain("xd://propose");
		expect(html).toContain("plan proposed");
		expect(html).toContain("local://ship-it-plan.md");
	});

	it("keeps historical top-level resolve cards working from args.action", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="resolve"
				defaultOpen
				args={{ action: "apply", reason: "ok" }}
				result={{ content: [], details: { sourceToolName: "ast_edit", label: "edit foo.ts" } }}
			/>,
		);

		expect(html).toContain("proposed → resolved");
		expect(html).toContain("tv-badge--ok");
	});

	it("routes the hub-family alias irc through the messaging renderer", () => {
		const html = renderToStaticMarkup(
			<ToolView name="irc" defaultOpen args={{ op: "send", to: "Main", message: "hi" }} result={{ content: [] }} />,
		);

		expect(html).toContain("→ Main");
		// Not the generic JSON dump of the args.
		expect(html).not.toContain("tv-out-title");
	});

	it("routes the hub-family alias job through the job renderer", () => {
		const html = renderToStaticMarkup(
			<ToolView name="job" defaultOpen args={{ poll: ["a1b2"] }} result={{ content: [] }} />,
		);

		expect(html).toContain("poll a1b2");
		expect(html).not.toContain("tv-out-title");
	});
});
