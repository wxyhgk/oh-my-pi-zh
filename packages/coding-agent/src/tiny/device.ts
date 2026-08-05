import type { DeviceType } from "@huggingface/transformers";
import { $env } from "@oh-my-pi/pi-utils";

export type TinyModelDevice = DeviceType;

export interface TinyModelDevicePreference {
	device: TinyModelDevice;
	raw: string | undefined;
}

const CPU_DEVICE: TinyModelDevice = "cpu";
const CPU_ONLY_ORDER: readonly TinyModelDevice[] = [CPU_DEVICE];
const DARWIN_WEBGPU_UNSAFE_ORDER: readonly TinyModelDevice[] = [CPU_DEVICE];

const DEVICE_VALUES: Record<TinyModelDevice, true> = {
	auto: true,
	gpu: true,
	cpu: true,
	wasm: true,
	webgpu: true,
	cuda: true,
	dml: true,
	coreml: true,
	webnn: true,
	"webnn-npu": true,
	"webnn-gpu": true,
	"webnn-cpu": true,
};

function usesDarwinWorkerWebGpu(device: TinyModelDevice): boolean {
	return process.platform === "darwin" && (device === "gpu" || device === "webgpu" || device === "auto");
}

export function normalizeTinyModelDevice(value: string | undefined): TinyModelDevice | undefined {
	const raw = value?.trim().toLowerCase();
	if (!raw) return undefined;
	if (raw === "metal") return "webgpu";
	if (raw in DEVICE_VALUES) return raw as TinyModelDevice;
	throw new Error(
		`不支持的 PI_TINY_DEVICE=${JSON.stringify(value)}。请使用 cpu、gpu、metal、webgpu、auto、cuda、dml、coreml、wasm、webnn、webnn-gpu、webnn-cpu 或 webnn-npu。`,
	);
}

export function resolveTinyModelDevicePreference(
	value: string | undefined = $env.PI_TINY_DEVICE,
): TinyModelDevicePreference {
	return {
		device: normalizeTinyModelDevice(value) ?? CPU_DEVICE,
		raw: value,
	};
}

export function tinyModelDeviceLoadOrder(preference: TinyModelDevicePreference): readonly TinyModelDevice[] {
	if (preference.device === CPU_DEVICE) return CPU_ONLY_ORDER;
	if (usesDarwinWorkerWebGpu(preference.device)) return DARWIN_WEBGPU_UNSAFE_ORDER;
	return [preference.device, CPU_DEVICE];
}

/** Sentinel `providers.tinyModelDevice` value meaning "use the built-in CPU default". */
export const TINY_MODEL_DEVICE_DEFAULT = "default";

/** Accepted values for the `providers.tinyModelDevice` setting (validation + UI). */
export const TINY_MODEL_DEVICE_SETTING_VALUES = [
	TINY_MODEL_DEVICE_DEFAULT,
	"gpu",
	"cpu",
	"metal",
	"webgpu",
	"cuda",
	"dml",
	"coreml",
	"auto",
	"wasm",
	"webnn",
	"webnn-gpu",
	"webnn-cpu",
	"webnn-npu",
] as const;

/** Submenu metadata for the `providers.tinyModelDevice` setting. */
export const TINY_MODEL_DEVICE_SETTING_OPTIONS = [
	{ value: "default", label: "默认", description: "仅 CPU 推理" },
	{ value: "gpu", label: "GPU", description: "加速提供程序(WebGPU/Metal、CUDA 或 DirectML)" },
	{ value: "cpu", label: "CPU", description: "仅 CPU 推理" },
	{ value: "metal", label: "Metal", description: "Apple GPU 的 WebGPU 别名" },
	{ value: "webgpu", label: "WebGPU", description: "WebGPU/Metal 后端" },
	{ value: "cuda", label: "CUDA", description: "NVIDIA CUDA(Linux x64)" },
	{ value: "dml", label: "DirectML", description: "DirectML 后端(Windows)" },
	{ value: "coreml", label: "CoreML", description: "Apple CoreML(可选;可能加载失败)" },
	{ value: "auto", label: "自动", description: "让 ONNX Runtime 自动选择提供程序" },
	{ value: "wasm", label: "WASM", description: "WebAssembly 后端" },
	{ value: "webnn", label: "WebNN", description: "WebNN 后端" },
	{ value: "webnn-gpu", label: "WebNN GPU", description: "WebNN GPU 设备" },
	{ value: "webnn-cpu", label: "WebNN CPU", description: "WebNN CPU 设备" },
	{ value: "webnn-npu", label: "WebNN NPU", description: "WebNN NPU 设备" },
] as const satisfies ReadonlyArray<{
	value: (typeof TINY_MODEL_DEVICE_SETTING_VALUES)[number];
	label: string;
	description: string;
}>;

/**
 * Map a `providers.tinyModelDevice` setting value onto a `PI_TINY_DEVICE` env
 * value for the worker. Returns `undefined` for the default sentinel so the
 * worker keeps its built-in CPU default; the worker still validates the
 * forwarded value via {@link normalizeTinyModelDevice}.
 */
export function tinyModelDeviceSettingToEnv(value: string | undefined): string | undefined {
	if (!value || value === TINY_MODEL_DEVICE_DEFAULT) return undefined;
	return value;
}
