import { describe, expect, it, vi } from "bun:test";
import { executeAcpBuiltinSlashCommand } from "@wxyhgk/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@wxyhgk/pi-coding-agent/slash-commands/types";
import type { DesktopCapabilities } from "@wxyhgk/pi-natives";

const capabilities: DesktopCapabilities = {
	backend: "quartz",
	displayServer: "CoreGraphics",
	capture: true,
	input: true,
	ax: true,
	backgroundWindowInput: true,
	deliveryModes: ["background", "foreground"],
	capturePermission: "granted",
	inputPermission: "granted",
	axPermission: "granted",
	displayCount: 2,
};

function acpRuntime(options?: {
	enabled?: boolean;
	applyResult?: boolean;
	supportsComputerUse?: boolean;
	codex?: boolean;
	capabilities?: DesktopCapabilities;
}) {
	const store = {
		"computer.enabled": options?.enabled ?? false,
		"computer.display": "all",
		"computer.maxWidth": 1920,
		"computer.maxHeight": 1200,
	};
	const get = vi.fn((path: string) => store[path as keyof typeof store]);
	const override = vi.fn((path: string, value: boolean) => {
		if (path === "computer.enabled") store[path] = value;
	});
	const set = vi.fn();
	const setComputerToolEnabled = vi.fn(async () => options?.applyResult ?? true);
	const getEnabledToolNames = vi.fn(() => (store["computer.enabled"] ? ["computer"] : []));
	const getToolByName = vi.fn(() =>
		store["computer.enabled"]
			? {
					name: "computer",
					capabilities: async (): Promise<DesktopCapabilities | undefined> => options?.capabilities,
				}
			: undefined,
	);
	const output = vi.fn();
	const model = options?.codex
		? {
				provider: "openai-codex",
				id: "gpt-5.6-sol",
				api: "openai-codex-responses",
				supportsComputerUse: options.supportsComputerUse ?? false,
			}
		: {
				provider: "google",
				id: "gemini-2.5-flash",
				api: "google-generative-ai",
				supportsComputerUse: options?.supportsComputerUse ?? false,
			};
	const runtime = {
		session: {
			settings: { get, override, set },
			setComputerToolEnabled,
			getEnabledToolNames,
			model,
			getToolByName,
		},
		output,
	} as unknown as SlashCommandRuntime;
	return { override, set, setComputerToolEnabled, output, runtime, store };
}

const googleStatus =
	"计算机使用:已启用 · 工具:激活 · 暴露:function · 模型:google/gemini-2.5-flash · 已配置:display=all, maxWidth=1920, maxHeight=1200 · 能力:会话未启动";
const codexStatus =
	"计算机使用:已启用 · 工具:激活 · 暴露:function · 模型:openai-codex/gpt-5.6-sol · 已配置:display=all, maxWidth=1920, maxHeight=1200 · 能力:会话未启动";

describe("/computer slash command", () => {
	it("toggles a disabled session on and reports that its lazy session has not started", async () => {
		const h = acpRuntime({ enabled: false });
		expect(await executeAcpBuiltinSlashCommand("/computer", h.runtime)).toEqual({ consumed: true });
		expect(h.setComputerToolEnabled).toHaveBeenCalledWith(true);
		expect(h.override).toHaveBeenCalledWith("computer.enabled", true);
		expect(h.set).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith(`当前会话已启用计算机使用。${googleStatus}`);
	});

	it("toggles an enabled session off", async () => {
		const h = acpRuntime({ enabled: true });
		await executeAcpBuiltinSlashCommand("/computer", h.runtime);
		expect(h.setComputerToolEnabled).toHaveBeenCalledWith(false);
		expect(h.override).toHaveBeenCalledWith("computer.enabled", false);
		expect(h.output).toHaveBeenCalledWith("当前会话已禁用计算机使用。");
	});

	it("honors explicit on and off regardless of current state", async () => {
		const on = acpRuntime({ enabled: true });
		await executeAcpBuiltinSlashCommand("/computer on", on.runtime);
		expect(on.setComputerToolEnabled).toHaveBeenCalledWith(true);
		expect(on.override).toHaveBeenCalledWith("computer.enabled", true);

		const off = acpRuntime({ enabled: false });
		await executeAcpBuiltinSlashCommand("/computer off", off.runtime);
		expect(off.setComputerToolEnabled).toHaveBeenCalledWith(false);
		expect(off.override).toHaveBeenCalledWith("computer.enabled", false);
	});

	it("reports status without touching the tool slate or settings", async () => {
		const h = acpRuntime({ enabled: true });
		await executeAcpBuiltinSlashCommand("/computer status", h.runtime);
		expect(h.setComputerToolEnabled).not.toHaveBeenCalled();
		expect(h.override).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith(googleStatus);
	});

	it("reports configured values and capabilities after the session starts", async () => {
		const h = acpRuntime({ enabled: true, capabilities });
		h.store["computer.display"] = "display-2";
		h.store["computer.maxWidth"] = 1600;
		h.store["computer.maxHeight"] = 900;
		await executeAcpBuiltinSlashCommand("/computer status", h.runtime);
		expect(h.output).toHaveBeenCalledWith(
			"计算机使用:已启用 · 工具:激活 · 暴露:function · 模型:google/gemini-2.5-flash · 已配置:display=display-2, maxWidth=1600, maxHeight=900 · 能力:backend=quartz/CoreGraphics, capture=true (granted), input=true (granted), ax=true (granted), backgroundWindowInput=true, deliveryModes=background,foreground",
		);
	});

	it("reports both subscription and native-capable Codex exposure as a function", async () => {
		for (const supportsComputerUse of [false, true]) {
			const h = acpRuntime({ enabled: true, codex: true, supportsComputerUse });
			await executeAcpBuiltinSlashCommand("/computer status", h.runtime);
			expect(h.output).toHaveBeenCalledWith(codexStatus);
		}
	});

	it("leaves the override untouched when the session cannot build the tool", async () => {
		const h = acpRuntime({ enabled: false, applyResult: false });
		await executeAcpBuiltinSlashCommand("/computer on", h.runtime);
		expect(h.setComputerToolEnabled).toHaveBeenCalledWith(true);
		expect(h.override).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith("当前会话不支持计算机使用。");
	});

	it("rejects unknown arguments with usage", async () => {
		const h = acpRuntime();
		await executeAcpBuiltinSlashCommand("/computer bogus", h.runtime);
		expect(h.setComputerToolEnabled).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith("用法:/computer [on|off|status]");
	});
});
