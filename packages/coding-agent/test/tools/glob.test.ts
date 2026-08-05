import { describe, expect, test } from "bun:test";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { GlobTool } from "../../src/tools/glob";
import { ToolError } from "../../src/tools/tool-errors";

const ROOT_SEARCH_ERROR = "不允许从根目录 '/' 搜索";

async function expectRootSearchRejected(searchPath: string): Promise<void> {
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	const tool = new GlobTool(session);
	let thrown: unknown;
	try {
		await tool.execute("glob-root-regression", { path: searchPath });
	} catch (error) {
		thrown = error;
	}

	if (!(thrown instanceof Error)) {
		throw new Error(`Expected glob path ${JSON.stringify(searchPath)} to reject`);
	}

	expect(thrown).toBeInstanceOf(ToolError);
	expect(thrown.message).toBe(ROOT_SEARCH_ERROR);
}

describe("GlobTool.execute", () => {
	test.each(["/", "//"])("rejects bare root search path %s", async searchPath => {
		await expectRootSearchRejected(searchPath);
	});
});
