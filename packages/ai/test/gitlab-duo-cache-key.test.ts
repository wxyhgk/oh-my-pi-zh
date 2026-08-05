import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Context } from "@oh-my-pi/pi-ai";
import {
	clearGitLabDuoDirectAccessCache,
	getGitLabDuoModels,
	streamGitLabDuo,
} from "@oh-my-pi/pi-ai/providers/gitlab-duo";
import * as registerBuiltins from "@oh-my-pi/pi-ai/providers/register-builtins";

const context: Context = {
	systemPrompt: ["You are helpful."],
	messages: [{ role: "user", content: "Reply OK", timestamp: 0 }],
	tools: [],
};

afterEach(() => {
	clearGitLabDuoDirectAccessCache();
	mock.restore();
});

describe("GitLab Duo prompt cache affinity", () => {
	it("forwards explicit cache affinity and disabled Responses chaining to the proxy", async () => {
		const model = getGitLabDuoModels().find(candidate => candidate.id === "duo-chat-gpt-5-codex");
		if (!model) throw new Error("GitLab Duo Responses model is missing");
		const cacheKey = "gitlab-duo-cache-key";
		let payload: Record<string, unknown> | undefined;
		const responsesSpy = spyOn(registerBuiltins, "streamOpenAIResponses");
		const stream = streamGitLabDuo(model, context, {
			apiKey: "gitlab-access-token",
			promptCacheKey: cacheKey,
			statefulResponses: false,
			fetch: async input => {
				if (String(input).includes("/direct_access")) {
					return new Response(JSON.stringify({ token: "direct-access-token", headers: {} }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}
				throw new Error("the payload hook should stop the proxy request before fetch");
			},
			onPayload: body => {
				payload = body as Record<string, unknown>;
				throw new Error("stop after payload capture");
			},
		});

		await stream.result();

		expect(responsesSpy).toHaveBeenCalledTimes(1);
		expect(responsesSpy.mock.calls[0]?.[2]).toMatchObject({
			promptCacheKey: cacheKey,
			statefulResponses: false,
		});
		expect(payload?.prompt_cache_key).toBe(cacheKey);
	});
});
