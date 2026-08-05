/**
 * Result submission tool for subagent output.
 *
 * Subagents can call this tool incrementally or terminally depending on `type`.
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { TSchema } from "@oh-my-pi/pi-ai/types";
import {
	dereferenceJsonSchema,
	isValidJsonSchema,
	type JsonSchemaValidationResult,
	sanitizeSchemaForStrictMode,
	tryEnforceStrictSchema,
} from "@oh-my-pi/pi-ai/utils/schema";
import { subprocessToolRegistry } from "../task/subprocess-tool-registry";
import type { ToolSession } from ".";
import { buildOutputValidator, formatAllValidationIssues } from "./output-schema-validator";

const YIELD_RESULT_FORMAT_HINT =
	'成功时提交 {"result":{"data":<你的输出>}},失败时提交 {"result":{"error":"message"}}。';

export interface YieldDetails {
	/** Successful result payload, or omitted when `useLastTurn` requests last-turn extraction. */
	data?: unknown;
	status: "success" | "aborted";
	error?: string;
	/** Optional result section/classification supplied by the yield caller. */
	type?: string | string[];
	/** True when the caller intentionally omitted success data so the executor uses the last assistant turn. */
	useLastTurn?: boolean;
	/**
	 * Set when the yield tool exhausted its in-tool schema-retry budget
	 * (MAX_SCHEMA_RETRIES) and accepted the data anyway. Surfaced so the
	 * executor's post-mortem finalizer can honor the override instead of
	 * re-rejecting the same payload with `schema_violation` — keeping the
	 * subagent's acceptance and the parent's view of the result in lockstep.
	 */
	schemaOverridden?: boolean;
}

function formatSchema(schema: unknown): string {
	if (schema === undefined) return "未提供 schema。";
	if (typeof schema === "string") return schema;
	try {
		return JSON.stringify(schema, null, 2);
	} catch {
		return "[无法序列化的 schema]";
	}
}

function looseRecordSchema(description: string): Record<string, unknown> {
	return {
		type: "object",
		additionalProperties: true,
		description,
	};
}

function hasUnresolvedRefs(schema: unknown): boolean {
	if (schema == null) return false;
	if (Array.isArray(schema)) {
		for (const item of schema) {
			if (hasUnresolvedRefs(item)) return true;
		}
		return false;
	}
	if (typeof schema !== "object") return false;
	const record = schema as Record<string, unknown>;
	if (typeof record.$ref === "string") return true;
	for (const key in record) {
		if (key === "const" || key === "default" || key === "enum" || key === "examples") continue;
		if (hasUnresolvedRefs(record[key])) return true;
	}
	return false;
}

const yieldTypeSchema: Record<string, unknown> = {
	anyOf: [
		{ type: "string" },
		{
			type: "array",
			minItems: 1,
			items: { type: "string" },
		},
	],
	description: "可选的结果类型。非空字符串数组表示增量提交;字符串表示最终提交。",
};

function isYieldType(value: unknown): value is string | string[] {
	return (
		typeof value === "string" ||
		(Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string"))
	);
}

function parseYieldType(value: unknown): string | string[] | undefined {
	// Strict-mode providers (OpenAI/Codex) make the optional `type` property
	// required+nullable, so an untyped final yield arrives as `type: null`.
	if (value === undefined || value === null) return undefined;
	if (isYieldType(value)) return value;
	throw new Error("type 必须是字符串或非空字符串数组");
}

/**
 * Render an incremental yield's `type: [...]` labels as a quoted, comma-separated list for
 * model-facing retry messages — keeps the failed section labelled even when the yield carried
 * multiple labels at once.
 */
function formatYieldLabels(labels: readonly string[]): string {
	if (labels.length === 0) return '""';
	return labels.map(label => `"${label}"`).join(", ");
}

/**
 * Expand a plain-object `data` schema into a strict union that ALSO accepts each
 * top-level section value (and array element) on its own. Agents that yield
 * incrementally (`type: ["findings"]`, `type: ["confidence"]`, …) submit one
 * section per call, so `data` is a single finding object or a lone verdict value
 * — never the full output object. Without this, strict-mode providers constrain
 * `data` to the whole schema and reject/—under constrained decoding—forbid the
 * partial. Every branch is a typed sub-schema, so strict representability holds;
 * the full-output object stays the first (terminal) branch. The assembled whole
 * is still validated against the full schema at finalization. Non-object / loose
 * schemas are returned unchanged.
 */
function withSectionVariants(dataSchema: Record<string, unknown>): Record<string, unknown> {
	if (dataSchema.type !== "object") return dataSchema;
	const props = dataSchema.properties;
	if (props === null || typeof props !== "object") return dataSchema;
	const propRecord = props as Record<string, unknown>;
	const { description, ...fullWithoutDescription } = dataSchema;
	const branches: unknown[] = [];
	const seen = new Set<string>();
	const add = (schema: unknown): void => {
		if (schema === null || typeof schema !== "object") return;
		const key = JSON.stringify(schema);
		if (seen.has(key)) return;
		seen.add(key);
		branches.push(schema);
	};
	add(fullWithoutDescription);
	for (const name in propRecord) {
		const prop = propRecord[name];
		add(prop);
		if (prop !== null && typeof prop === "object") {
			const propObj = prop as Record<string, unknown>;
			if (propObj.type === "array") add(propObj.items);
		}
	}
	if (branches.length <= 1) return dataSchema;
	return description !== undefined ? { description, anyOf: branches } : { anyOf: branches };
}

function wrapYieldParameters(dataSchema: Record<string, unknown>): Record<string, unknown> {
	const successResultSchema = {
		type: "object",
		additionalProperties: false,
		description: "任务成功",
		properties: { data: dataSchema },
		required: ["data"],
	};
	const errorResultSchema = {
		type: "object",
		additionalProperties: false,
		properties: {
			error: { type: "string", description: "错误消息" },
		},
		required: ["error"],
	};
	const lastTurnResultSchema = {
		type: "object",
		additionalProperties: false,
		description: "带类型的结果成功;省略 data 以使用最后一条助手消息作为最终结果",
		properties: {},
		required: [],
	};
	// The "an empty `result` (last-turn) requires a `type`" invariant is enforced
	// in `execute()` at runtime, NOT in this schema: a top-level combinator
	// (`allOf`/`anyOf`/`oneOf`/...) makes OpenAI/Codex Responses reject the whole
	// tool with `invalid_function_parameters`, so the wrapper stays a plain object.
	return {
		type: "object",
		additionalProperties: false,
		description: "提交数据或错误",
		properties: {
			type: yieldTypeSchema,
			result: {
				anyOf: [successResultSchema, errorResultSchema, lastTurnResultSchema],
			},
		},
		required: ["result"],
	};
}

/**
 * Max consecutive schema-validation failures before the yield tool overrides validation
 * and lets non-conforming data through. The override is a safety net for schemas the
 * JTD→JSON-Schema converter cannot fully express; it should not be reached during normal
 * model retries. Three matches the existing "3 reminders" pattern elsewhere in the agent
 * runtime.
 */
const MAX_SCHEMA_RETRIES = 3;

/**
 * Max consecutive untyped empty-result submissions before the yield tool fails
 * the child explicitly. Some weak tool callers can acknowledge the required
 * wrapper in prose while repeatedly sending `{ result: {} }`; without a hard
 * stop the parent waits forever.
 */
const MAX_EMPTY_RESULT_RETRIES = 3;

export class YieldTool implements AgentTool<TSchema, YieldDetails> {
	readonly name = "yield";
	readonly approval = "read" as const;
	readonly label = "提交结果";
	readonly description =
		"提交子 Agent 的输出。省略 `type` 时为常规的最终结构化结果。\n\n" +
		'传入 `type: ["section"]` 可提交一个累加的增量、非最终分区;传入 `type: "result"` 表示结束提交;省略 `data` 时,你的最后一条助手消息即为最终结果。\n' +
		'成功时使用 `result: { data: <你的输出> }`,失败时使用 `result: { error: "message" }`。请保留 `result` 包装。';
	readonly parameters: TSchema;
	strict = true;
	readonly intent = "omit" as const;
	lenientArgValidation = true;

	readonly #validate?: (value: unknown) => JsonSchemaValidationResult;
	readonly #validateSection?: ReadonlyMap<string, (value: unknown) => JsonSchemaValidationResult>;
	#rejectUnknownSections = false;
	#knownSectionLabels: readonly string[] = [];
	#isKnownSection?: (label: string) => boolean;
	#schemaValidationFailures = 0;
	#emptyResultFailures = 0;

	constructor(session: ToolSession) {
		let validate: ((value: unknown) => JsonSchemaValidationResult) | undefined;
		let validateSection: ReadonlyMap<string, (value: unknown) => JsonSchemaValidationResult> | undefined;
		let rejectUnknownSections = false;
		let knownSectionLabels: readonly string[] = [];
		let isKnownSection: ((label: string) => boolean) | undefined;
		let parameters: TSchema;

		try {
			const {
				validator,
				jsonSchema: normalizedSchema,
				normalized,
				error: schemaError,
			} = buildOutputValidator(session.outputSchema);
			if (validator) {
				validate = value => validator.validate(value);
				validateSection = validator.validateSection;
				rejectUnknownSections = validator.rejectUnknownSections;
				knownSectionLabels = validator.knownSectionLabels;
				isKnownSection = label => validator.isKnownSection(label);
			}

			const schemaHint = formatSchema(normalizedSchema ?? session.outputSchema);
			const schemaDescription = schemaError
				? `结构化 JSON 输出(输出 schema 无效;接受不受约束的对象):${schemaError}`
				: `符合 schema 的结构化输出:\n${schemaHint}`;
			let sanitizedSchema: Record<string, unknown> | undefined;
			if (!schemaError && normalizedSchema !== undefined) {
				const strictProbe = tryEnforceStrictSchema(normalizedSchema);
				if (strictProbe.strict) {
					sanitizedSchema = sanitizeSchemaForStrictMode(normalizedSchema);
				} else {
					sanitizedSchema = normalizedSchema;
					this.strict = false;
				}
			} else if (!schemaError && normalized === true) {
				sanitizedSchema = {};
				this.strict = false;
			}

			let dataSchema: Record<string, unknown>;
			if (sanitizedSchema !== undefined) {
				const resolved = dereferenceJsonSchema({
					...sanitizedSchema,
					description: schemaDescription,
				}) as Record<string, unknown>;
				if (hasUnresolvedRefs(resolved)) {
					throw new Error("解引用后 schema 仍包含未解析的 $ref");
				}
				dataSchema = withSectionVariants(resolved);
			} else {
				this.strict = false;
				dataSchema = looseRecordSchema(
					schemaError ? schemaDescription : "结构化 JSON 输出(未指定 schema)",
				);
			}
			parameters = wrapYieldParameters(dataSchema);
			JSON.stringify(parameters);
			if (!isValidJsonSchema(parameters)) throw new Error("yield 参数 schema 无效");
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			parameters = wrapYieldParameters(
				looseRecordSchema(`结构化 JSON 输出(schema 处理失败:${errorMsg})`),
			);
			validate = undefined;
			this.strict = false;
		}

		this.#validate = validate;
		this.#validateSection = validateSection;
		this.#rejectUnknownSections = rejectUnknownSections;
		this.#knownSectionLabels = knownSectionLabels;
		this.#isKnownSection = isKnownSection;
		this.parameters = parameters;
	}

	async execute(
		_toolCallId: string,
		params: unknown,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<YieldDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<YieldDetails>> {
		const raw = params as Record<string, unknown>;
		const rawResult = raw.result;
		if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) {
			throw new Error(`result 必须是包含 data 或 error 的对象。${YIELD_RESULT_FORMAT_HINT}`);
		}
		const resultRecord = rawResult as Record<string, unknown>;
		const errorMessage = typeof resultRecord.error === "string" ? resultRecord.error : undefined;
		const data = resultRecord.data;
		const yieldType = parseYieldType(raw.type);
		const useLastTurn =
			errorMessage === undefined && data === undefined && yieldType !== undefined && !("error" in resultRecord);
		// Incremental array-typed sections carry partial data (one finding, one
		// field) that cannot satisfy the full output schema; the assembled result
		// is validated as a whole at finalization (executor finalizeSubprocessOutput).
		const isIncremental = Array.isArray(yieldType) && yieldType.length > 0;

		if (errorMessage !== undefined && data !== undefined) {
			throw new Error("result 不能同时包含 data 和 error");
		}
		if (errorMessage === undefined && data === undefined && yieldType === undefined) {
			this.#emptyResultFailures++;
			if (this.#emptyResultFailures > MAX_EMPTY_RESULT_RETRIES) {
				const attemptCount = this.#emptyResultFailures;
				this.#emptyResultFailures = 0;
				const error =
					`yield 结果连续 ${attemptCount} 次为空;不再无限重试,改为中止子进程。 ` +
					'成功时提交 `{ "result": { "data": <你的输出> } }`,失败时提交 `{ "result": { "error": "message" } }`。';
				return {
					content: [{ type: "text", text: `任务已中止:${error}` }],
					details: {
						data: undefined,
						status: "aborted",
						error,
						type: yieldType,
					},
				};
			}
			const remaining = MAX_EMPTY_RESULT_RETRIES - this.#emptyResultFailures;
			throw new Error(
				`result 必须包含 \`data\` 或 \`error\`。成功时使用 \`{result: {data: <你的输出>}}\`,失败时使用 \`{result: {error: "message"}}\`。中止前剩余的空未类型化结果重试次数:${remaining}。`,
			);
		}

		const status = errorMessage !== undefined ? "aborted" : "success";
		let schemaValidationOverridden = false;
		// Unknown incremental labels are a hard contract mismatch with the closed caller
		// schema. Reject before the last-turn short-circuit too: `type: ["findings"], result: {}`
		// would otherwise be accepted as a typed last-turn incremental yield, then a sibling
		// section's MAX_SCHEMA_RETRIES override flips schemaOverridden in finalization and the
		// stale section rides along untouched.
		if (status === "success" && isIncremental) {
			const unknownLabels = this.#unknownIncrementalLabels(yieldType as string[]);
			if (unknownLabels.length > 0) {
				const validLabels =
					this.#knownSectionLabels.length > 0 ? formatYieldLabels(this.#knownSectionLabels) : "none";
				throw new Error(
					`分区 ${formatYieldLabels(yieldType as string[])} 使用了未知的增量 yield 标签:${formatYieldLabels(unknownLabels)}。请改用 schema 中的标签之一重新提交:${validLabels}。`,
				);
			}
		}
		if (status === "success" && !useLastTurn) {
			if (data === null) {
				throw new Error("yield 表示成功时必须提供 data");
			}
			const sectionFailure = isIncremental
				? this.#validateIncrementalSection(yieldType as string[], data)
				: this.#validate
					? this.#validate(data)
					: undefined;
			if (sectionFailure && !sectionFailure.success) {
				this.#schemaValidationFailures++;
				if (this.#schemaValidationFailures <= MAX_SCHEMA_RETRIES) {
					const remaining = MAX_SCHEMA_RETRIES - this.#schemaValidationFailures;
					const retryHint =
						remaining > 0
							? ` 请用修正后的结构重新调用 yield——在放弃 schema 约束前还剩 ${remaining} 次重试机会。`
							: " 请用修正后的结构重新调用 yield——这是放弃 schema 约束前的最后一次重试。";
					const scope = isIncremental ? `分区 ${formatYieldLabels(yieldType as string[])}` : "输出";
					throw new Error(
						`${scope} 不符合 schema:${formatAllValidationIssues(sectionFailure.issues)}。${retryHint}`,
					);
				}
				schemaValidationOverridden = true;
			}
		}

		this.#emptyResultFailures = 0;
		const responseText =
			status === "aborted"
				? `任务已中止:${errorMessage}`
				: schemaValidationOverridden
					? `结果已提交(在 ${this.#schemaValidationFailures} 次验证失败后已覆盖 schema 验证)。`
					: "结果已提交。";
		return {
			content: [{ type: "text", text: responseText }],
			details: {
				data,
				status,
				error: errorMessage,
				type: yieldType,
				useLastTurn: useLastTurn || undefined,
				schemaOverridden: schemaValidationOverridden || undefined,
			},
		};
	}

	/**
	 * Return incremental yield labels the closed caller schema does not accept. Closure covers the
	 * root, `allOf` conjuncts, and `oneOf`/`anyOf` unions whose every variant is closed (e.g. JTD
	 * discriminators). Open schemas accept any label.
	 */
	#unknownIncrementalLabels(labels: string[]): string[] {
		if (!this.#rejectUnknownSections) return [];
		const isKnown = this.#isKnownSection;
		if (!isKnown) return [];
		return labels.filter(label => !isKnown(label));
	}

	/**
	 * Validate the `data` payload of an incremental yield (`type: ["<label>", …]`) against
	 * the matching property's sub-validator. Returns the first failure across all known labels,
	 * or `undefined` when no label is recognised (user-defined section labels stay loose) or
	 * when all known labels accept the value. Lets the model see the same retry feedback that
	 * the terminal-yield path already produces, instead of leaking the mismatch through to
	 * the parent's post-mortem `schema_violation`. Unknown labels under a closed schema are
	 * handled separately by `#unknownIncrementalLabels` and never reach this validator.
	 */
	#validateIncrementalSection(labels: string[], data: unknown): JsonSchemaValidationResult | undefined {
		const subValidators = this.#validateSection;
		if (!subValidators || subValidators.size === 0) return undefined;
		for (const label of labels) {
			const sub = subValidators.get(label);
			if (!sub) continue;
			const parsed = sub(data);
			if (!parsed.success) return parsed;
		}
		return undefined;
	}
}

// Register subprocess tool handler for extraction + termination.
subprocessToolRegistry.register<YieldDetails>("yield", {
	extractData: event => {
		const details = event.result?.details;
		if (!details || typeof details !== "object") return undefined;
		const record = details as Record<string, unknown>;
		const status = record.status;
		if (status !== "success" && status !== "aborted") return undefined;
		return {
			data: record.data,
			status,
			error: typeof record.error === "string" ? record.error : undefined,
			type: isYieldType(record.type) ? record.type : undefined,
			useLastTurn: record.useLastTurn === true ? true : undefined,
			schemaOverridden: record.schemaOverridden === true ? true : undefined,
		};
	},
	shouldTerminate: event => {
		if (event.isError) return false;
		const details = event.result?.details;
		if (!details || typeof details !== "object") return true;
		const record = details as Record<string, unknown>;
		return !(
			record.status === "success" &&
			Array.isArray(record.type) &&
			record.type.length > 0 &&
			record.type.every(item => typeof item === "string")
		);
	},
});
