import type { CommandMetadata } from "@oh-my-pi/pi-utils/cli";

export const acpHelp = {
	description: "通过 stdio 以 ACP(Agent Client Protocol)服务器模式运行 Oh My Pi",
} satisfies CommandMetadata;

export const agentsHelp = { description: "管理内置的 task Agent" } satisfies CommandMetadata;

export const authBrokerHelp = {
	description: "管理 omp-zh auth-broker(凭据保险库)",
} satisfies CommandMetadata;

export const authGatewayHelp = {
	description: "运行由已配置 broker 支撑的 auth-gateway 正向代理",
} satisfies CommandMetadata;

export const benchHelp = {
	description: "使用相同提示词对模型进行基准测试:首 token 耗时与生成吞吐量(token/s)",
} satisfies CommandMetadata;

export const browserRelayHelp = {
	description: "运行本地 CDP relay,让浏览器工具可以操控你自己的 Chrome 标签页",
} satisfies CommandMetadata;

export const cleanseHelp = {
	description: "使用加权并行子 Agent 检测并修复项目诊断",
} satisfies CommandMetadata;

export const commitHelp = { description: "生成提交信息并更新变更日志" } satisfies CommandMetadata;

export const completionsHelp = {
	description: "输出 shell 补全脚本(bash、zsh 或 fish)",
} satisfies CommandMetadata;

export const completeHelp = { hidden: true } satisfies CommandMetadata;

export const configHelp = { description: "管理配置设置" } satisfies CommandMetadata;

export const dryBalanceHelp = {
	description: "使用随机会话 ID 演练 OAuth 账户均衡",
} satisfies CommandMetadata;

export const galleryHelp = {
	description: "预览工具渲染器在流式、进行中、成功和失败状态下的效果",
} satisfies CommandMetadata;

export const gcHelp = { description: "运行存储垃圾回收" } satisfies CommandMetadata;

export const grepHelp = { description: "测试 grep 工具" } satisfies CommandMetadata;

export const grievancesHelp = {
	description: "查看、清理或上报工具问题(自动 QA 反馈)",
} satisfies CommandMetadata;

export const installHelp = {
	description: "安装或链接扩展包(`plugin install`/`plugin link` 的别名)",
} satisfies CommandMetadata;

export const joinHelp = { description: "加入共享协作会话(与 /join 相同)" } satisfies CommandMetadata;

export const modelsHelp = { description: "列出、搜索并刷新可用模型" } satisfies CommandMetadata;

export const pluginHelp = { description: "管理插件(安装、卸载、列出等)" } satisfies CommandMetadata;

export const readHelp = {
	description: "显示 read 工具对路径、URL 或内部 URI 的返回结果",
} satisfies CommandMetadata;

export const sayHelp = {
	description: "使用本地 TTS 引擎合成文本并通过扬声器播放",
} satisfies CommandMetadata;

export const searchHelp = { description: "测试网络搜索提供商" } satisfies CommandMetadata;

export const setupHelp = {
	description: "运行引导设置或安装可选功能的依赖",
} satisfies CommandMetadata;

export const shellHelp = { description: "交互式 shell 控制台" } satisfies CommandMetadata;

export const sshHelp = { description: "管理 SSH 主机配置" } satisfies CommandMetadata;

export const statsHelp = { description: "查看用量统计" } satisfies CommandMetadata;

export const tinyModelsHelp = {
	description: "下载微型本地模型(会话标题 + 记忆)",
} satisfies CommandMetadata;

export const tokenHelp = { description: "获取提供商对应的 API 密钥或 OAuth token" } satisfies CommandMetadata;

export const ttsrHelp = {
	description: "检查和测试 Time-Traveling Stream Rules(TTSR)",
} satisfies CommandMetadata;

export const updateHelp = { description: "检查并安装更新" } satisfies CommandMetadata;

export const usageHelp = {
	description: "显示每个已认证账户的提供商用量限制",
} satisfies CommandMetadata;

export const worktreeHelp = {
	description: "列出或清理 Agent 管理的 git 工作树(~/.omp/wt)",
} satisfies CommandMetadata;
