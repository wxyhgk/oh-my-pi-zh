import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { isArkSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { applyToolProxy } from "../../src/extensibility/tool-proxy";

describe("applyToolProxy", () => {
	class DemoTool {
		name = "demo";
		description = "demo tool";
		parameters = type({ a: "string" });
		async execute(): Promise<string> {
			return this.name;
		}
	}

	it("preserves schema callables: parameters stay wire-detectable through the wrapper", () => {
		// Regression: omptype schemas are plain functions carrying toJsonSchema/
		// assert as own properties; binding them stripped those properties, so
		// isArkSchema failed and JSON.stringify(schema) yielded undefined
		// downstream (status-line tokenizer crash).
		const wrapper: Record<string, unknown> = {};
		applyToolProxy(new DemoTool(), wrapper);
		expect(isArkSchema(wrapper.parameters)).toBe(true);
		expect(wrapper.parameters).toBeInstanceOf(Function);
	});

	it("binds prototype methods to the underlying tool", async () => {
		const wrapper: Record<string, unknown> = {};
		applyToolProxy(new DemoTool(), wrapper);
		const execute = wrapper.execute as () => Promise<string>;
		// `this` must resolve to the inner tool even when called off the wrapper
		await expect(execute.call({ name: "WRONG" })).resolves.toBe("demo");
	});

	it("passes own data properties through unchanged", () => {
		const inner = new DemoTool();
		const wrapper: Record<string, unknown> = {};
		applyToolProxy(inner, wrapper);
		expect(wrapper.name).toBe("demo");
		expect(wrapper.parameters).toBe(inner.parameters);
	});
});
