import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";

test("model listing exposes one provider-qualified route per upstream model", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-model-list-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	const anthropic = createMockModel({ provider: "anthropic", id: "shared-model" });
	const devin = createMockModel({ provider: "devin", id: "shared-model" });
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: [],
		storage,
		resolveModel: () => undefined,
		listModels: () => [anthropic, anthropic, devin, devin],
		version: "test",
	});

	try {
		const response = await fetch(`${handle.url}/v1/models`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			object: "list",
			data: [
				{ id: "anthropic/shared-model", object: "model", owned_by: "anthropic", api: "mock" },
				{ id: "devin/shared-model", object: "model", owned_by: "devin", api: "mock" },
			],
		});
	} finally {
		await handle.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});
