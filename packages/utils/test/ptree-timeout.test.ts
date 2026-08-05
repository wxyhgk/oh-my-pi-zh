import { describe, expect, it } from "bun:test";
import { spawn, TimeoutError } from "@oh-my-pi/pi-utils/ptree";

describe("ptree timeout", () => {
	it("contains the lifecycle rejection when the caller does not observe exited", async () => {
		const unhandled = new Set<unknown>();
		const onUnhandled = (reason: unknown) => {
			unhandled.add(reason);
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			// Bun's subprocess timeout uses the platform clock; fake timers cannot drive this lifecycle.
			using child = spawn(["bun", "-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"], {
				timeout: 20,
			});
			await child.nothrow().text();
			await child.proc.exited;
			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;

			expect(child.exitReason).toBeInstanceOf(TimeoutError);
			expect(unhandled.has(child.exitReason)).toBe(false);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
