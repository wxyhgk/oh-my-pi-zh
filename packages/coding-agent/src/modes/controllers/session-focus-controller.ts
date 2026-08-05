/**
 * SessionFocusController - Weak retargeting primitive between the rendering/
 * input layer and the AgentSession it displays.
 *
 * Focusing re-points the transcript, streaming event subscription, status
 * line, and editor prompt/interrupt at a subagent's live AgentSession (from
 * AgentRegistry) without touching the main session underneath; unfocusing
 * re-attaches the main session and rebuilds the transcript from its
 * authoritative state.
 */

import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID, type RegistryEvent } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { setTerminalTitleState } from "../../utils/title-generator";
import type { InteractiveModeContext } from "../types";

export class SessionFocusController {
	#focusedAgentId: string | undefined;
	/** Session currently attached while focused; undefined when unfocused. */
	#attachedSession: AgentSession | undefined;
	#registryUnsubscribe: (() => void) | undefined;

	constructor(
		private ctx: InteractiveModeContext,
		private registry: AgentRegistry = AgentRegistry.global(),
		private lifecycle: () => AgentLifecycleManager = () => AgentLifecycleManager.global(),
	) {}

	get focusedAgentId(): string | undefined {
		return this.#focusedAgentId;
	}

	/** Focused live session, undefined when unfocused. */
	get target(): AgentSession | undefined {
		return this.#attachedSession;
	}

	/** Focus the main view on an agent's live session. Throws an Error with a user-displayable message. */
	async focusAgent(id: string): Promise<void> {
		if (this.ctx.collabGuest) throw new Error("协作会话中无法查看 Agent。");
		if (id === MAIN_AGENT_ID) return this.unfocus();
		const session = await this.lifecycle().ensureLive(id);
		if (id === this.#focusedAgentId && session === this.#attachedSession) return;
		this.#focusedAgentId = id;
		this.#attachedSession = session;
		this.#registryUnsubscribe ??= this.registry.onChange(e => this.#onRegistryEvent(e));
		await this.#attach(session);
		this.ctx.showStatus(`正在查看 Agent ${id} — Esc 返回主会话,←← 跳转到父级`);
	}

	/** Focus the focused agent's parent agent, falling back to the main session. No-op when unfocused. */
	async focusParent(): Promise<void> {
		if (!this.#focusedAgentId) return;
		const parentId = this.registry.get(this.#focusedAgentId)?.parentId;
		if (parentId && parentId !== MAIN_AGENT_ID && this.registry.get(parentId)) {
			return this.focusAgent(parentId);
		}
		return this.unfocus();
	}

	/** Return to the main session. No-op when unfocused. */
	async unfocus(): Promise<void> {
		if (!this.#focusedAgentId) return;
		this.#focusedAgentId = undefined;
		this.#attachedSession = undefined;
		await this.#attach(this.ctx.session);
		this.ctx.showStatus("已返回主会话");
	}

	dispose(): void {
		this.#registryUnsubscribe?.();
		this.#registryUnsubscribe = undefined;
	}

	#onRegistryEvent(event: RegistryEvent): void {
		if (event.ref.id !== this.#focusedAgentId) return;
		const gone = event.type === "removed";
		const dead = event.type === "status_changed" && (event.ref.status === "parked" || event.ref.status === "aborted");
		if (!gone && !dead) return;
		void this.unfocus().then(() => {
			this.ctx.showStatus(`Agent ${event.ref.id} ${gone ? "已消失" : event.ref.status};已返回主会话`);
		});
	}

	/** Retarget core, both directions: swap subscription, transcript, and status line onto `target`. */
	async #attach(target: AgentSession): Promise<void> {
		this.ctx.unsubscribe?.();
		this.ctx.clearTransientSessionUi();
		this.ctx.eventController.resetTranscriptAnchors();
		// Orphan-delta guard: when attaching mid-turn the message_start for the
		// in-flight assistant message predates the attach. message_update carries
		// the full accumulating message, so synthesize the missing start before
		// the first orphaned update; every other handler is tolerant of unknown
		// anchors (guarded by streamingComponent/pendingTools lookups).
		let assistantStreamSynced = false;
		this.ctx.unsubscribe = target.subscribe(async event => {
			if (event.type === "message_start" && event.message.role === "assistant") {
				assistantStreamSynced = true;
			} else if (event.type === "message_update" && event.message.role === "assistant" && !assistantStreamSynced) {
				assistantStreamSynced = true;
				await this.ctx.eventController.handleEvent({ type: "message_start", message: event.message });
			}
			await this.ctx.eventController.handleEvent(event);
		});
		this.ctx.statusLine.setSession(target, this.#focusedAgentId);
		this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		// Sync the run-state title to the attached target: a streaming target has no
		// agent_start incoming, so arm the loader/working title manually; an idle
		// target would otherwise inherit the previous session's stuck spinner, so
		// reset it to idle (agent_end teardown already ran via clearTransientSessionUi).
		if (target.isStreaming) await this.ctx.eventController.handleEvent({ type: "agent_start" });
		else setTerminalTitleState("idle");
		this.ctx.updateEditorBorderColor();
		this.ctx.ui.requestRender();
	}
}
