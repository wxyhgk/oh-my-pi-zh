import { expect, it } from "bun:test";
import { parseArgs } from "@wxyhgk/pi-coding-agent/cli/args";
import { runRootCommand } from "@wxyhgk/pi-coding-agent/main";
import { getDbBusyTimeoutMs, setInteractiveHost } from "@wxyhgk/pi-utils";

it("classifies an interactive host before opening auth storage", async () => {
	const previous = setInteractiveHost(false);
	const stop = new Error("stop after auth classification");
	let observedTimeout: number | undefined;
	const parsed = parseArgs([]);
	parsed.noExtensions = true;

	try {
		await expect(
			runRootCommand(parsed, [], {
				discoverAuthStorage: async () => {
					observedTimeout = getDbBusyTimeoutMs();
					throw stop;
				},
			}),
		).rejects.toBe(stop);
	} finally {
		setInteractiveHost(previous);
	}

	expect(observedTimeout).toBe(5000);
});
