import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, WriteContext } from "./types";

/** Canonical prefix for virtual tool-device URLs. */
export const XD_URL_PREFIX = "xd://";

/**
 * Parse an `xd://` URL into its device target.
 * Returns `null` for other or malformed URLs and `name: null` for the root.
 */
export function parseXdUrl(input: string): { name: string | null } | null {
	const trimmed = input.trim();
	if (!trimmed.toLowerCase().startsWith(XD_URL_PREFIX)) return null;
	const name = trimmed.slice(XD_URL_PREFIX.length);
	if (name.length === 0) return { name: null };
	if (/[/?#]/.test(name)) return null;
	return { name };
}

/** Whether a streaming path prefix could still become an `xd://` URL. */
export function couldBecomeXdUrl(partialPath: string): boolean {
	if (partialPath.length <= XD_URL_PREFIX.length) {
		return XD_URL_PREFIX.startsWith(partialPath.toLowerCase());
	}
	return partialPath.toLowerCase().startsWith(XD_URL_PREFIX);
}

/** Routes session-bound virtual tool devices through `xd://` URLs. */
export class XdProtocolHandler implements ProtocolHandler {
	readonly scheme = "xd";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const target = parseXdUrl(url.href);
		if (!target) throw new Error(`无效的 xd:// URL:${url.href}。请使用 xd:// 或 xd://<tool>。`);
		if (!context?.xd) throw new Error("此会话中未挂载 xd://。");
		const content = await context.xd.read(target.name);
		return { url: url.href, content, contentType: "text/plain", size: Buffer.byteLength(content) };
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<void> {
		const target = parseXdUrl(url.href);
		if (!target) throw new Error(`无效的 xd:// URL:${url.href}。请使用 xd://<tool>。`);
		if (!context?.xd) throw new Error("此会话中未挂载 xd://。");
		await context.xd.write(target.name, content);
	}
}
