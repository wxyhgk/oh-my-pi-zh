import { afterEach, beforeEach, expect, test } from "bun:test";
import { AuthStorage } from "@wxyhgk/pi-ai";
import { parseArgs } from "@wxyhgk/pi-coding-agent/cli/args";
import { ModelRegistry } from "@wxyhgk/pi-coding-agent/config/model-registry";
import { Settings } from "@wxyhgk/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@wxyhgk/pi-coding-agent/main";
import { SessionManager } from "@wxyhgk/pi-coding-agent/session/session-manager";
import { TempDir } from "@wxyhgk/pi-utils";

let tempDir: TempDir;
let authStorage: AuthStorage;

beforeEach(async () => {
	tempDir = await TempDir.create("@cli-explicit-extension-isolation-");
	authStorage = await AuthStorage.create(tempDir.join("auth.db"));
});

afterEach(async () => {
	authStorage.close();
	await tempDir.remove();
});

test("buildSessionOptions retains explicit extensions and hooks under --no-extensions", async () => {
	const extensionPath = tempDir.join("extension-package");
	const hookPath = tempDir.join("hook.ts");
	const parsed = parseArgs(["--no-extensions", "--extension", extensionPath, "--hook", hookPath]);
	const settings = Settings.isolated();
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

	const options = await buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, settings);

	expect(options.disableExtensionDiscovery).toBe(true);
	expect(options.additionalExtensionPaths).toEqual([extensionPath, hookPath]);
});
