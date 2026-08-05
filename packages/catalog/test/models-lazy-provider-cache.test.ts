import { expect, test } from "bun:test";

const FIXTURE = `${import.meta.dir}/fixtures/models-lazy-provider-cache.ts`;

test("bundled models are enriched one provider at a time", () => {
	const result = Bun.spawnSync({
		cmd: [process.execPath, FIXTURE],
		env: process.env,
	});
	expect(result.exitCode, result.stderr.toString()).toBe(0);
}, 60_000);
