/**
 * SSH Hosts Capability
 *
 * Canonical shape for SSH host entries, regardless of source format.
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * Canonical SSH host entry.
 */
export interface SSHHost {
	/** Host name (config key) */
	name: string;
	/** Host address or DNS name */
	host: string;
	/** Optional username override */
	username?: string;
	/** Optional port override */
	port?: number;
	/** Optional identity key path */
	keyPath?: string;
	/** Optional host description */
	description?: string;
	/** Optional compatibility mode flag */
	compat?: boolean;
	/** Source metadata (added by loader) */
	_source: SourceMeta;
}

export const sshCapability = defineCapability<SSHHost>({
	id: "ssh",
	displayName: "SSH 主机",
	description: "用于远程命令执行的 SSH 主机条目",
	key: host => host.name,
	validate: host => {
		if (!host.name) return "缺少名称";
		if (!host.host) return "缺少主机";
		return undefined;
	},
});
