import * as fs from "node:fs/promises";
import {
	applyOpsToPhases,
	getLatestTodoPhasesFromEntries,
	markdownToPhases,
	phasesToMarkdown,
	resolveTodoMarkdownPath,
	type TodoItem,
	type TodoPhase,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "../../tools/todo";
import { copyToClipboard } from "../../utils/clipboard";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import type { InteractiveModeContext } from "../types";

const USAGE = [
	"用法:/todo <verb> [args]",
	"  /todo                              显示当前待办事项",
	"  /todo edit                         在 $EDITOR 中打开待办事项",
	"  /todo copy                         将待办事项以 Markdown 复制到剪贴板",
	"  /todo export [<path>]              将待办事项写入文件(默认:TODO.md)",
	"  /todo import [<path>]              从文件替换待办事项(默认:TODO.md)",
	"  /todo append [<phase>] <task...>   追加任务;阶段模糊匹配或自动创建",
	"  /todo start  <task>                将任务标记为进行中(模糊内容匹配)",
	"  /todo done   [<task|phase>]        将任务/阶段/全部标记为已完成",
	"  /todo drop   [<task|phase>]        将任务/阶段/全部标记为已放弃",
	"  /todo rm     [<task|phase>]        移除任务/阶段/全部",
].join("\n");

// =============================================================================
// Argument tokenizer (respects double-quoted strings)
// =============================================================================

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let cur = "";
	let inQuote = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (ch === "\\" && i + 1 < input.length) {
			cur += input[++i];
			continue;
		}
		if (ch === '"') {
			inQuote = !inQuote;
			continue;
		}
		if (!inQuote && /\s/.test(ch)) {
			if (cur) {
				tokens.push(cur);
				cur = "";
			}
			continue;
		}
		cur += ch;
	}
	if (cur) tokens.push(cur);
	return tokens;
}

// =============================================================================
// Name normalization
// =============================================================================

function titleCase(s: string): string {
	return s
		.split(/\s+/)
		.filter(Boolean)
		.map(word => word[0].toUpperCase() + word.slice(1))
		.join(" ");
}

// =============================================================================
// Fuzzy matching
// =============================================================================

function findPhaseFuzzy(phases: TodoPhase[], query: string): TodoPhase | undefined {
	const q = query.trim().toLowerCase();
	if (!q) return undefined;
	// Exact name (case-insensitive)
	const byName = phases.find(p => p.name.toLowerCase() === q);
	if (byName) return byName;
	// Substring (prefer prefix match)
	const prefixMatches = phases.filter(p => p.name.toLowerCase().startsWith(q));
	if (prefixMatches.length === 1) return prefixMatches[0];
	const subMatches = phases.filter(p => p.name.toLowerCase().includes(q));
	if (subMatches.length === 1) return subMatches[0];
	return undefined;
}

function findTaskFuzzy(phases: TodoPhase[], query: string): { task: TodoItem; phase: TodoPhase } | undefined {
	const q = query.trim().toLowerCase();
	if (!q) return undefined;
	// Exact content (case-insensitive)
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase() === q) return { task, phase };
		}
	}
	const matches: Array<{ task: TodoItem; phase: TodoPhase }> = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase().includes(q)) {
				matches.push({ task, phase });
			}
		}
	}
	if (matches.length === 1) return matches[0];
	// Prefer single in_progress/pending hit when ambiguous
	const active = matches.filter(m => m.task.status === "in_progress" || m.task.status === "pending");
	if (active.length === 1) return active[0];
	return undefined;
}

// =============================================================================
// Build system reminder
// =============================================================================

function buildSystemReminder(action: string, phases: TodoPhase[], removed = false): string {
	const md = phases.length === 0 ? "（空）" : phasesToMarkdown(phases).trimEnd();
	const lines = ["<system-reminder>", `用户手动修改了待办事项列表(${action})。`];
	if (removed) {
		lines.push(
			phases.length === 0
				? "用户有意清空了待办事项列表。除非用户明确要求,否则请勿重新创建或填充该列表;请在无待办事项列表的情况下继续当前请求。"
				: "用户有意移除了下方不再显示的条目。除非用户明确要求,否则请勿重新添加。",
		);
	}
	lines.push("当前待办事项列表:", "", md, "</system-reminder>");
	return lines.join("\n");
}

export class TodoCommandController {
	constructor(private readonly ctx: InteractiveModeContext) {}

	/**
	 * True latest todo state for the user-facing /todo verbs. Reads from session
	 * entries or falls back to the active session state.
	 */
	#currentPhases(): TodoPhase[] {
		const fromEntries = getLatestTodoPhasesFromEntries(this.ctx.sessionManager.getBranch());
		if (fromEntries.length > 0) return fromEntries;
		return this.ctx.session.getTodoPhases();
	}

	async handleTodoCommand(args: string): Promise<void> {
		const trimmed = args.trim();
		if (!trimmed) {
			this.#showCurrent();
			return;
		}

		const spaceIdx = trimmed.search(/\s/);
		const verb = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
		const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

		switch (verb) {
			case "edit":
				await this.#editInExternalEditor();
				return;
			case "copy":
				this.#copyMarkdown();
				return;
			case "export":
				await this.#exportToFile(rest);
				return;
			case "import":
				await this.#importFromFile(rest);
				return;
			case "help":
			case "?":
				this.ctx.showStatus(USAGE);
				return;
			case "append":
				this.#append(rest);
				return;
			case "start":
				this.#start(rest);
				return;
			case "done":
				this.#mutateStatus(rest, "completed");
				return;
			case "drop":
				this.#mutateStatus(rest, "abandoned");
				return;
			case "rm":
				this.#remove(rest);
				return;
			default:
				this.ctx.showError(`未知 /todo 动词 "${verb}"。\n${USAGE}`);
		}
	}

	#showCurrent(): void {
		const phases = this.#currentPhases();
		if (phases.length === 0) {
			this.ctx.showStatus("暂无待办事项。使用 /todo append <task> 开始一项。");
			return;
		}
		this.ctx.showStatus(phasesToMarkdown(phases).trimEnd());
	}

	#copyMarkdown(): void {
		const phases = this.#currentPhases();
		if (phases.length === 0) {
			this.ctx.showWarning("没有可复制的待办事项。");
			return;
		}
		try {
			copyToClipboard(phasesToMarkdown(phases));
			this.ctx.showStatus("已将待办事项以 Markdown 复制到剪贴板。");
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	#resolveTodoPath(rest: string): string {
		return resolveTodoMarkdownPath(rest, this.ctx.sessionManager.getCwd());
	}

	async #exportToFile(rest: string): Promise<void> {
		const phases = this.#currentPhases();
		if (phases.length === 0) {
			this.ctx.showWarning("没有可导出的待办事项。");
			return;
		}
		try {
			const target = this.#resolveTodoPath(rest);
			await fs.writeFile(target, phasesToMarkdown(phases), "utf8");
			this.ctx.showStatus(`已将待办事项写入 ${target}`);
		} catch (error) {
			this.ctx.showError(`写入待办事项失败:${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #importFromFile(rest: string): Promise<void> {
		let source = "";
		let content: string;
		try {
			source = this.#resolveTodoPath(rest);
			content = await fs.readFile(source, "utf8");
		} catch (error) {
			this.ctx.showError(`读取待办事项失败:${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const { phases, errors } = markdownToPhases(content);
		if (errors.length > 0) {
			this.ctx.showError(`无法解析 ${source}:\n  ${errors.join("\n  ")}`);
			return;
		}
		this.#commit(phases, `/todo import ${source}`);
		const taskCount = phases.reduce((sum, p) => sum + p.tasks.length, 0);
		this.ctx.showStatus(`已从 ${source} 导入 ${phases.length} 个阶段,${taskCount} 项任务。`);
	}

	// ------------------------------------------------------------- append

	#append(rest: string): void {
		const tokens = tokenize(rest);
		if (tokens.length === 0) {
			this.ctx.showError("用法:/todo append [<phase>] <task...>");
			return;
		}

		const current = this.#currentPhases();
		let phaseName: string | undefined;
		let content: string;

		if (tokens.length === 1) {
			content = tokens[0];
		} else {
			phaseName = tokens[0];
			content = tokens.slice(1).join(" ");
		}

		const next = current.map(phase => ({ ...phase, tasks: phase.tasks.slice() }));
		let targetPhase: TodoPhase | undefined;

		if (phaseName) {
			targetPhase = findPhaseFuzzy(next, phaseName);
			if (!targetPhase) {
				targetPhase = { name: titleCase(phaseName), tasks: [] };
				next.push(targetPhase);
			}
		} else if (next.length > 0) {
			targetPhase = next[next.length - 1];
		} else {
			targetPhase = { name: "待办事项", tasks: [] };
			next.push(targetPhase);
		}

		const finalContent = titleCaseSentence(content);
		targetPhase.tasks.push({
			content: finalContent,
			status: "pending",
		});

		this.#commit(next, `/todo append → ${targetPhase.name}`);
		this.ctx.showStatus(`已追加到 ${targetPhase.name}:${finalContent}`);
	}

	// ------------------------------------------------------------- start / done / drop / rm

	#start(rest: string): void {
		if (!rest) {
			this.ctx.showError("用法:/todo start <task>");
			return;
		}
		const current = this.#currentPhases();
		const hit = findTaskFuzzy(current, rest);
		if (!hit) {
			this.ctx.showError(`未找到匹配的任务 "${rest}"。使用 /todo 列出当前任务。`);
			return;
		}
		const { phases, errors } = applyOpsToPhases(current, [{ op: "start", task: hit.task.content }]);
		if (errors.length > 0) {
			this.ctx.showError(errors.join("; "));
			return;
		}
		this.#commit(phases, `/todo start ${hit.task.content}`);
		this.ctx.showStatus(`已开始:${hit.task.content}`);
	}

	#mutateStatus(rest: string, target: "completed" | "abandoned"): void {
		const op = target === "completed" ? "done" : "drop";
		const statusLabel = target === "completed" ? "已完成" : "已放弃";
		const current = this.#currentPhases();
		const trimmed = rest.trim();
		if (!trimmed) {
			// no-arg: apply to all
			const { phases, errors } = applyOpsToPhases(current, [{ op }]);
			if (errors.length > 0) {
				this.ctx.showError(errors.join("; "));
				return;
			}
			this.#commit(phases, `/todo ${op} (all)`);
			this.ctx.showStatus(`已将所有任务标记为${statusLabel}。`);
			return;
		}

		const taskHit = findTaskFuzzy(current, trimmed);
		if (taskHit) {
			const { phases, errors } = applyOpsToPhases(current, [{ op, task: taskHit.task.content }]);
			if (errors.length > 0) {
				this.ctx.showError(errors.join("; "));
				return;
			}
			this.#commit(phases, `/todo ${op} ${taskHit.task.content}`);
			this.ctx.showStatus(`已标记为${statusLabel}:${taskHit.task.content}`);
			return;
		}

		const phaseHit = findPhaseFuzzy(current, trimmed);
		if (phaseHit) {
			const { phases, errors } = applyOpsToPhases(current, [{ op, phase: phaseHit.name }]);
			if (errors.length > 0) {
				this.ctx.showError(errors.join("; "));
				return;
			}
			this.#commit(phases, `/todo ${op} ${phaseHit.name}`);
			this.ctx.showStatus(`已将阶段 ${phaseHit.name} 标记为${statusLabel}。`);
			return;
		}

		this.ctx.showError(`未找到匹配的任务或阶段 "${trimmed}"。`);
	}

	#remove(rest: string): void {
		const current = this.#currentPhases();
		const trimmed = rest.trim();
		if (!trimmed) {
			this.#commit([], "/todo rm (all)", { removed: true });
			this.ctx.showStatus("已清空全部待办事项。");
			return;
		}
		const taskHit = findTaskFuzzy(current, trimmed);
		if (taskHit) {
			const { phases, errors } = applyOpsToPhases(current, [{ op: "rm", task: taskHit.task.content }]);
			if (errors.length > 0) {
				this.ctx.showError(errors.join("; "));
				return;
			}
			this.#commit(phases, `/todo rm ${taskHit.task.content}`, { removed: true });
			this.ctx.showStatus(`已移除:${taskHit.task.content}`);
			return;
		}
		const phaseHit = findPhaseFuzzy(current, trimmed);
		if (phaseHit) {
			const { phases, errors } = applyOpsToPhases(current, [{ op: "rm", phase: phaseHit.name }]);
			if (errors.length > 0) {
				this.ctx.showError(errors.join("; "));
				return;
			}
			this.#commit(phases, `/todo rm ${phaseHit.name}`, { removed: true });
			this.ctx.showStatus(`已移除阶段:${phaseHit.name}`);
			return;
		}
		this.ctx.showError(`未找到匹配的任务或阶段 "${trimmed}"。`);
	}

	// ------------------------------------------------------------- editor

	async #editInExternalEditor(): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.ctx.showWarning("未配置编辑器。请设置 $VISUAL 或 $EDITOR 环境变量。");
			return;
		}

		const current = this.#currentPhases();
		const initialMarkdown =
			current.length > 0 ? phasesToMarkdown(current) : "# 待办事项\n- [ ] (用你的任务替换此处)\n";

		const fileHandle = await this.#openTtyHandle();
		this.ctx.ui.stop();
		try {
			const stdio: [number | "inherit", number | "inherit", number | "inherit"] = fileHandle
				? [fileHandle.fd, fileHandle.fd, fileHandle.fd]
				: ["inherit", "inherit", "inherit"];
			const result = await openInEditor(editorCmd, initialMarkdown, {
				extension: ".todo.md",
				stdio,
			});
			if (result === null) {
				this.ctx.showWarning("编辑器未保存即退出;待办事项未更改。");
				return;
			}
			const { phases: parsed, errors } = markdownToPhases(result);
			if (errors.length > 0) {
				this.ctx.showError(`无法解析 Markdown:\n  ${errors.join("\n  ")}`);
				return;
			}
			this.#commit(parsed, "/todo edit");
			const taskCount = parsed.reduce((sum, p) => sum + p.tasks.length, 0);
			this.ctx.showStatus(`已从编辑器更新待办事项:${parsed.length} 个阶段,${taskCount} 项任务。`);
		} catch (error) {
			this.ctx.showWarning(
				`打开外部编辑器失败:${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			if (fileHandle) {
				await fileHandle.close().catch(() => {});
			}
			this.ctx.ui.start();
			this.ctx.ui.requestRender();
		}
	}

	async #openTtyHandle(): Promise<fs.FileHandle | null> {
		const stdinPath = (process.stdin as unknown as { path?: string }).path;
		const candidate = typeof stdinPath === "string" ? stdinPath : undefined;
		if (!candidate) return null;
		try {
			return await fs.open(candidate, "r+");
		} catch {
			return null;
		}
	}

	#commit(nextPhases: TodoPhase[], action: string, opts?: { removed?: boolean }): void {
		// 1. In-memory + UI state
		this.ctx.session.setTodoPhases(nextPhases);
		this.ctx.setTodos(nextPhases);

		// 2. Persist for reload survival via custom session entry.
		this.ctx.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: nextPhases });

		// 3. Inject system reminder so the agent learns about the change next turn.
		//    Removals carry explicit intent so the agent does not rebuild the
		//    cleared/removed items on its next turn (issue #5258).
		const reminderText = buildSystemReminder(action, nextPhases, opts?.removed ?? false);
		const message = {
			role: "developer" as const,
			content: [{ type: "text" as const, text: reminderText }],
			attribution: "user" as const,
			timestamp: Date.now(),
		};
		this.ctx.agent.appendMessage(message);
		this.ctx.sessionManager.appendMessage(message);
	}
}

/** Capitalize first letter only — keeps acronyms / casing in the rest of the sentence intact. */
function titleCaseSentence(s: string): string {
	const trimmed = s.trim();
	if (!trimmed) return trimmed;
	return trimmed[0].toUpperCase() + trimmed.slice(1);
}
