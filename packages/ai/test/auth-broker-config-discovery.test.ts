import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAuthStorage, resolveAuthBrokerConfig } from "@oh-my-pi/pi-ai/auth-broker";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const SUPPRESS_AUTH_BROKER_ENV = {
	OMP_AUTH_BROKER_URL: undefined,
	OMP_AUTH_BROKER_TOKEN: undefined,
	OMP_AUTH_BROKER_ACCOUNT_POOL_FILE: undefined,
} as const;

describe("resolveAuthBrokerConfig config discovery", () => {
	let agentDir = "";

	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-broker-config-"));
	});

	afterEach(async () => {
		if (agentDir) {
			await removeWithRetries(agentDir);
			agentDir = "";
		}
	});

	test("resolves broker URL and token from config.yaml when config.yml is absent", async () => {
		await Bun.write(
			path.join(agentDir, "config.yaml"),
			"auth.broker.url: https://yaml-broker.example/v1\nauth.broker.token: yaml-token\n",
		);

		await withEnv(SUPPRESS_AUTH_BROKER_ENV, async () => {
			await expect(resolveAuthBrokerConfig({ agentDir })).resolves.toEqual({
				url: "https://yaml-broker.example/v1",
				token: "yaml-token",
			});
		});
	});

	test("prefers config.yml over config.yaml when both exist", async () => {
		await Bun.write(
			path.join(agentDir, "config.yaml"),
			"auth.broker.url: https://yaml-broker.example/v1\nauth.broker.token: yaml-token\n",
		);
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"auth.broker.url: https://yml-broker.example/v1\nauth.broker.token: yml-token\n",
		);

		await withEnv(SUPPRESS_AUTH_BROKER_ENV, async () => {
			await expect(resolveAuthBrokerConfig({ agentDir })).resolves.toEqual({
				url: "https://yml-broker.example/v1",
				token: "yml-token",
			});
		});
	});

	test("rejects unreadable or malformed account-pool files before connecting", async () => {
		const poolPath = path.join(agentDir, "account-pool.json");
		const brokerEnv = {
			...SUPPRESS_AUTH_BROKER_ENV,
			OMP_AUTH_BROKER_URL: "http://127.0.0.1:1",
			OMP_AUTH_BROKER_TOKEN: "test-token",
			OMP_AUTH_BROKER_ACCOUNT_POOL_FILE: poolPath,
		} as const;

		await withEnv(brokerEnv, async () => {
			await expect(discoverAuthStorage({ agentDir })).rejects.toThrow(
				"Unable to read OMP_AUTH_BROKER_ACCOUNT_POOL_FILE",
			);

			const invalidFiles = [
				["[]", "must contain a JSON object"],
				['{"anthropic":"email:a@example.com"}', "must be an array of identity keys"],
				['{"anthropic":[42]}', "contains an invalid identity key"],
				['{" anthropic":["email:a@example.com"]}', "provider id with surrounding whitespace"],
				['{"anthropic":[" email:a@example.com"]}', "identity key with surrounding whitespace"],
			] as const;
			for (const [content, expectedError] of invalidFiles) {
				await Bun.write(poolPath, content);
				await expect(discoverAuthStorage({ agentDir })).rejects.toThrow(expectedError);
			}
		});
	});
});
