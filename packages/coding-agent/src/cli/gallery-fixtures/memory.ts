// Gallery fixtures for the long-term memory tools (retain, recall, reflect).
import type { GalleryFixture } from "./types";

export const memoryFixtures: Record<string, GalleryFixture> = {
	retain: {
		label: "记忆存储",
		// Streaming: first item complete, second still arriving without a context.
		streamingArgs: {
			items: [{ content: "用户在这个仓库的所有新脚本中更喜欢 Bun 而不是 Node。" }],
		},
		args: {
			items: [
				{
					content: "用户在这个仓库的所有新脚本中更喜欢 Bun 而不是 Node。",
					context: "在搭建 gallery 命令工具时建立。",
				},
				{
					content: "TUI 渲染器位于 packages/coding-agent/src/tools/*-render.ts。",
					context: "在 gallery-fixtures 任务期间发现。",
				},
			],
		},
		result: {
			content: [{ type: "text", text: "已存储 2 条记忆。" }],
			details: { count: 2 },
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "记忆存储失败:记忆存储尚未初始化。" }],
		},
	},

	recall: {
		label: "记忆检索",
		// Streaming: query partially typed.
		streamingArgs: { query: "bun vs node" },
		args: { query: "用户更喜欢用哪个运行时来运行脚本?" },
		result: {
			content: [
				{
					type: "text",
					text: [
						"找到 2 条相关记忆:",
						"",
						"1. [0.92] 用户在这个仓库的所有新脚本中更喜欢 Bun 而不是 Node。",
						"   (在搭建 gallery 命令工具时建立。)",
						"2. [0.78] TUI 渲染器位于 packages/coding-agent/src/tools/*-render.ts。",
						"   (在 gallery-fixtures 任务期间发现。)",
					].join("\n"),
				},
			],
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "记忆检索失败:向量索引不可用。" }],
		},
	},

	reflect: {
		label: "记忆总结",
		streamingArgs: { query: "what have we learned about the user's" },
		args: { query: "关于用户的工具偏好,我们了解了哪些?" },
		result: {
			content: [
				{
					type: "text",
					text: [
						"用户在本仓库的脚本中始终倾向于使用 Bun 作为运行时,",
						"在可能的情况下避免使用 Node。他们还关注",
						"packages/coding-agent/src/tools 下的 TUI 渲染器位置,这表明",
						"他们希望渲染逻辑保持易于查找且组织良好。",
					].join("\n"),
				},
			],
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "记忆总结失败:没有与查询匹配的记忆。" }],
		},
	},
};
