import { type } from "@wxyhgk/omptype";
import type { DiffHunk, FileHunks } from "../../../commit/types";
import type { CustomTool } from "../../../extensibility/custom-tools/types";
import * as git from "../../../utils/git";

const hunkIndexType = type("number").describe("从 1 开始的差异块索引");

const gitHunkSchema = type({
	file: type("string").describe("文件路径"),
	"hunks?": hunkIndexType.array().atLeastLength(1),
	"staged?": type("boolean").describe("使用暂存的更改(默认 true)"),
});

function selectHunks(fileHunks: FileHunks, requested?: number[]): DiffHunk[] {
	if (!requested || requested.length === 0) return fileHunks.hunks;
	const wanted = new Set(requested.map(value => Math.max(1, Math.floor(value))));
	return fileHunks.hunks.filter(hunk => wanted.has(hunk.index + 1));
}

export function createGitHunkTool(cwd: string): CustomTool<typeof gitHunkSchema> {
	return {
		name: "git_hunk",
		label: "Git 差异块",
		description: "从文件差异中返回指定的差异块。",
		parameters: gitHunkSchema,
		async execute(_toolCallId, params) {
			const staged = params.staged ?? true;
			const hunks = await git.diff.hunks(cwd, [params.file], { cached: staged });
			const fileHunks = hunks.find(entry => entry.filename === params.file) ?? {
				filename: params.file,
				isBinary: false,
				hunks: [],
			};
			if (fileHunks.isBinary) {
				return {
					content: [{ type: "text", text: "Binary file diff; no hunks available." }],
					details: { file: params.file, staged, hunks: [] },
				};
			}
			const selected = selectHunks(fileHunks, params.hunks);
			const text = selected.length ? selected.map(hunk => hunk.content).join("\n\n") : "(no matching hunks)";
			return {
				content: [{ type: "text", text }],
				details: {
					file: params.file,
					staged,
					hunks: selected,
				},
			};
		},
	};
}
