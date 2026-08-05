/**
 * Cross-process contract for the broker-owned LSP mux daemon.
 *
 * One mux daemon runs per project scope (launched through the same daemon
 * broker that owns the shared Chromium and `hub start` processes). It spawns
 * each language server once and multiplexes every omp instance in the project
 * onto that single server over a local socket. The link speaks plain
 * Content-Length-framed LSP JSON-RPC after a one-request handshake
 * ({@link MUX_CONNECT_METHOD}); everything below is shared by the worker
 * entry (`server.ts`), the client connector (`daemon.ts`), and tests.
 */
import * as path from "node:path";

/** Hidden CLI selector used to re-enter the LSP mux worker. */
export const LSP_MUX_WORKER_ARG = "__omp_worker_lsp_mux";

/** Environment key carrying the socket endpoint the mux must listen on. */
export const LSP_MUX_SOCKET_ENV = "OMP_LSP_MUX_SOCKET";

/** Environment key carrying the canonical project directory the mux serves. */
export const LSP_MUX_PROJECT_DIR_ENV = "OMP_LSP_MUX_PROJECT_DIR";

/** Stable broker daemon name for the shared LSP mux. */
export const LSP_MUX_DAEMON_NAME = "omp.lsp.mux";

/** Broker readiness regex matched against the banner printed by the worker. */
export const LSP_MUX_READY_PATTERN = String.raw`omp lsp mux listening on \S+`;

/** Banner printed on stdout once the mux socket accepts connections. */
export function lspMuxReadyBanner(endpoint: string): string {
	return `omp lsp mux listening on ${endpoint}`;
}

/** Resolve the Unix socket or Windows named pipe for one project scope. */
export function lspMuxEndpoint(projectDir: string, runtimeDir: string): string {
	if (process.platform === "win32") {
		const key = Bun.hash.wyhash(path.resolve(projectDir)).toString(16).padStart(16, "0");
		return `\\\\.\\pipe\\omp-lsp-mux-${key}`;
	}
	return path.join(runtimeDir, "lsp-mux.sock");
}

// =============================================================================
// Mux-private JSON-RPC methods
// =============================================================================

/**
 * First (and only pre-LSP) request on a fresh connection: binds the link to
 * one shared server instance, spawning it on first use. Params:
 * {@link MuxConnectParams}, result: {@link MuxConnectResult}. After the
 * response the link carries ordinary LSP traffic for that server.
 */
export const MUX_CONNECT_METHOD = "omp/muxConnect";

/**
 * Liveness probe answered with {@link MUX_PING_RESULT} without binding the
 * link to a server. Used by the smoke probe and the ensure loop.
 */
export const MUX_PING_METHOD = "omp/muxPing";
export const MUX_PING_RESULT = "pong";

/**
 * Notification on a bound link: kill the shared server process (all sessions
 * on it are disconnected). Sent by `lsp reload` when the generic reload path
 * decides the server is wedged — a plain per-session `shutdown`/`exit` is
 * intercepted by the mux and would leave the wedged server running for
 * every other instance.
 */
export const MUX_RESTART_METHOD = "omp/muxRestartServer";

/** Handshake parameters identifying (and if needed spawning) a shared server. */
export interface MuxConnectParams {
	/** Executable to spawn (the client's `resolvedCommand ?? command`). */
	command: string;
	/** Arguments passed verbatim to the executable. */
	args: string[];
	/** Workspace root the server runs in; part of the server identity key. */
	cwd: string;
	/** Extra environment overlaid on the mux daemon's own env for the spawn. */
	env?: Record<string, string>;
}

/** Handshake result. */
export interface MuxConnectResult {
	/** Server identity key inside the mux (`${command}:${cwd}`). */
	key: string;
	/** True when this handshake spawned the server process. */
	spawned: boolean;
	/** Pid of the shared server process. */
	pid?: number;
}

/** Server identity key used by the mux registry. */
export function muxServerKey(command: string, cwd: string): string {
	return `${command}:${cwd}`;
}
