/** Gallery fixtures for the todo / ask / resolve interaction tools. */
import type { GalleryFixture } from "./types";

export const interactionFixtures: Record<string, GalleryFixture> = {
	todo: {
		label: "待办",
		streamingArgs: {
			op: "init",
			list: [{ phase: "基础", items: ["创建 crate 脚手架"] }],
		},
		args: {
			op: "init",
			list: [
				{ phase: "基础", items: ["创建 crate 脚手架", "配置工作区"] },
				{ phase: "认证", items: ["迁移凭据存储", "接入 OAuth 提供商"] },
			],
		},
		result: {
			content: [{ type: "text", text: "已在 2 个阶段中初始化 4 个任务" }],
			details: {
				storage: "session",
				phases: [
					{
						name: "基础",
						tasks: [
							{ content: "创建 crate 脚手架", status: "done" },
							{ content: "配置工作区", status: "in_progress" },
						],
					},
					{
						name: "认证",
						tasks: [
							{ content: "迁移凭据存储", status: "pending" },
							{ content: "接入 OAuth 提供商", status: "pending" },
						],
					},
				],
				completedTasks: [{ phase: "基础", content: "创建 crate 脚手架" }],
			},
		},
		errorResult: {
			content: [{ type: "text", text: "未知阶段 '认证'——请先初始化列表" }],
			isError: true,
		},
	},
};
