import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import btwUserPrompt from "../../prompts/system/btw-user.md" with { type: "text" };
import { copyToClipboard } from "../../utils/clipboard";
import { BtwPanelComponent } from "../components/btw-panel";
import type { InteractiveModeContext } from "../types";

interface BtwRequest {
	component: BtwPanelComponent;
	abortController: AbortController;
	question: string;
	leafId: string | null;
	sessionId: string;
}

function assistantMessageWithReplyText(assistantMessage: AssistantMessage, replyText: string): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	let replacedText = false;
	for (const part of assistantMessage.content) {
		if (part.type === "thinking") {
			content.push({ type: "thinking", thinking: part.thinking });
			continue;
		}
		if (part.type === "redactedThinking") continue;
		if (part.type !== "text") {
			content.push(part);
			continue;
		}
		if (replacedText) continue;
		content.push({ type: "text", text: replyText });
		replacedText = true;
	}
	if (!replacedText) content.push({ type: "text", text: replyText });
	return { ...assistantMessage, content, providerPayload: undefined };
}

export class BtwController {
	#activeRequest: BtwRequest | undefined;
	#lastQuestion: string | undefined;
	#lastReplyText: string | undefined;
	#lastAssistantMessage: AssistantMessage | undefined;
	#lastLeafId: string | null | undefined;
	#lastSessionId: string | undefined;
	#branchInFlight = false;
	#lastCopyText: string | undefined;
	#copyInFlight = false;

	constructor(private readonly ctx: InteractiveModeContext) {}

	hasActiveRequest(): boolean {
		return this.#activeRequest !== undefined;
	}

	canBranch(): boolean {
		return this.#branchUnavailableReason() === undefined;
	}

	/** Whether plain `b` is currently reserved for a completed or pending branch action. */
	handlesBranchKey(): boolean {
		if (this.#branchInFlight) return true;
		if (this.#activeRequest?.component.isBranchable() !== true) return false;
		return (
			this.#lastQuestion !== undefined &&
			this.#lastReplyText !== undefined &&
			this.#lastAssistantMessage !== undefined &&
			this.#lastLeafId !== undefined &&
			this.#lastSessionId !== undefined
		);
	}

	#branchUnavailableReason(): string | undefined {
		if (this.#branchInFlight) return "分支操作已在进行中";
		if (this.#activeRequest?.component.isBranchable() !== true) return "答案尚未就绪";
		if (!this.#lastQuestion || !this.#lastReplyText || !this.#lastAssistantMessage) {
			return "答案不可用";
		}
		if (!this.#lastLeafId) return "会话没有分支点";
		if (
			this.#lastSessionId !== this.ctx.sessionManager.getSessionId() ||
			this.#lastLeafId !== this.ctx.sessionManager.getLeafId()
		) {
			return "/btw 启动后会话已发生变化";
		}
		if (this.ctx.session.isStreaming) return "仍有轮次正在运行";
		return undefined;
	}

	canCopy(): boolean {
		return (
			!this.#copyInFlight && this.#activeRequest?.component.isCopyable() === true && this.#lastCopyText !== undefined
		);
	}

	async handleCopy(): Promise<boolean> {
		if (!this.canCopy() || this.#lastCopyText === undefined) return false;
		this.#copyInFlight = true;
		try {
			await copyToClipboard(this.#lastCopyText);
			this.ctx.showStatus("已将 /btw 回答复制到剪贴板");
			return true;
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
			return true;
		} finally {
			this.#copyInFlight = false;
		}
	}

	async handleBranch(): Promise<boolean> {
		const unavailableReason = this.#branchUnavailableReason();
		if (unavailableReason) {
			this.ctx.showStatus(`/btw 分支不可用:${unavailableReason}`, { dim: true });
			return false;
		}
		const request = this.#activeRequest;
		const question = this.#lastQuestion;
		const assistantMessage = this.#lastAssistantMessage;
		const leafId = this.#lastLeafId;
		const sessionId = this.#lastSessionId;
		if (!request || !question || !assistantMessage || !leafId || !sessionId) return false;

		this.#branchInFlight = true;
		request.component.markBranching();
		try {
			await this.ctx.handleBtwBranch(question, assistantMessage, leafId, sessionId);
			return true;
		} finally {
			this.#branchInFlight = false;
			if (this.#activeRequest === request) request.component.markComplete();
		}
	}

	handleEscape(): boolean {
		if (this.#branchInFlight) {
			this.ctx.showStatus("/btw 分支操作正在进行中", { dim: true });
			return true;
		}
		if (!this.#activeRequest) return false;
		this.#closeActiveRequest({ abort: this.#activeRequest.abortController.signal.aborted === false });
		return true;
	}

	dispose(): void {
		this.#closeActiveRequest({ abort: true });
	}

	async start(question: string): Promise<void> {
		const trimmedQuestion = question.trim();
		if (!trimmedQuestion) {
			this.ctx.showStatus("用法:/btw <问题>");
			return;
		}

		const model = this.ctx.session.model;
		if (!model) {
			this.ctx.showError("没有可用于 /btw 的活动模型。");
			return;
		}

		this.#closeActiveRequest({ abort: true });

		const request: BtwRequest = {
			component: new BtwPanelComponent({
				question: trimmedQuestion,
				tui: this.ctx.ui,
				canBranch: () => this.canBranch(),
			}),
			abortController: new AbortController(),
			question: trimmedQuestion,
			leafId: this.ctx.sessionManager.getLeafId(),
			sessionId: this.ctx.sessionManager.getSessionId(),
		};
		this.ctx.btwContainer.clear();
		this.ctx.btwContainer.addChild(request.component);
		this.ctx.ui.requestRender();
		this.#activeRequest = request;
		void this.#runRequest(request);
	}

	async #runRequest(request: BtwRequest): Promise<void> {
		try {
			const promptText = prompt.render(btwUserPrompt, { question: request.question });
			const { replyText, assistantMessage } = await this.ctx.session.runEphemeralTurn({
				promptText,
				onTextDelta: delta => {
					if (this.#isActiveRequest(request)) {
						request.component.appendText(delta);
					}
				},
				signal: request.abortController.signal,
			});

			if (!this.#isActiveRequest(request)) {
				return;
			}
			request.component.setAnswer(replyText);
			request.component.markComplete();
			const copyText = request.component.getCopyText();
			if (copyText !== undefined) {
				this.#lastQuestion = request.question;
				this.#lastReplyText = replyText;
				this.#lastCopyText = copyText;
				this.#lastAssistantMessage = assistantMessageWithReplyText(assistantMessage, replyText);
				this.#lastLeafId = request.leafId;
				this.#lastSessionId = request.sessionId;
			} else {
				this.#clearCompletedState();
			}
		} catch (error) {
			if (!this.#isActiveRequest(request)) {
				return;
			}
			if (request.abortController.signal.aborted) {
				request.component.markAborted();
				return;
			}
			request.component.markError(error instanceof Error ? error.message : String(error));
		}
	}

	#closeActiveRequest(options: { abort: boolean }): void {
		const request = this.#activeRequest;
		if (!request) return;
		this.#activeRequest = undefined;
		this.#clearCompletedState();
		if (options.abort) {
			request.abortController.abort();
		}
		request.component.close();
		this.ctx.btwContainer.clear();
		this.ctx.ui.requestRender();
	}

	#clearCompletedState(): void {
		this.#lastQuestion = undefined;
		this.#lastReplyText = undefined;
		this.#lastAssistantMessage = undefined;
		this.#lastCopyText = undefined;
		this.#lastLeafId = undefined;
		this.#lastSessionId = undefined;
	}

	#isActiveRequest(request: BtwRequest): boolean {
		return this.#activeRequest === request;
	}
}
