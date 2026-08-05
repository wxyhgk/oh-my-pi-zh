import type { DataType } from "@huggingface/transformers";
import { $env } from "@wxyhgk/pi-utils";

/** ONNX quantization / precision for local tiny models (transformers.js `dtype`). */
export type TinyModelDtype = DataType;

const DTYPE_VALUES: Record<TinyModelDtype, true> = {
	auto: true,
	fp32: true,
	fp16: true,
	q8: true,
	int8: true,
	uint8: true,
	q4: true,
	bnb4: true,
	q4f16: true,
	q2: true,
	q2f16: true,
	q1: true,
	q1f16: true,
};

/**
 * Validate and canonicalize a `PI_TINY_DTYPE` value. Returns `undefined` when
 * unset/blank so callers fall back to the per-model spec dtype, and throws on an
 * unrecognized value so a misconfiguration fails loudly instead of silently
 * loading a different precision than requested.
 */
export function normalizeTinyModelDtype(value: string | undefined): TinyModelDtype | undefined {
	const raw = value?.trim().toLowerCase();
	if (!raw) return undefined;
	if (raw in DTYPE_VALUES) return raw as TinyModelDtype;
	throw new Error(
		`不支持的 PI_TINY_DTYPE=${JSON.stringify(value)}。请使用 auto、fp32、fp16、q8、int8、uint8、q4、bnb4、q4f16、q2、q2f16、q1 或 q1f16。`,
	);
}

/**
 * Resolve the `PI_TINY_DTYPE` override. `undefined` means "use the per-model spec
 * dtype" (currently `q4` for every shipped model); a concrete value overrides the
 * precision for whichever local tiny model loads.
 */
export function resolveTinyModelDtypeOverride(
	value: string | undefined = $env.PI_TINY_DTYPE,
): TinyModelDtype | undefined {
	return normalizeTinyModelDtype(value);
}

/** Sentinel `providers.tinyModelDtype` value meaning "use each model's shipped dtype". */
export const TINY_MODEL_DTYPE_DEFAULT = "default";

/** Accepted values for the `providers.tinyModelDtype` setting (validation + UI). */
export const TINY_MODEL_DTYPE_SETTING_VALUES = [
	TINY_MODEL_DTYPE_DEFAULT,
	"q4",
	"q4f16",
	"q8",
	"fp16",
	"fp32",
	"int8",
	"uint8",
	"bnb4",
	"q2",
	"q2f16",
	"q1",
	"q1f16",
	"auto",
] as const;

/** Submenu metadata for the `providers.tinyModelDtype` setting. */
export const TINY_MODEL_DTYPE_SETTING_OPTIONS = [
	{ value: "default", label: "默认", description: "各模型自带的 dtype(当前为 q4)" },
	{ value: "q4", label: "q4", description: "4 位权重;最小且最快" },
	{ value: "q4f16", label: "q4f16", description: "4 位权重,含 fp16 激活" },
	{ value: "q8", label: "q8", description: "8 位量化" },
	{ value: "fp16", label: "fp16", description: "16 位浮点;保真度更高,体积更大" },
	{ value: "fp32", label: "fp32", description: "全精度;最大且最慢" },
	{ value: "int8", label: "int8", description: "有符号 8 位整数" },
	{ value: "uint8", label: "uint8", description: "无符号 8 位整数" },
	{ value: "bnb4", label: "bnb4", description: "bitsandbytes 4 位" },
	{ value: "q2", label: "q2", description: "2 位权重" },
	{ value: "q2f16", label: "q2f16", description: "2 位权重,含 fp16 激活" },
	{ value: "q1", label: "q1", description: "1 位权重" },
	{ value: "q1f16", label: "q1f16", description: "1 位权重,含 fp16 激活" },
	{ value: "auto", label: "自动", description: "让 transformers.js 按设备自动选择" },
] as const satisfies ReadonlyArray<{
	value: (typeof TINY_MODEL_DTYPE_SETTING_VALUES)[number];
	label: string;
	description: string;
}>;

/**
 * Map a `providers.tinyModelDtype` setting value onto a `PI_TINY_DTYPE` env value
 * for the worker. Returns `undefined` for the default sentinel so the worker keeps
 * each model's shipped dtype; the worker still validates the forwarded value via
 * {@link normalizeTinyModelDtype}.
 */
export function tinyModelDtypeSettingToEnv(value: string | undefined): string | undefined {
	if (!value || value === TINY_MODEL_DTYPE_DEFAULT) return undefined;
	return value;
}
