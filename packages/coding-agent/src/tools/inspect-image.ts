import { type } from "@wxyhgk/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@wxyhgk/pi-agent-core";
import { instrumentedCompleteSimple, resolveTelemetry } from "@wxyhgk/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	completeSimple,
	type ImageContent,
	type Model,
	type ToolExample,
} from "@wxyhgk/pi-ai";
import { prompt } from "@wxyhgk/pi-utils";
import { extractTextContent } from "../commit/utils";

import {
	expandRoleAlias,
	extractExplicitThinkingSelector,
	getModelMatchPreferences,
	resolveModelFromString,
} from "../config/model-resolver";
import inspectImageDescription from "../prompts/tools/inspect-image.md" with { type: "text" };
import inspectImageSystemPromptTemplate from "../prompts/tools/inspect-image-system.md" with { type: "text" };
import { concreteThinkingLevel, resolveThinkingLevelForModel, toReasoningEffort } from "../thinking";
import {
	ImageInputTooLargeError,
	type LoadedImageInput,
	loadImageAttachmentInput,
	loadImageInput,
	MAX_IMAGE_INPUT_BYTES,
	webpExclusionForModel,
} from "../utils/image-loading";
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

const inspectImageSchema = type({
	path: type("string").describe("图片文件路径、Image #N 标签或 attachment://N URI"),
	question: type("string").describe("关于图片的问题"),
	"+": "reject",
});

export type InspectImageParams = typeof inspectImageSchema.infer;

interface ImageAttachmentReference {
	index: number;
}

const IMAGE_ATTACHMENT_REFERENCE_REGEX =
	/^\s*(?:\[?Image #([1-9]\d*)(?:,[^\]\n]*)?\]?|(?:attachment|image):\/\/([1-9]\d*))\s*$/i;

function parseImageAttachmentReference(path: string): ImageAttachmentReference | null {
	const match = IMAGE_ATTACHMENT_REFERENCE_REGEX.exec(path);
	if (!match) return null;
	const rawIndex = match[1] ?? match[2];
	if (!rawIndex) return null;
	return { index: Number(rawIndex) };
}

function formatAvailableImageAttachments(attachments: readonly { label: string; uri: string }[]): string {
	if (attachments.length === 0) return "none";
	return attachments.map(attachment => `${attachment.label} -> ${attachment.uri}`).join(", ");
}

async function loadAttachmentReferenceInput(options: {
	path: string;
	reference: ImageAttachmentReference;
	attachments: readonly { label: string; uri: string; image: ImageContent }[];
	autoResize: boolean;
	excludeWebP: boolean | undefined;
}): Promise<LoadedImageInput | null> {
	const attachment = options.attachments[options.reference.index - 1];
	if (!attachment) {
		const available = formatAvailableImageAttachments(options.attachments);
		if (options.attachments.length === 0) {
			throw new ToolError(
				`当前轮次没有可用的图片附件。path="${options.path}" 必须是可读的文件路径或附件 URI。`,
			);
		}
		throw new ToolError(
			`无法解析图片附件 '${options.path}'。可用的图片附件: ${available}。请传入附件 URI 或可读的文件系统路径。`,
		);
	}
	return loadImageAttachmentInput({
		image: attachment.image,
		label: attachment.label,
		uri: attachment.uri,
		autoResize: options.autoResize,
		maxBytes: MAX_IMAGE_INPUT_BYTES,
		excludeWebP: options.excludeWebP,
	});
}

export interface InspectImageToolDetails {
	model: string;
	imagePath: string;
	mimeType: string;
}

export class InspectImageTool implements AgentTool<typeof inspectImageSchema, InspectImageToolDetails> {
	readonly name = "inspect_image";
	readonly approval = "read" as const;
	readonly label = "检查图片";
	readonly loadMode = "discoverable";
	readonly summary = "描述或分析图片文件";
	readonly description: string;
	readonly parameters = inspectImageSchema;
	readonly strict = false;

	readonly examples: readonly ToolExample<typeof inspectImageSchema.infer>[] = [
		{
			caption: "带严格格式的 OCR",
			call: {
				path: "screenshots/error.png",
				question: "逐字提取所有可见文本,按阅读顺序以项目符号列表返回。",
			},
		},
		{
			caption: "截图调试",
			call: {
				path: "screenshots/settings.png",
				question: "找出禁用保存按钮的可能原因。返回:(1) 观察结果,(2) 可能原因,(3) 置信度。",
			},
		},
		{
			caption: "场景/物体问题",
			call: {
				path: "photos/shelf.jpg",
				question:
					"列出所有清晰可见的产品标签及其货架位置(上/中/下)。若无法辨认,请说明无法辨认。",
			},
		},
	];

	constructor(
		private readonly session: ToolSession,
		private readonly completeImageRequest: typeof completeSimple = completeSimple,
	) {
		this.description = prompt.render(inspectImageDescription);
	}

	async execute(
		_toolCallId: string,
		params: InspectImageParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<InspectImageToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<InspectImageToolDetails>> {
		if (this.session.settings.get("images.blockImages")) {
			throw new ToolError(
				"设置 (images.blockImages=true) 已禁用图片提交。请禁用它以使用 inspect_image。",
			);
		}

		const modelRegistry = this.session.modelRegistry;
		if (!modelRegistry) {
			throw new ToolError("inspect_image 的模型注册表不可用。");
		}

		const availableModels = modelRegistry.getAvailable();
		if (availableModels.length === 0) {
			throw new ToolError("没有可用于 inspect_image 的模型。");
		}

		const matchPreferences = getModelMatchPreferences(this.session.settings);
		const resolvePattern = (pattern: string | undefined): Model<Api> | undefined => {
			if (!pattern) return undefined;
			const expanded = expandRoleAlias(pattern, this.session.settings);
			return resolveModelFromString(expanded, availableModels, matchPreferences);
		};

		const activeModelPattern = this.session.getActiveModelString?.() ?? this.session.getModelString?.();
		let model: Model<Api> | undefined;
		let selectedPattern: string | undefined;
		for (const pattern of ["@vision", "@default", activeModelPattern]) {
			const resolved = resolvePattern(pattern);
			if (resolved) {
				model = resolved;
				selectedPattern = pattern;
				break;
			}
		}
		model ??= availableModels[0];
		if (!model) {
			throw new ToolError("无法为 inspect_image 解析模型。");
		}

		if (!model.input.includes("image")) {
			throw new ToolError(
				`解析到的模型 ${model.provider}/${model.id} 不支持图片输入。请为 modelRoles.vision 配置支持视觉的模型。`,
			);
		}

		const apiKey = await modelRegistry.getApiKey(model);
		if (!apiKey) {
			throw new ToolError(
				`No API key available for ${model.provider}/${model.id}. Configure credentials for this provider or choose another vision-capable model.`,
			);
		}

		let imageInput: LoadedImageInput | null;
		const autoResize = this.session.settings.get("images.autoResize");
		const excludeWebP = webpExclusionForModel(model);
		const attachmentReference = parseImageAttachmentReference(params.path);
		try {
			if (attachmentReference) {
				imageInput = await loadAttachmentReferenceInput({
					path: params.path,
					reference: attachmentReference,
					attachments: this.session.getImageAttachments?.() ?? [],
					autoResize,
					excludeWebP,
				});
			} else {
				imageInput = await loadImageInput({
					path: params.path,
					cwd: this.session.cwd,
					autoResize,
					maxBytes: MAX_IMAGE_INPUT_BYTES,
					excludeWebP,
				});
			}
		} catch (error) {
			if (error instanceof ImageInputTooLargeError) {
				throw new ToolError(error.message);
			}
			throw error;
		}

		if (!imageInput) {
			throw new ToolError("inspect_image 仅支持按文件内容识别的 PNG、JPEG、GIF 和 WEBP 文件。");
		}

		const telemetry = resolveTelemetry(this.session.getTelemetry?.(), this.session.getSessionId?.() ?? undefined);
		const timeoutMs = this.session.settings.get("inspect_image.timeoutMs");
		const hasTimeout = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0;
		const timeoutSignal = hasTimeout ? AbortSignal.timeout(timeoutMs) : undefined;
		const effectiveSignal = timeoutSignal
			? signal
				? AbortSignal.any([signal, timeoutSignal])
				: timeoutSignal
			: signal;
		const timedOut = (): boolean => Boolean(timeoutSignal?.aborted) && !signal?.aborted;
		const formatTimeoutMessage = (): string => {
			const seconds = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}` : (timeoutMs / 1000).toFixed(1);
			return `inspect_image request timed out after ${seconds}s. Increase inspect_image.timeoutMs (currently ${timeoutMs}ms; 0 disables) or check the vision model provider.`;
		};

		// Honor the thinking effort configured on the resolved model role
		// (e.g. `modelRoles.vision: <model>:high`). Without it the oneshot sent a
		// suppressed/zero thinking budget, which thinking-only models (Gemini 3.x)
		// reject with HTTP 400 ("Budget 0 is invalid. This model only works in
		// thinking mode.").
		const configuredThinking = concreteThinkingLevel(
			extractExplicitThinkingSelector(selectedPattern, this.session.settings, {
				isLiteralModelId: (provider, id) =>
					availableModels.some(candidate => candidate.provider === provider && candidate.id === id),
			}),
		);
		const reasoning = toReasoningEffort(resolveThinkingLevelForModel(model, configuredThinking));

		let response: AssistantMessage;
		try {
			response = await instrumentedCompleteSimple(
				model,
				{
					systemPrompt: [prompt.render(inspectImageSystemPromptTemplate)],
					messages: [
						{
							role: "user",
							content: [
								{ type: "image", data: imageInput.data, mimeType: imageInput.mimeType },
								{ type: "text", text: params.question },
							],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: modelRegistry.resolver(model, this.session.getSessionId?.() ?? undefined),
					signal: effectiveSignal,
					reasoning,
				},
				{ telemetry, oneshotKind: "inspect_image", completeImpl: this.completeImageRequest },
			);
		} catch (error) {
			if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
				if (timedOut()) throw new ToolError(formatTimeoutMessage());
			}
			throw error;
		}

		if (response.stopReason === "error") {
			throw new ToolError(response.errorMessage ?? "inspect_image 请求失败。");
		}
		if (response.stopReason === "aborted") {
			if (timedOut()) throw new ToolError(formatTimeoutMessage());
			throw new ToolError("inspect_image 请求已中止。");
		}

		const text = extractTextContent(response);
		if (!text) {
			throw new ToolError("inspect_image 模型未返回文本输出。");
		}

		return {
			content: [{ type: "text", text }],
			details: {
				model: `${model.provider}/${model.id}`,
				imagePath: imageInput.resolvedPath,
				mimeType: imageInput.mimeType,
			},
		};
	}
}

export { inspectImageToolRenderer } from "./inspect-image-renderer";
