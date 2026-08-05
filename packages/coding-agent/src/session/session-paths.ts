import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getTerminalId } from "@oh-my-pi/pi-tui";
import {
	getSessionsDir,
	getTerminalSessionsDir,
	isEnoent,
	isRecord,
	logger,
	resolveEquivalentPath,
} from "@oh-my-pi/pi-utils";
import type { SessionStorage } from "./session-storage";

const SESSION_HEADER_PREFIX_BYTES = 4096;

/**
 * Merge or rename a legacy session directory into its canonical target.
 * Best effort: callers decide whether migration failures should surface.
 */
function migrateSessionDirPath(oldPath: string, newPath: string): void {
	const existing = fs.statSync(newPath, { throwIfNoEntry: false });
	if (existing?.isDirectory()) {
		for (const file of fs.readdirSync(oldPath)) {
			const src = path.join(oldPath, file);
			const dst = path.join(newPath, file);
			if (!fs.existsSync(dst)) {
				fs.renameSync(src, dst);
			}
		}
		fs.rmSync(oldPath, { recursive: true, force: true });
		return;
	}
	if (existing) {
		fs.rmSync(newPath, { recursive: true, force: true });
	}
	fs.renameSync(oldPath, newPath);
}

function encodeLegacyAbsoluteSessionDirName(cwd: string): string {
	const resolvedCwd = path.resolve(cwd);
	return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function encodeLegacyRelativeSessionDirName(prefix: string, relative: string): string {
	const encoded = relative.replace(/[/\\:]/g, "-");
	return encoded ? (prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`) : prefix;
}

function getDefaultSessionDirName(cwd: string): {
	encodedDirName: string;
	legacyRelativeDirName: string | undefined;
	resolvedCwd: string;
} {
	const resolvedCwd = path.resolve(cwd);
	const canonicalCwd = resolveEquivalentPath(resolvedCwd);
	const home = os.homedir();
	const canonicalHome = resolveEquivalentPath(home);
	const tempRoot = os.tmpdir();
	const canonicalTempRoot = resolveEquivalentPath(tempRoot);
	const homeRelative = path.relative(canonicalHome, canonicalCwd);
	const tempRelative = path.relative(canonicalTempRoot, canonicalCwd);

	let scope: "home" | "tmp" | "abs";
	let legacyRelativeDirName: string | undefined;
	if (homeRelative === "" || (!homeRelative.startsWith("..") && !path.isAbsolute(homeRelative))) {
		scope = "home";
		legacyRelativeDirName = encodeLegacyRelativeSessionDirName("-", homeRelative);
	} else if (tempRelative === "" || (!tempRelative.startsWith("..") && !path.isAbsolute(tempRelative))) {
		scope = "tmp";
		legacyRelativeDirName = encodeLegacyRelativeSessionDirName("-tmp", tempRelative);
	} else {
		scope = "abs";
	}

	const normalized = canonicalCwd.replaceAll("\\", "/");
	const readable = path
		.basename(canonicalCwd)
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(-80);
	const digest = Bun.SHA256.hash(normalized, "hex");
	const encodedDirName = `${scope}-${readable || "project"}-${digest}`;
	return { encodedDirName, legacyRelativeDirName, resolvedCwd };
}

function readSessionCwd(sessionFile: string, buffer: Buffer): string | undefined {
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(sessionFile, "r");
		const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
		const prefix = buffer.toString("utf8", 0, bytesRead);
		for (const line of prefix.split(/\r?\n/, 3)) {
			try {
				const record: unknown = JSON.parse(line);
				if (isRecord(record) && record.type === "session" && typeof record.cwd === "string") {
					return record.cwd;
				}
			} catch {
				// Ignore title slots or truncated/corrupt headers.
			}
		}
	} catch {
		// Best-effort migration leaves unreadable sessions in the current bucket.
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
	return undefined;
}

function moveSessionBundle(sourceDir: string, targetDir: string, sessionName: string, entries: string[]): void {
	fs.mkdirSync(targetDir, { recursive: true });
	const artifactsName = path.basename(sessionName, ".jsonl");
	for (const entry of entries) {
		if (entry !== sessionName && entry !== artifactsName && !entry.startsWith(`${sessionName}.`)) continue;
		const source = path.join(sourceDir, entry);
		if (!fs.existsSync(source)) continue;
		const target = path.join(targetDir, entry);
		const existing = fs.statSync(target, { throwIfNoEntry: false });
		if (!existing) {
			fs.renameSync(source, target);
		} else if (existing.isDirectory() && fs.statSync(source).isDirectory()) {
			migrateSessionDirPath(source, target);
		} else {
			fs.rmSync(source, { recursive: true, force: true });
		}
	}
}

function rerouteCollidingSessions(
	cwd: string,
	legacyDir: string,
	sessionsRoot: string,
	kind: "relative" | "absolute",
): void {
	const entries = fs.readdirSync(legacyDir);
	const currentCwd = resolveEquivalentPath(path.resolve(cwd));
	const buffer = Buffer.allocUnsafe(SESSION_HEADER_PREFIX_BYTES);
	for (const entry of entries) {
		if (!entry.endsWith(".jsonl")) continue;
		const recordedCwd = readSessionCwd(path.join(legacyDir, entry), buffer);
		if (!recordedCwd) continue;
		const recordedCanonical = resolveEquivalentPath(path.resolve(recordedCwd));
		if (
			recordedCanonical === currentCwd ||
			!fs.statSync(recordedCanonical, { throwIfNoEntry: false })?.isDirectory()
		) {
			continue;
		}
		const recordedNames = getDefaultSessionDirName(recordedCanonical);
		const recordedLegacyName =
			kind === "relative"
				? recordedNames.legacyRelativeDirName
				: encodeLegacyAbsoluteSessionDirName(recordedCanonical);
		if (recordedLegacyName !== path.basename(legacyDir)) continue;
		moveSessionBundle(legacyDir, path.join(sessionsRoot, recordedNames.encodedDirName), entry, entries);
	}
}

export function resolveManagedSessionRoot(sessionDir: string, cwd: string): string | undefined {
	const currentDirName = path.basename(sessionDir);
	const { encodedDirName, legacyRelativeDirName } = getDefaultSessionDirName(cwd);
	if (
		currentDirName !== encodedDirName &&
		currentDirName !== legacyRelativeDirName &&
		currentDirName !== encodeLegacyAbsoluteSessionDirName(cwd)
	) {
		return undefined;
	}
	return path.dirname(sessionDir);
}

/**
 * Compute the default session directory for a cwd.
 * Classifies cwd by canonical location so symlink/alias paths resolve to the
 * same home-relative or temp-root directory names as their real targets.
 */
export function computeDefaultSessionDir(
	cwd: string,
	storage: SessionStorage,
	sessionsRoot: string = getSessionsDir(),
): string {
	const { encodedDirName, legacyRelativeDirName, resolvedCwd } = getDefaultSessionDirName(cwd);
	const sessionDir = path.join(sessionsRoot, encodedDirName);
	const legacyDirs: Array<{ kind: "relative" | "absolute"; name: string | undefined }> = [
		{ kind: "relative", name: legacyRelativeDirName },
		{ kind: "absolute", name: encodeLegacyAbsoluteSessionDirName(resolvedCwd) },
	];
	for (const legacy of legacyDirs) {
		if (!legacy.name) continue;
		const legacyDir = path.join(sessionsRoot, legacy.name);
		if (legacyDir === sessionDir || !fs.existsSync(legacyDir)) continue;
		try {
			rerouteCollidingSessions(resolvedCwd, legacyDir, sessionsRoot, legacy.kind);
			migrateSessionDirPath(legacyDir, sessionDir);
		} catch {
			// Best effort
		}
	}
	storage.ensureDirSync(sessionDir);
	return sessionDir;
}

// =============================================================================
// Terminal breadcrumbs: maps terminal (TTY) -> last session file for --continue
// =============================================================================

/**
 * Write a breadcrumb linking the current terminal to a session file.
 * The breadcrumb contains the cwd and session path so --continue can
 * find "this terminal's last session" even when running concurrent instances.
 *
 * `fresh` marks a `/new` (or freshly-minted) session boundary whose JSONL is
 * not yet materialized (new-session persistence is lazy until assistant output
 * exists). A fresh breadcrumb is honored by {@link readTerminalBreadcrumbEntry}
 * even when its target file is still absent, so relaunch/auto-resume reopens the
 * post-`/new` session instead of falling back to the pre-`/new` transcript. Once
 * the session materializes the caller rewrites the breadcrumb with `fresh:false`
 * so a later external delete is still treated as a genuinely stale crumb.
 */
export function writeTerminalBreadcrumb(cwd: string, sessionFile: string, fresh = false): void {
	const terminalId = getTerminalId();
	if (!terminalId) return;

	const breadcrumbDir = getTerminalSessionsDir();
	const breadcrumbFile = path.join(breadcrumbDir, terminalId);
	const content = fresh ? `${cwd}\n${sessionFile}\nfresh\n` : `${cwd}\n${sessionFile}\n`;
	// Synchronous + best-effort. Infrequent (session create/switch/reset, never
	// per-append), and writing in order matters: a lazy `/new` fresh crumb is
	// re-stamped non-fresh the instant the session materializes, so an async
	// fire-and-forget could land the two writes out of order and leave a
	// materialized session marked fresh.
	try {
		fs.mkdirSync(breadcrumbDir, { recursive: true });
		fs.writeFileSync(breadcrumbFile, content);
	} catch (err) {
		if (!isEnoent(err)) logger.debug("Terminal breadcrumb write failed", { err });
	}
}

export interface TerminalBreadcrumb {
	cwd: string;
	sessionFile: string;
	/** The recorded session file exists on disk right now. */
	exists: boolean;
	/** Recorded as a `/new` fresh-session boundary whose JSONL may not exist yet. */
	fresh: boolean;
}

/**
 * Read the raw terminal breadcrumb for the current terminal.
 * Returns the recorded cwd + session file regardless of whether the recorded
 * cwd still matches the current one. Callers decide how to interpret a cwd
 * mismatch (e.g. a moved/renamed worktree).
 *
 * A missing target file yields `null` UNLESS the breadcrumb is a `fresh`
 * boundary — a lazy `/new` session whose JSONL was never written — in which case
 * the entry is returned with `exists:false` so the caller can distinguish it
 * from a genuinely stale/deleted breadcrumb.
 */
export async function readTerminalBreadcrumbEntry(): Promise<TerminalBreadcrumb | null> {
	const terminalId = getTerminalId();
	if (!terminalId) return null;

	try {
		const breadcrumbFile = path.join(getTerminalSessionsDir(), terminalId);
		const content = await Bun.file(breadcrumbFile).text();
		const lines = content.trim().split("\n");
		if (lines.length < 2) return null;

		const breadcrumbCwd = lines[0];
		const sessionFile = lines[1];
		const fresh = lines[2] === "fresh";

		const stat = fs.statSync(sessionFile, { throwIfNoEntry: false });
		const exists = stat?.isFile() === true;
		// A materialized target resumes normally; a missing target is honored only
		// for a fresh `/new` boundary (never-written lazy session).
		if (exists || fresh) return { cwd: breadcrumbCwd, sessionFile, exists, fresh };
	} catch (err) {
		if (!isEnoent(err)) logger.debug("Terminal breadcrumb read failed", { err });
		// Breadcrumb doesn't exist or is corrupt — fall through
	}
	return null;
}
