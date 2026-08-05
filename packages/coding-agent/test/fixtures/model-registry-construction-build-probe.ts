import { spyOn } from "bun:test";
import * as path from "node:path";
import * as buildModule from "@wxyhgk/pi-catalog/build";
import { ModelRegistry } from "@wxyhgk/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@wxyhgk/pi-coding-agent/session/auth-storage";
import { TempDir } from "@wxyhgk/pi-utils";

const tempDir = TempDir.createSync("@model-registry-lazy-probe-");
const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
const buildSpy = spyOn(buildModule, "buildModel");
try {
	new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	process.stdout.write(JSON.stringify({ buildCalls: buildSpy.mock.calls.length }));
} finally {
	buildSpy.mockRestore();
	authStorage.close();
	await tempDir.remove().catch(() => {});
}
