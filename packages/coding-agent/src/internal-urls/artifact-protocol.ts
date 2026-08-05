/**
 * Protocol handler for artifact:// URLs.
 *
 * Resolves artifact IDs against the artifacts directories of every active
 * session. Unlike agent://, artifacts are raw text with no JSON extraction.
 *
 * URL form:
 * - artifact://<id> - Full artifact content
 *
 * Pagination is handled by the read tool via offset/limit parameters.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { artifactsDirsFromRegistry } from "./registry-helpers";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

const MAX_INLINE_ARTIFACT_BYTES = 8 * 1024 * 1024;

/** Filesystem location for a session artifact, resolved without materializing its content. */
export interface ResolvedArtifactFile {
	id: string;
	path: string;
	size: number;
}

function parseArtifactId(url: InternalUrl): string {
	const id = url.rawHost || url.hostname;
	if (!id) {
		throw new Error("artifact:// URL 需要数字 ID:artifact://0");
	}
	if (!/^\d+$/.test(id)) {
		throw new Error(`artifact:// ID 必须是数字,实际为:${id}`);
	}
	return id;
}

/** Resolve an `artifact://` URL to its backing file without reading artifact bytes. */
export async function resolveArtifactFile(url: InternalUrl, context?: ResolveContext): Promise<ResolvedArtifactFile> {
	const id = parseArtifactId(url);

	// Artifact ids are per-session counters; in multi-session hosts the same
	// id exists in several dirs. Pin resolution to the calling session's
	// artifacts dir first so `artifact://3` means *this* session's #3.
	const dirs = artifactsDirsFromRegistry();
	const pinnedDir = context?.localProtocolOptions?.getArtifactsDir?.() ?? null;
	if (pinnedDir) {
		const pinnedIndex = dirs.indexOf(pinnedDir);
		if (pinnedIndex >= 0) dirs.splice(pinnedIndex, 1);
		dirs.unshift(pinnedDir);
	}

	if (dirs.length === 0) {
		throw new Error("无会话 - 产物不可用");
	}

	let foundPath: string | undefined;
	let anyDirExists = false;
	const availableIds = new Set<string>();

	for (const dir of dirs) {
		let files: string[];
		try {
			files = await fs.readdir(dir);
			anyDirExists = true;
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}
		const match = files.find(f => f.startsWith(`${id}.`));
		if (match) {
			foundPath = path.join(dir, match);
			break;
		}
		for (const f of files) {
			const m = f.match(/^(\d+)\./);
			if (m) availableIds.add(m[1]);
		}
	}

	if (!anyDirExists) {
		throw new Error("未找到产物目录");
	}

	if (!foundPath) {
		const sorted = [...availableIds].sort((a, b) => Number(a) - Number(b));
		const availableStr = sorted.length > 0 ? sorted.join(", ") : "无";
		throw new Error(`未找到产物 ${id}。可用:${availableStr}`);
	}

	const stat = await Bun.file(foundPath).stat();
	if (stat.isDirectory()) {
		throw new Error(`产物 ${id} 解析为目录而非文件`);
	}
	return { id, path: foundPath, size: stat.size };
}

export class ArtifactProtocolHandler implements ProtocolHandler {
	readonly scheme = "artifact";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const artifact = await resolveArtifactFile(url, context);

		// Path-only callers (search/grep, bash URL expansion) never touch the
		// artifact bytes. Return the resource shape so those flows keep working
		// on artifacts of any size — only content materialization is gated.
		if (context?.pathOnly) {
			return {
				url: url.href,
				content: "",
				contentType: "text/plain",
				size: artifact.size,
				sourcePath: artifact.path,
			};
		}

		if (artifact.size > MAX_INLINE_ARTIFACT_BYTES) {
			throw new Error(
				`产物 ${artifact.id} 大小为 ${artifact.size} 字节,无法进行完整内部解析。请使用 read 选择器,如 artifact://${artifact.id}:1-3000 或 artifact://${artifact.id}:raw:1-3000;搜索/复制请使用产物文件路径:${artifact.path}`,
			);
		}

		const content = await Bun.file(artifact.path).text();
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: artifact.size,
			sourcePath: artifact.path,
		};
	}

	async complete(): Promise<UrlCompletion[]> {
		const ids = new Set<string>();
		for (const dir of artifactsDirsFromRegistry()) {
			let files: string[];
			try {
				files = await fs.readdir(dir);
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			for (const f of files) {
				const m = f.match(/^(\d+)\./);
				if (m) ids.add(m[1]!);
			}
		}
		return [...ids].sort((a, b) => Number(a) - Number(b)).map(value => ({ value }));
	}
}
