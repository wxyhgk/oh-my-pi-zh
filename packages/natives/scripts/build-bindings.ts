/**
 * Dev-only napi build that regenerates the TypeScript bindings
 * (native/index.d.ts) and the runtime enum exports. Shipping addons are built
 * by Bazel (`bun run build` → scripts/bazel-natives.ts); run this
 * (`bun run build:bindings`) only when the Rust API changes its exported
 * typedefs. Host target only, local cargo profile — no cross-compilation.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { detectHostAvx2Support } from "../../../scripts/host-detect";
import { generateEnumExports } from "./gen-enums";

// pcre2-sys prefers a system libpcre2 when pkg-config finds one. Keep the
// static build so the local addon never retains host Homebrew paths.
process.env.PCRE2_SYS_STATIC ??= "1";

// audiopus_sys builds its bundled opus via CMake; that opus tree declares a
// cmake_minimum_required below 3.5, which CMake 4.x refuses without this
// policy override.
process.env.CMAKE_POLICY_VERSION_MINIMUM ??= "3.5";

const repoRoot = path.join(import.meta.dir, "../../..");
const rustDir = path.join(repoRoot, "crates/pi-natives");
const nativeDir = path.join(import.meta.dir, "../native");
const packageJsonPath = path.join(import.meta.dir, "../package.json");

type X64Variant = "modern" | "baseline";

const effectiveVariant: X64Variant | null =
	process.arch === "x64" ? (detectHostAvx2Support() ? "modern" : "baseline") : null;
const variantSuffix = effectiveVariant ? `-${effectiveVariant}` : "";

// Pin Rust target-cpu so x64 baseline/modern variants get a reproducible ISA floor
// instead of inheriting the host CPU when RUSTFLAGS is unset. Non-x64 builds keep
// the target's default CPU features: `-C target-cpu=native` would bake the build
// host's CPU features into the addon and trips ring 0.17's aarch64-apple
// const assertion (CAPS_STATIC == MIN_STATIC_FEATURES).
if (!Bun.env.RUSTFLAGS) {
	if (effectiveVariant === "modern") {
		Bun.env.RUSTFLAGS = "-C target-cpu=x86-64-v3";
	} else if (effectiveVariant === "baseline") {
		Bun.env.RUSTFLAGS = "-C target-cpu=x86-64-v2";
	}
}

async function cleanupStaleTemps(dir: string): Promise<void> {
	try {
		const entries = await fs.readdir(dir);
		for (const entry of entries) {
			if (entry.includes(".tmp.") || entry.includes(".old.") || entry.includes(".new.")) {
				await fs.unlink(path.join(dir, entry)).catch(() => {});
			}
		}
	} catch {
		// Directory might not exist yet
	}
}

async function installBinary(src: string, dest: string): Promise<void> {
	const tempPath = `${dest}.tmp.${process.pid}`;

	await fs.copyFile(src, tempPath);

	try {
		// Atomic rename - works even if dest is loaded on Linux/macOS (old inode stays valid)
		await fs.rename(tempPath, dest);
	} catch {
		// On Windows, loaded DLLs cannot be overwritten via rename
		// Try delete-then-rename as fallback
		try {
			await fs.unlink(dest);
		} catch (unlinkErr) {
			if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT") {
				await fs.unlink(tempPath).catch(() => {});
				const isWindows = process.platform === "win32";
				throw new Error(
					`Cannot replace ${path.basename(dest)}${isWindows ? " (file may be in use - close any running processes)" : ""}: ${(unlinkErr as Error).message}`,
				);
			}
		}
		try {
			await fs.rename(tempPath, dest);
		} catch (finalErr) {
			await fs.unlink(tempPath).catch(() => {});
			throw new Error(`Failed to install ${path.basename(dest)}: ${(finalErr as Error).message}`);
		}
	}
}

async function resolveBuiltAddonPath(outputDir: string, canonicalFilename: string): Promise<string> {
	// napi-rs 3.x emits `${binaryName}.${platformArchABI}.node` where
	// platformArchABI is e.g. `darwin-x64`, `linux-x64-gnu`, `win32-x64-msvc`,
	// `darwin-arm64`. Build into an isolated output dir so only this invocation's
	// outputs are considered fresh candidates.
	const entries = await fs.readdir(outputDir);

	if (entries.includes(canonicalFilename)) {
		return path.join(outputDir, canonicalFilename);
	}

	const generatedCandidates = entries.filter(
		entry => entry.startsWith(`pi_natives.${process.platform}-${process.arch}`) && entry.endsWith(".node"),
	);

	if (generatedCandidates.length === 1) {
		return path.join(outputDir, generatedCandidates[0]);
	}

	if (generatedCandidates.length === 0) {
		throw new Error(
			`napi build succeeded but did not emit a native addon for ${process.platform}-${process.arch}. Expected ${canonicalFilename} or an environment-tagged variant in ${outputDir}. Directory contents: ${entries.join(", ") || "(empty)"}.`,
		);
	}

	const formattedCandidates = generatedCandidates.map(candidate => `  - ${candidate}`).join("\n");
	throw new Error(
		`napi build emitted multiple unrecognized native addons for ${process.platform}-${process.arch}:\n${formattedCandidates}`,
	);
}

async function installGeneratedBindings(outputDir: string): Promise<void> {
	const sourcePath = path.join(outputDir, "index.d.ts");
	const destPath = path.join(nativeDir, "index.d.ts");
	try {
		await fs.copyFile(sourcePath, destPath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to install generated index.d.ts: ${message}`);
	}
}

const canonicalAddonFilename = `pi_natives.${process.platform}-${process.arch}${variantSuffix}.node`;
const canonicalAddonPath = path.join(nativeDir, canonicalAddonFilename);

console.log(`Building pi-natives bindings for ${process.platform}-${process.arch}${variantSuffix} (local)…`);

await fs.mkdir(nativeDir, { recursive: true });
await cleanupStaleTemps(nativeDir);
await fs.mkdir(path.join(nativeDir, ".build"), { recursive: true });
const buildOutputDir = await fs.mkdtemp(
	path.join(nativeDir, ".build", `${process.platform}-${process.arch}-${effectiveVariant ?? "default"}-local-`),
);

// Resolve napi bin directly: `bunx @napi-rs/cli` can pick up the wrong bin on
// systems where `cli` exists on PATH (e.g. Mono's /usr/bin/cli on Ubuntu).
const napiBin = Bun.which("napi", {
	PATH: [
		path.join(import.meta.dir, "..", "node_modules", ".bin"),
		path.join(repoRoot, "node_modules", ".bin"),
		process.env.PATH ?? "",
	].join(path.delimiter),
});
if (!napiBin) {
	throw new Error("Could not locate @napi-rs/cli `napi` binary in node_modules/.bin");
}

const napiArgs = [
	"build",
	"--manifest-path",
	path.join(rustDir, "Cargo.toml"),
	"--package-json-path",
	packageJsonPath,
	"--platform",
	"--no-js",
	"--dts",
	"index.d.ts",
	"-o",
	buildOutputDir,
	"--profile",
	"local",
];

// napi-rs / cargo route much failure detail to stdout (e.g. `cargo metadata`
// errors), so a stderr-only error collapses real failures to a bare message.
const BUILD_LOG_TAIL_LINES = 40;

/** Tail-cap captured build output into a labeled section for the failure report. */
function tailSection(label: string, text: string): string {
	const trimmed = text.trimEnd();
	if (!trimmed) return "";
	const lines = trimmed.split("\n");
	const capped = lines.length > BUILD_LOG_TAIL_LINES;
	const shown = capped ? lines.slice(-BUILD_LOG_TAIL_LINES) : lines;
	return `\n--- ${label}${capped ? ` (last ${BUILD_LOG_TAIL_LINES} lines)` : ""} ---\n${shown.join("\n")}`;
}

try {
	// The package declares Bun as its build runtime. Invoke napi's JavaScript
	// entry through this Bun process instead of its `#!/usr/bin/env node` shim so
	// an old host Node installation cannot make an otherwise supported Bun build fail.
	const buildResult = await $`${process.execPath} ${napiBin} ${napiArgs}`.nothrow();
	if (buildResult.exitCode !== 0) {
		const stdout = buildResult.stdout?.toString("utf-8") ?? "";
		const stderr = buildResult.stderr?.toString("utf-8") ?? "";
		const detail = `${tailSection("stdout", stdout)}${tailSection("stderr", stderr)}`;
		throw new Error(`napi build failed (exit ${buildResult.exitCode})${detail}`);
	}

	const builtAddonPath = await resolveBuiltAddonPath(buildOutputDir, canonicalAddonFilename);
	if (builtAddonPath !== canonicalAddonPath) {
		console.log(`Normalizing native addon filename: ${path.basename(builtAddonPath)} → ${canonicalAddonFilename}`);
		await installBinary(builtAddonPath, canonicalAddonPath);
	}

	await installGeneratedBindings(buildOutputDir);

	await generateEnumExports();

	console.log("Bindings build complete.");
} finally {
	await fs.rm(buildOutputDir, { recursive: true, force: true });
}
