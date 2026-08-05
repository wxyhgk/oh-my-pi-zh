import { MCPManager } from "../mcp/manager";
import type { MCPResourceReadResult } from "../mcp/types";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getUriTemplateMatchScore(
	uri: string,
	uriTemplate: string,
): { literalChars: number; expressionCount: number } | undefined {
	const expressionPattern = /\{[^}]+\}/g;
	const literalSegments = uriTemplate.split(expressionPattern);
	const expressionCount = (uriTemplate.match(expressionPattern) ?? []).length;
	const pattern = literalSegments.map(escapeRegex).join("(.*?)");
	const regex = new RegExp(`^${pattern}$`);
	if (!regex.test(uri)) return undefined;
	const literalChars = literalSegments.reduce((total, segment) => total + segment.length, 0);
	return { literalChars, expressionCount };
}

function extractResourceUri(url: InternalUrl): string {
	const scheme = url.protocol.replace(/:$/, "").toLowerCase();
	if (scheme !== "mcp") {
		// Server-advertised native URI (hierarchical or opaque). Preserve the
		// input byte-for-byte: `resolveTargetServer` matches by exact string
		// equality, so e.g. `catalog://root/` must keep its trailing slash.
		return url.rawHref ?? url.href;
	}
	// Legacy `mcp://<resource-uri>` wrapper: reconstruct the wrapped URI and
	// elide a bare trailing `/` that URL parsing adds to host-only forms.
	const host = url.rawHost || url.hostname;
	const rawPathname = url.rawPathname ?? url.pathname;
	const hasPath = rawPathname && rawPathname !== "/";
	const uri = `${host}${hasPath ? rawPathname : ""}${url.search}${url.hash}`.trim();
	if (!uri) {
		throw new Error("mcp:// URL 需要资源 URI:mcp://<resource-uri>");
	}
	return uri;
}

function resolveTargetServer(mcpManager: MCPManager, uri: string): string | undefined {
	const servers = mcpManager.getConnectedServers();
	for (const name of servers) {
		const serverResources = mcpManager.getServerResources(name);
		if (serverResources?.resources.some(r => r.uri === uri)) {
			return name;
		}
	}

	let bestTemplateMatch:
		| {
				serverName: string;
				literalChars: number;
				expressionCount: number;
				serverIndex: number;
				templateIndex: number;
		  }
		| undefined;

	for (const [serverIndex, name] of servers.entries()) {
		const serverResources = mcpManager.getServerResources(name);
		if (!serverResources) continue;

		for (const [templateIndex, template] of serverResources.templates.entries()) {
			const match = getUriTemplateMatchScore(uri, template.uriTemplate);
			if (!match) continue;

			const isBetterMatch =
				!bestTemplateMatch ||
				match.literalChars > bestTemplateMatch.literalChars ||
				(match.literalChars === bestTemplateMatch.literalChars &&
					(match.expressionCount < bestTemplateMatch.expressionCount ||
						(match.expressionCount === bestTemplateMatch.expressionCount &&
							(serverIndex < bestTemplateMatch.serverIndex ||
								(serverIndex === bestTemplateMatch.serverIndex &&
									templateIndex < bestTemplateMatch.templateIndex)))));

			if (isBetterMatch) {
				bestTemplateMatch = {
					serverName: name,
					literalChars: match.literalChars,
					expressionCount: match.expressionCount,
					serverIndex,
					templateIndex,
				};
			}
		}
	}

	return bestTemplateMatch?.serverName;
}

function formatAvailableResources(mcpManager: MCPManager): string {
	const available = mcpManager
		.getConnectedServers()
		.flatMap(name => {
			const serverResources = mcpManager.getServerResources(name);
			if (!serverResources) return [];
			const concrete = serverResources.resources.map(r => `  ${r.uri} (${name})`);
			const templates = serverResources.templates.map(t => `  ${t.uriTemplate} (${name}, template)`);
			return [...concrete, ...templates];
		})
		.join("\n");
	return available || "  (无)";
}

/**
 * Protocol handler for MCP resources.
 *
 * URL forms:
 * - mcp://<resource-uri> (e.g. mcp://test://notes, mcp://ibkr://portfolio/positions)
 * - A resource's native URI when its scheme has no OMP handler (e.g. ags://capabilities/current-host)
 */
export class McpProtocolHandler implements ProtocolHandler {
	readonly scheme = "mcp";
	readonly immutable = true;

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const mcpManager = MCPManager.instance();
		if (!mcpManager) {
			throw new Error("没有可用的 MCP 管理器。可能尚未配置 MCP 服务器。");
		}

		const uri = extractResourceUri(url);
		let targetServer = resolveTargetServer(mcpManager, uri);
		if (!targetServer) {
			await Promise.allSettled(mcpManager.getConnectedServers().map(name => mcpManager.ensureServerResources(name)));
			targetServer = resolveTargetServer(mcpManager, uri);
		}
		if (!targetServer) {
			throw new Error(`没有 MCP 服务器提供资源 "${uri}"。\n\n可用资源:\n${formatAvailableResources(mcpManager)}`);
		}

		let result: MCPResourceReadResult | undefined;
		try {
			result = await mcpManager.readServerResource(targetServer, uri);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`MCP 资源读取错误:${message}`);
		}

		if (!result) {
			throw new Error(`服务器 "${targetServer}" 未返回 "${uri}" 的内容。`);
		}

		const textParts: string[] = [];
		for (const item of result.contents) {
			if (item.text !== undefined && item.text !== null) {
				textParts.push(item.text);
			} else if (item.blob) {
				textParts.push(`[二进制内容:${item.mimeType ?? "未知"},base64 长度 ${item.blob.length}]`);
			}
		}

		const content = textParts.length > 0 ? textParts.join("\n---\n") : "(空资源)";
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: Buffer.byteLength(content, "utf-8"),
			notes: [`MCP 服务器:${targetServer}`],
		};
	}
}
