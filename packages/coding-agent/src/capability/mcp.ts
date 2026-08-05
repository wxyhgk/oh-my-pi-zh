/**
 * MCP (Model Context Protocol) Servers Capability
 *
 * Canonical shape for MCP server configurations, regardless of source format.
 * All providers translate their native format to this shape.
 */

import type { MCPRequestIdFormat } from "../mcp/types";
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * Canonical MCP server configuration.
 */
export interface MCPServer {
	/** Server name (unique key) */
	name: string;
	/** Whether this server is enabled (default: true) */
	enabled?: boolean;
	/** Connection timeout in milliseconds */
	timeout?: number;
	/** Encoding for outgoing JSON-RPC request ids (default: `"number"`) */
	requestIdFormat?: MCPRequestIdFormat;
	/** Command to run (for stdio transport) */
	command?: string;
	/** Command arguments */
	args?: string[];
	/** Environment variables */
	env?: Record<string, string>;
	/** Working directory for stdio transport */
	cwd?: string;
	/** URL (for HTTP/SSE transport) */
	url?: string;
	/** HTTP headers (for HTTP transport) */
	headers?: Record<string, string>;
	/** Authentication configuration */
	auth?: {
		type: "oauth" | "apikey";
		credentialId?: string;
		tokenUrl?: string;
		clientId?: string;
		clientSecret?: string;
		resource?: string;
	};
	/** OAuth configuration (clientId, clientSecret, redirectUri, callbackPort, callbackPath, prompt) for servers requiring explicit client credentials */
	oauth?: {
		clientId?: string;
		clientSecret?: string;
		redirectUri?: string;
		callbackPort?: number;
		callbackPath?: string;
		prompt?: string;
	};
	/** Transport type */
	transport?: "stdio" | "sse" | "http";
	/** Source metadata (added by loader) */
	_source: SourceMeta;
}

/** Compare the transport inputs that determine which MCP endpoint gets connected. */
function isSameMCPConnection(left: MCPServer, right: MCPServer): boolean {
	if (!Bun.deepEquals(left.auth, right.auth) || !Bun.deepEquals(left.oauth, right.oauth)) return false;
	// Normalize against the allocator's own default so an explicit "number" is
	// equivalent to leaving the option unset, not a distinct connection.
	if ((left.requestIdFormat ?? "number") !== (right.requestIdFormat ?? "number")) return false;

	const leftTransport = left.transport ?? (left.command ? "stdio" : left.url ? "http" : "stdio");
	const rightTransport = right.transport ?? (right.command ? "stdio" : right.url ? "http" : "stdio");
	if (leftTransport !== rightTransport) return false;

	if (leftTransport === "stdio") {
		return (
			left.command === right.command &&
			Bun.deepEquals(left.args, right.args) &&
			Bun.deepEquals(left.env, right.env) &&
			left.cwd === right.cwd
		);
	}

	return left.url === right.url && Bun.deepEquals(left.headers, right.headers);
}

export const mcpCapability = defineCapability<MCPServer>({
	id: "mcps",
	displayName: "MCP 服务器",
	description: "用于外部工具集成的模型上下文协议(MCP)服务器配置",
	key: server => server.name,
	equivalent: isSameMCPConnection,
	toExtensionId: server => `mcp:${server.name}`,
	validate: server => {
		if (!server.name) return "缺少服务器名称";
		if (!server.command && !server.url) return "必须提供 command 或 url";

		// Validate transport-endpoint pairing
		if (server.transport === "stdio" && !server.command) {
			return "stdio 传输需要 command 字段";
		}
		if ((server.transport === "http" || server.transport === "sse") && !server.url) {
			return "http/sse 传输需要 url 字段";
		}

		return undefined;
	},
});
