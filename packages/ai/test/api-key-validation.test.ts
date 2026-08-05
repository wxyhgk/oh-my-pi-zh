import { describe, expect, it } from "bun:test";
import { ApiKeyRequiredError } from "../src/error/auth";
import { ProviderHttpError } from "../src/error/classes";
import { classify, Flag, is } from "../src/error/flags";
import {
	validateAnthropicCompatibleApiKey,
	validateApiKeyAgainstModelsEndpoint,
	validateOpenAICompatibleApiKey,
} from "../src/registry/api-key-validation";
import type { FetchImpl } from "../src/types";

type Validator = (fetch: FetchImpl) => Promise<void>;

const validators: ReadonlyArray<readonly [string, Validator]> = [
	[
		"OpenAI-compatible chat completions",
		fetch =>
			validateOpenAICompatibleApiKey({
				provider: "test-provider",
				apiKey: "test-key",
				baseUrl: "https://example.test/v1",
				model: "test-model",
				fetch,
			}),
	],
	[
		"Anthropic-compatible messages",
		fetch =>
			validateAnthropicCompatibleApiKey({
				provider: "test-provider",
				apiKey: "test-key",
				baseUrl: "https://example.test/v1",
				model: "test-model",
				fetch,
			}),
	],
	[
		"models endpoint",
		fetch =>
			validateApiKeyAgainstModelsEndpoint({
				provider: "test-provider",
				apiKey: "test-key",
				modelsUrl: "https://example.test/v1/models",
				fetch,
			}),
	],
];

async function captureError(run: () => Promise<void>): Promise<Error> {
	try {
		await run();
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error("validator rejected with a non-Error value");
	}
	throw new Error("validator unexpectedly succeeded");
}

describe("API key validation HTTP errors", () => {
	it.each(validators)("preserves HTTP metadata for %s", async (_name, validate) => {
		const fetchMock: FetchImpl = async () =>
			new Response('{"error":"rate limited"}', {
				status: 429,
				headers: { "Retry-After": "17" },
			});

		const error = await captureError(() => validate(fetchMock));

		expect(error).toBeInstanceOf(ProviderHttpError);
		expect(error).not.toBeInstanceOf(ApiKeyRequiredError);
		const httpError = error as ProviderHttpError;
		expect(httpError.status).toBe(429);
		expect(httpError.headers?.get("Retry-After")).toBe("17");
		expect(httpError.message).toContain('test-provider API key validation failed (429): {"error":"rate limited"}');
	});

	it.each([
		{ status: 401, authFailed: true, transient: false },
		{ status: 403, authFailed: true, transient: false },
		{ status: 402, authFailed: false, transient: false },
		{ status: 429, authFailed: false, transient: true },
		{ status: 503, authFailed: false, transient: true },
	])("classifies HTTP $status without reporting a missing key", async expectation => {
		const fetchMock: FetchImpl = async () => new Response("validation failure", { status: expectation.status });
		const error = await captureError(() => validators[0]![1](fetchMock));

		expect(error).toBeInstanceOf(ProviderHttpError);
		expect((error as ProviderHttpError).status).toBe(expectation.status);
		expect(error).not.toBeInstanceOf(ApiKeyRequiredError);
		const flags = classify(error);
		expect(is(flags, Flag.AuthFailed)).toBe(expectation.authFailed);
		expect(is(flags, Flag.Transient)).toBe(expectation.transient);
	});

	it("propagates network failures without relabeling them as credential failures", async () => {
		const networkError = new TypeError("fetch failed");
		const fetchMock: FetchImpl = async () => {
			throw networkError;
		};

		const error = await captureError(() => validators[0]![1](fetchMock));

		expect(error).toBe(networkError);
		expect(error).not.toBeInstanceOf(ProviderHttpError);
		expect(error).not.toBeInstanceOf(ApiKeyRequiredError);
	});
});
