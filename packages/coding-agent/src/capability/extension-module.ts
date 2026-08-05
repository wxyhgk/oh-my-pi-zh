/**
 * Extension Modules Capability
 *
 * TypeScript/JavaScript extension modules loaded by the extension system.
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A loaded extension module.
 */
export interface ExtensionModule {
	/** Extension module name (derived from path) */
	name: string;
	/** Absolute path to extension entrypoint */
	path: string;
	/** Source level */
	level: "user" | "project";
	/** Source metadata */
	_source: SourceMeta;
}

export const extensionModuleCapability = defineCapability<ExtensionModule>({
	id: "extension-modules",
	displayName: "扩展模块",
	description: "由扩展系统加载的 TypeScript/JavaScript 扩展模块",
	key: ext => ext.name,
	toExtensionId: ext => `extension-module:${ext.name}`,
	validate: ext => {
		if (!ext.name) return "缺少名称";
		if (!ext.path) return "缺少路径";
		return undefined;
	},
});
