import { expect, test } from "bun:test";
import { renderTerminalOutputIsolated } from "../src/launch/terminal-output-worker-client";

class CleanExitWorker extends EventTarget {
	postMessage(): void {
		this.dispatchEvent(new Event("close"));
	}

	terminate(): void {}
}

test("legacy replay rejects when its worker exits before responding", async () => {
	const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
	expect(originalWorkerDescriptor).toBeDefined();
	Object.defineProperty(globalThis, "Worker", { configurable: true, value: CleanExitWorker });
	try {
		let outcome: { error?: unknown; settled: boolean } = { settled: false };
		void renderTerminalOutputIsolated("ready", { head: false, maxRows: 1 }).then(
			() => {
				outcome = { settled: true };
			},
			error => {
				outcome = { error, settled: true };
			},
		);
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
		expect(outcome.settled).toBeTrue();
		expect(outcome.error).toBeInstanceOf(Error);
		expect((outcome.error as Error).message).toBe("终端输出 worker 在响应前已退出");
	} finally {
		if (originalWorkerDescriptor) {
			Object.defineProperty(globalThis, "Worker", originalWorkerDescriptor);
		} else {
			Reflect.deleteProperty(globalThis, "Worker");
		}
	}
	expect(Object.getOwnPropertyDescriptor(globalThis, "Worker")).toEqual(originalWorkerDescriptor);
});
