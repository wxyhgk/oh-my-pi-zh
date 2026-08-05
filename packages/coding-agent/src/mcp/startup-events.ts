import { sanitizeText } from "@wxyhgk/pi-utils";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";

export const MCP_CONNECTION_STATUS_EVENT_CHANNEL = "mcp:connection-status";

export type McpConnectionStatusEvent =
	| { type: "connecting"; serverNames: string[] }
	| { type: "connected"; serverName: string }
	| { type: "failed"; serverName: string; error: string };

export type McpConnectionStatusSnapshot = {
	pendingServers: readonly string[];
	connectedServers: readonly string[];
	failedServers: readonly { serverName: string; error: string }[];
};

function sanitizeMcpStatusText(value: string, maxWidth: number): string {
	const text = shortenEmbeddedPaths(
		replaceTabs(sanitizeText(value))
			.replace(/[\r\n]+/g, " ")
			.trim(),
	);
	return truncateToWidth(text.length > 0 ? text : "(未命名)", maxWidth);
}

function sanitizeMcpServerName(serverName: string): string {
	return sanitizeMcpStatusText(serverName, TRUNCATE_LENGTHS.SHORT);
}

function formatServerList(serverNames: readonly string[]): string {
	return serverNames.map(sanitizeMcpServerName).join(", ");
}

function sanitizeMcpStatusError(error: string): string {
	return sanitizeMcpStatusText(error, TRUNCATE_LENGTHS.CONTENT);
}

function shortenEmbeddedPaths(text: string): string {
	return text
		.split(" ")
		.map(segment => {
			const leading = segment.match(/^[("'`[]*/)?.[0] ?? "";
			const trailing = segment.match(/[)"'`,.;:\]]*$/)?.[0] ?? "";
			const end = segment.length - trailing.length;
			if (leading.length >= end) return segment;
			return `${leading}${shortenPath(segment.slice(leading.length, end))}${trailing}`;
		})
		.join(" ");
}

export function formatMCPConnectingMessage(serverNames: readonly string[]): string {
	return `正在连接 MCP 服务器: ${formatServerList(serverNames)}…`;
}

function formatFailedServer({ serverName, error }: { serverName: string; error: string }): string {
	return `${sanitizeMcpServerName(serverName)}: ${sanitizeMcpStatusError(error)}`;
}

export function formatMCPConnectionStatusMessage(snapshot: McpConnectionStatusSnapshot): string {
	const { pendingServers, connectedServers, failedServers } = snapshot;
	if (pendingServers.length > 0) {
		if (connectedServers.length === 0 && failedServers.length === 0) {
			return formatMCPConnectingMessage(pendingServers);
		}
		const parts: string[] = [];
		if (connectedServers.length > 0) {
			parts.push(`已连接: ${formatServerList(connectedServers)}。`);
		}
		if (failedServers.length > 0) {
			parts.push(`失败: ${failedServers.map(formatFailedServer).join("; ")}。`);
		}
		parts.push(`仍在连接: ${formatServerList(pendingServers)}…`);
		return parts.join(" ");
	}
	if (failedServers.length > 0) {
		const failureText = failedServers.map(formatFailedServer).join("; ");
		if (connectedServers.length === 0) {
			return `MCP 服务器连接失败: ${failureText}`;
		}
		return `MCP 连接完成但存在失败。已连接: ${formatServerList(connectedServers)}。失败: ${failureText}`;
	}
	if (connectedServers.length > 0) {
		return `已连接到 MCP 服务器: ${formatServerList(connectedServers)}。`;
	}
	return "";
}

function isRecord(data: unknown): data is Record<string, unknown> {
	return typeof data === "object" && data !== null;
}

function isStringArray(data: unknown): data is string[] {
	return Array.isArray(data) && data.every(item => typeof item === "string");
}

/**
 * Runtime validator for the cross-module event payload. The event bus is
 * untyped at runtime, so the subscriber verifies the shape before formatting
 * rather than trusting a cast — a malformed emit is ignored instead of throwing.
 */
export function isMcpConnectionStatusEvent(data: unknown): data is McpConnectionStatusEvent {
	if (!isRecord(data) || typeof data.type !== "string") return false;
	switch (data.type) {
		case "connecting":
			return isStringArray(data.serverNames);
		case "connected":
			return typeof data.serverName === "string";
		case "failed":
			return typeof data.serverName === "string" && typeof data.error === "string";
		default:
			return false;
	}
}
