/** Default session-title model: the online @smol path (no local download / on-device inference). */
export const ONLINE_TINY_TITLE_MODEL_KEY = "online";
/** Local model the `tiny-models` CLI downloads when none is named. Not the session-title default — that is {@link ONLINE_TINY_TITLE_MODEL_KEY}. */
export const DEFAULT_TINY_TITLE_LOCAL_MODEL_KEY = "lfm2-700m";

export interface TinyTitleLocalModelSpec {
	key: string;
	repo: string;
	dtype: "q4";
	label: string;
	description: string;
	contextNote: string;
	/** Model family emits hidden reasoning unless the chat template disables it. */
	reasoning?: boolean;
	/** Reason this model is blocked before loading the ONNX runtime. */
	unsupportedReason?: string;
}

export const TINY_TITLE_LOCAL_MODELS = [
	{
		key: "lfm2-350m",
		repo: "onnx-community/LFM2-350M-ONNX",
		dtype: "q4",
		label: "LFM2 350M",
		description: "推荐的本地模型;速度与质量最均衡,缓存约 212 MB。",
		contextNote: "标题生成实验中的最佳本地默认选项。",
	},
	{
		key: "qwen3-0.6b",
		repo: "onnx-community/Qwen3-0.6B-ONNX",
		dtype: "q4",
		label: "Qwen3 0.6B",
		description: "最稳健的本地选项;首次加载较慢,缓存约 500 MB。",
		contextNote: "当标题质量比本地启动成本更重要时使用。",
		reasoning: true,
	},
	{
		key: "gemma-270m",
		repo: "onnx-community/gemma-3-270m-it-ONNX",
		dtype: "q4",
		label: "Gemma 270M",
		description: "最小的可用本地选项;质量较低,缓存占用最小。",
		contextNote: "适用于资源受限但仍需本地标题的机器。",
	},
	{
		key: "qwen2.5-0.5b",
		repo: "onnx-community/Qwen2.5-0.5B-Instruct",
		dtype: "q4",
		label: "Qwen2.5 0.5B",
		description: "均衡的本地回退选项;质量与缓存占用适中。",
		contextNote: "当 Qwen3 过重而 Gemma 质量不足时有用。",
	},
	{
		key: "lfm2-700m",
		repo: "onnx-community/LFM2-700M-ONNX",
		dtype: "q4",
		label: "LFM2 700M",
		description: "质量最高的本地选项;比 LFM2 350M 更大更慢。",
		contextNote: "当本地标题质量优先于启动成本时使用。",
	},
] as const satisfies readonly TinyTitleLocalModelSpec[];

export const TINY_TITLE_MODEL_VALUES = [
	ONLINE_TINY_TITLE_MODEL_KEY,
	"lfm2-350m",
	"qwen3-0.6b",
	"gemma-270m",
	"qwen2.5-0.5b",
	"lfm2-700m",
] as const;

export type TinyTitleModelKey = (typeof TINY_TITLE_MODEL_VALUES)[number];
export type TinyTitleLocalModelKey = (typeof TINY_TITLE_LOCAL_MODELS)[number]["key"];

type MissingTinyTitleModelValue = Exclude<
	typeof ONLINE_TINY_TITLE_MODEL_KEY | TinyTitleLocalModelKey,
	TinyTitleModelKey
>;
type ExtraTinyTitleModelValue = Exclude<TinyTitleModelKey, typeof ONLINE_TINY_TITLE_MODEL_KEY | TinyTitleLocalModelKey>;
const TINY_TITLE_MODEL_VALUES_MATCH_REGISTRY: MissingTinyTitleModelValue extends never
	? ExtraTinyTitleModelValue extends never
		? true
		: never
	: never = true;
void TINY_TITLE_MODEL_VALUES_MATCH_REGISTRY;

export const TINY_TITLE_MODEL_OPTIONS = [
	{
		value: ONLINE_TINY_TITLE_MODEL_KEY,
		label: "在线(TINY 角色,否则 @smol)",
		description:
			"在线标题生成:已分配 TINY 模型角色时使用它(在 /models 中设置),否则使用在线回退(commit 角色,然后是 @smol)。无需本地下载或设备端推理。",
	},
	...TINY_TITLE_LOCAL_MODELS.map(model => ({
		value: model.key,
		label: model.label,
		description: model.description,
	})),
] satisfies ReadonlyArray<{ value: TinyTitleModelKey; label: string; description: string }>;

export function isTinyTitleLocalModelKey(value: string): value is TinyTitleLocalModelKey {
	return TINY_TITLE_LOCAL_MODELS.some(model => model.key === value);
}

export function getTinyTitleModelSpec(key: TinyTitleLocalModelKey): (typeof TINY_TITLE_LOCAL_MODELS)[number] {
	const spec = TINY_TITLE_LOCAL_MODELS.find(model => model.key === key);
	if (!spec) throw new Error(`未知的 tiny 标题模型:${key}`);
	return spec;
}

/** Default memory model: the online path (the configured smol / remote LLM; no local download). */
export const ONLINE_MEMORY_MODEL_KEY = "online";
/** Recommended local model for memory tasks when none is named. */
export const DEFAULT_MEMORY_LOCAL_MODEL_KEY = "lfm2-1.2b";

/**
 * Local models for Mnemopi memory tasks (fact extraction + consolidation).
 * These are larger (1B-1.7B) than the title models: structured extraction and
 * faithful summarization need more capacity than 3-6 word titles. All q4.
 * Ranking/recipe rationale lives in docs/local-models.md.
 */
export const TINY_MEMORY_LOCAL_MODELS = [
	{
		key: "qwen3-1.7b",
		repo: "onnx-community/Qwen3-1.7B-ONNX",
		dtype: "q4",
		label: "Qwen3 1.7B",
		description: "已禁用本地推理:onnxruntime-node 无法运行此 ONNX 导出的 RotaryEmbedding 缓存更新。",
		contextNote: "加载前即被阻止,以避免不支持的 RotaryEmbedding 运行时路径。",
		reasoning: true,
		unsupportedReason: "onnxruntime-node 不支持 onnx-community/Qwen3-1.7B-ONNX 中的 Qwen3 RotaryEmbedding 缓存更新",
	},
	{
		key: "llama3.2:3b",
		repo: "onnx-community/Llama-3.2-3B-Instruct-ONNX",
		dtype: "q4",
		label: "Llama 3.2 3B",
		description: "面向本地记忆/分类任务的更大 Llama 3.2 选项;质量潜力更高,但磁盘/内存/延迟成本也更高。",
		contextNote: "当更看重模型容量而非加载速度时使用。",
	},
	{
		key: "gemma-3-1b",
		repo: "onnx-community/gemma-3-1b-it-ONNX",
		dtype: "q4",
		label: "Gemma 3 1B",
		description: "合并/去重效果最佳;占用更小,但提取时会混入闲聊内容。",
		contextNote: "当合并质量与体积最重要时使用。",
	},
	{
		key: "qwen2.5-1.5b",
		repo: "onnx-community/Qwen2.5-1.5B-Instruct",
		dtype: "q4",
		label: "Qwen2.5 1.5B",
		description: "提取粒度最佳(原子事实);合并能力较弱。",
		contextNote: "当细粒度、可去重的事实比摘要更重要时使用。",
	},
	{
		key: "lfm2-1.2b",
		repo: "onnx-community/LFM2-1.2B-ONNX",
		dtype: "q4",
		label: "LFM2 1.2B",
		description: "加载最快;可靠的全能选手,提取标签略嘈杂。",
		contextNote: "当本地启动成本是首要考虑时使用。",
	},
] as const satisfies readonly TinyTitleLocalModelSpec[];

export const TINY_MEMORY_MODEL_VALUES = [
	ONLINE_MEMORY_MODEL_KEY,
	"qwen3-1.7b",
	"llama3.2:3b",
	"gemma-3-1b",
	"qwen2.5-1.5b",
	"lfm2-1.2b",
] as const;

export type TinyMemoryModelKey = (typeof TINY_MEMORY_MODEL_VALUES)[number];
export type TinyMemoryLocalModelKey = (typeof TINY_MEMORY_LOCAL_MODELS)[number]["key"];

type MissingTinyMemoryModelValue = Exclude<
	typeof ONLINE_MEMORY_MODEL_KEY | TinyMemoryLocalModelKey,
	TinyMemoryModelKey
>;
type ExtraTinyMemoryModelValue = Exclude<TinyMemoryModelKey, typeof ONLINE_MEMORY_MODEL_KEY | TinyMemoryLocalModelKey>;
const TINY_MEMORY_MODEL_VALUES_MATCH_REGISTRY: MissingTinyMemoryModelValue extends never
	? ExtraTinyMemoryModelValue extends never
		? true
		: never
	: never = true;
void TINY_MEMORY_MODEL_VALUES_MATCH_REGISTRY;

export const TINY_MEMORY_MODEL_OPTIONS = [
	{
		value: ONLINE_MEMORY_MODEL_KEY,
		label: "在线(TINY 角色,否则 @smol)",
		description: "使用在线模型:设置后使用 /models 中的 TINY 角色,否则使用 @smol。无需本地模型下载或设备端推理。",
	},
	...TINY_MEMORY_LOCAL_MODELS.map(model => ({
		value: model.key,
		label: model.label,
		description: model.description,
	})),
] satisfies ReadonlyArray<{ value: TinyMemoryModelKey; label: string; description: string }>;

export function isTinyMemoryLocalModelKey(value: string): value is TinyMemoryLocalModelKey {
	return TINY_MEMORY_LOCAL_MODELS.some(model => model.key === value);
}

export function getTinyMemoryModelSpec(key: TinyMemoryLocalModelKey): (typeof TINY_MEMORY_LOCAL_MODELS)[number] {
	const spec = TINY_MEMORY_LOCAL_MODELS.find(model => model.key === key);
	if (!spec) throw new Error(`未知的 tiny 记忆模型:${key}`);
	return spec;
}

/** Return whether a memory local model may emit reasoning tokens before answers. */
export function isTinyMemoryReasoningModelKey(key: TinyMemoryLocalModelKey): boolean {
	const spec = getTinyMemoryModelSpec(key);
	return "reasoning" in spec && spec.reasoning === true;
}

/** Any local model key (title or memory), used by the shared inference worker. */
export type TinyLocalModelKey = TinyTitleLocalModelKey | TinyMemoryLocalModelKey;

/** Resolve a local model spec by key across both the title and memory registries. */
export function getTinyLocalModelSpec(key: string): TinyTitleLocalModelSpec | undefined {
	return (
		TINY_TITLE_LOCAL_MODELS.find(model => model.key === key) ??
		TINY_MEMORY_LOCAL_MODELS.find(model => model.key === key)
	);
}

export function isTinyLocalModelKey(value: string): value is TinyLocalModelKey {
	return getTinyLocalModelSpec(value) !== undefined;
}

/** Combined local model registry (title + memory) for the shared tiny-models CLI. */
export const TINY_LOCAL_MODELS = [
	...TINY_TITLE_LOCAL_MODELS,
	...TINY_MEMORY_LOCAL_MODELS,
] as const satisfies readonly TinyTitleLocalModelSpec[];

/**
 * Difficulty-classifier model for the `auto` thinking level. Defaults to the
 * online smol path; the local options reuse the memory-model registry because
 * the shared worker's `complete()` only accepts memory local keys, and the
 * 1B+ memory models classify coding difficulty far more reliably than the
 * sub-1B title models.
 */
export const ONLINE_AUTO_THINKING_MODEL_KEY = ONLINE_MEMORY_MODEL_KEY;
export const AUTO_THINKING_MODEL_VALUES = TINY_MEMORY_MODEL_VALUES;
export type AutoThinkingModelKey = TinyMemoryModelKey;

export const AUTO_THINKING_MODEL_OPTIONS = [
	{
		value: ONLINE_AUTO_THINKING_MODEL_KEY,
		label: "在线(TINY 角色,否则 @smol)",
		description: "使用 TINY 角色模型(在 /models 中设置)或 @smol 在线判断提示词难度;无需本地下载或设备端推理。",
	},
	...TINY_MEMORY_LOCAL_MODELS.map(model => ({
		value: model.key,
		label: model.label,
		description: model.description,
	})),
] satisfies ReadonlyArray<{ value: AutoThinkingModelKey; label: string; description: string }>;
