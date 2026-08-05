/**
 * Settings Capability
 *
 * Configuration settings from various sources (JSON, TOML, etc.)
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A settings file.
 */
export interface Settings {
	/** Absolute path to settings file */
	path: string;
	/** Parsed settings data */
	data: Record<string, unknown>;
	/** Source level */
	level: "user" | "project";
	/** Source metadata */
	_source: SourceMeta;
}

export const settingsCapability = defineCapability<Settings>({
	id: "settings",
	displayName: "设置",
	description: "来自各来源的配置设置",
	// Settings are merged, not deduplicated by key
	key: () => undefined,
	validate: settings => {
		if (!settings.path) return "缺少路径";
		if (!settings.data || typeof settings.data !== "object") return "缺少或无效的数据";
		return undefined;
	},
});
