/**
 * Protocol handler for omp:// URLs.
 *
 * Serves statically embedded documentation files bundled at build time.
 *
 * URL forms:
 * - omp:// - Lists all available documentation files
 * - omp://<file>.md - Reads a specific documentation file
 */
import * as path from "node:path";
import { getDocFilenames, getEmbeddedDoc } from "./docs-index";
import type { InternalResource, InternalUrl, ProtocolHandler, UrlCompletion } from "./types";

/**
 * Handler for omp:// URLs.
 *
 * Resolves documentation file names to their content, or lists available docs.
 */
export class OmpProtocolHandler implements ProtocolHandler {
	readonly scheme = "omp";
	readonly immutable = true;

	async resolve(url: InternalUrl): Promise<InternalResource> {
		// Extract filename from host + path
		const host = url.rawHost || url.hostname;
		const pathname = url.rawPathname ?? url.pathname;
		const filename = host ? (pathname && pathname !== "/" ? host + pathname : host) : "";

		if (!filename) {
			return this.#listDocs(url);
		}

		return this.#readDoc(filename, url);
	}

	async complete(): Promise<UrlCompletion[]> {
		return getDocFilenames().map(value => ({ value }));
	}

	async #listDocs(url: InternalUrl): Promise<InternalResource> {
		const filenames = getDocFilenames();
		if (filenames.length === 0) {
			throw new Error("未找到任何文档文件");
		}

		const listing = filenames.map(f => `- [${f}](omp://${f})`).join("\n");
		const content = `# 文档\n\n可用文档 ${filenames.length} 个:\n\n${listing}\n`;

		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
		};
	}

	async #readDoc(filename: string, url: InternalUrl): Promise<InternalResource> {
		// Validate: no traversal, no absolute paths
		if (path.isAbsolute(filename)) {
			throw new Error("omp:// URL 不允许使用绝对路径");
		}

		const normalized = path.posix.normalize(filename.replaceAll("\\", "/"));
		if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
			throw new Error("omp:// URL 不允许路径穿越 (..)");
		}

		const docPath =
			normalized === "docs" ? "" : normalized.startsWith("docs/") ? normalized.slice("docs/".length) : normalized;
		if (!docPath) {
			return this.#listDocs(url);
		}

		const content = await getEmbeddedDoc(docPath);
		if (content === undefined) {
			const lookup = docPath.replace(/\.md$/, "");
			const suggestions = getDocFilenames()
				.filter(f => f.includes(lookup) || lookup.includes(f.replace(/\.md$/, "")))
				.slice(0, 5);
			const suffix =
				suggestions.length > 0
					? `\n您是不是想找:${suggestions.join(", ")}`
					: "\n使用 omp:// 可列出可用文件。";
			throw new Error(`未找到文档文件:${filename}${suffix}`);
		}

		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
		};
	}
}
