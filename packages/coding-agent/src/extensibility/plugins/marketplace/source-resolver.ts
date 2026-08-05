/**
 * Source resolver for marketplace plugin entries.
 *
 * Resolves plugin sources to absolute local directory paths:
 *   - Relative string "./plugins/foo" → path within marketplace clone
 *   - { source: "url", url: "https://...git" } → git clone
 *   - { source: "github", repo: "owner/repo" } → git clone from GitHub
 *   - { source: "git-subdir", url: "...", path: "sub/dir" } → git clone + subdir
 *   - { source: "npm", ... } → not yet supported
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { isEnoent, pathIsWithin } from "@wxyhgk/pi-utils";
import * as git from "../../../utils/git";

import type { MarketplaceCatalogMetadata, MarketplacePluginEntry, PluginSource } from "./types";

export interface ResolveContext {
	/** Absolute path to the cloned/local marketplace directory. Required for relative sources. */
	marketplaceClonePath?: string;
	/** Catalog metadata — used for `pluginRoot` prepend. */
	catalogMetadata?: MarketplaceCatalogMetadata;
	/** Scratch directory for sources that require cloning or extraction. */
	tmpDir: string;
}

/**
 * Resolve a plugin source to an absolute local directory path.
 *
 * The resolved path is verified to exist on disk.
 */
export async function resolvePluginSource(
	entry: MarketplacePluginEntry,
	context: ResolveContext,
): Promise<{ dir: string; tempCloneRoot?: string }> {
	const { source } = entry;

	if (typeof source === "string") {
		return resolveRelativeSource(source, context);
	}

	return resolveObjectSource(source, context);
}

// ── Relative string source ("./plugins/foo") ────────────────────────

async function resolveRelativeSource(
	source: string,
	context: ResolveContext,
): Promise<{ dir: string; tempCloneRoot?: string }> {
	if (!source.startsWith("./")) {
		throw new Error(`相对插件源路径必须以 "./" 开头 — 实际为:“${source}”`);
	}

	if (!context.marketplaceClonePath) {
		throw new Error(`无法解析相对源 “${source}”:需要 marketplaceClonePath`);
	}

	// If pluginRoot is set, prepend it to the path segment after "./"
	const pluginRoot = context.catalogMetadata?.pluginRoot;
	const relativePath = pluginRoot ? `./${path.join(pluginRoot, source.slice(2))}` : source;

	// Resolve against marketplace root (not the .claude-plugin/ catalog subdirectory)
	const resolved = path.resolve(context.marketplaceClonePath, relativePath);

	if (!pathIsWithin(context.marketplaceClonePath, resolved)) {
		throw new Error(
			`插件源 “${source}” 解析到了市场根目录之外 (“${context.marketplaceClonePath}”)`,
		);
	}

	await verifyDirExists(resolved, `插件源目录不存在:“${resolved}”`);
	return { dir: resolved };
}

// ── Object source variants ──────────────────────────────────────────

async function resolveObjectSource(
	source: Exclude<PluginSource, string>,
	context: ResolveContext,
): Promise<{ dir: string; tempCloneRoot?: string }> {
	switch (source.source) {
		case "url": {
			// { source: "url", url: "https://github.com/owner/repo.git" }
			// Despite the name, this is typically a git clone URL
			const targetDir = path.join(context.tmpDir, `plugin-${crypto.randomUUID()}`);
			await git.clone(source.url, targetDir, { ref: source.ref, sha: source.sha });
			return { dir: targetDir, tempCloneRoot: targetDir };
		}

		case "github": {
			// { source: "github", repo: "owner/repo" }
			const url = `https://github.com/${source.repo}.git`;
			const targetDir = path.join(context.tmpDir, `plugin-${crypto.randomUUID()}`);
			await git.clone(url, targetDir, { ref: source.ref, sha: source.sha });
			return { dir: targetDir, tempCloneRoot: targetDir };
		}

		case "git-subdir": {
			// { source: "git-subdir", url: "owner/repo" | "https://...", path: "plugins/foo" }
			const url =
				source.url.includes("://") || source.url.startsWith("git@")
					? source.url
					: `https://github.com/${source.url}.git`;
			const cloneDir = path.join(context.tmpDir, `plugin-repo-${crypto.randomUUID()}`);
			await git.clone(url, cloneDir, { ref: source.ref, sha: source.sha });

			const subdirPath = path.resolve(cloneDir, source.path);
			if (!pathIsWithin(cloneDir, subdirPath)) {
				await fs.rm(cloneDir, { recursive: true, force: true });
				throw new Error(`git-subdir 路径 “${source.path}” 超出了克隆的仓库`);
			}
			try {
				await verifyDirExists(subdirPath, `git-subdir 路径 “${source.path}” 在克隆的仓库中不存在`);
			} catch (err) {
				await fs.rm(cloneDir, { recursive: true, force: true });
				throw err;
			}
			return { dir: subdirPath, tempCloneRoot: cloneDir };
		}

		case "npm":
			throw new Error("尚不支持 npm 插件源。请改用基于 git 的源。");

		default:
			throw new Error(`未知的插件源类型:“${(source as { source: string }).source}”`);
	}
}

// ── Helpers ─────────────────────────────────────────────────────────

async function verifyDirExists(dirPath: string, errorMessage: string): Promise<void> {
	try {
		const stat = await fs.stat(dirPath);
		if (!stat.isDirectory()) {
			throw new Error(errorMessage);
		}
	} catch (err) {
		if (isEnoent(err)) {
			throw new Error(errorMessage);
		}
		throw err;
	}
}
