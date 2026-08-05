import { afterEach, describe, expect, it, vi } from "bun:test";
import { OAuthCallbackFlow } from "@oh-my-pi/pi-ai/registry/oauth/callback-server";
import type { OAuthAuthInfo, OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";

class CallbackProbeFlow extends OAuthCallbackFlow {
	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string }> {
		const url = new URL("https://provider.example.com/authorize");
		url.searchParams.set("redirect_uri", redirectUri);
		url.searchParams.set("state", state);
		return { url: url.toString() };
	}

	async exchangeToken(code: string): Promise<OAuthCredentials> {
		return { access: code, refresh: "refresh", expires: Date.now() + 60_000 };
	}
}

async function startFlow(): Promise<{
	info: OAuthAuthInfo;
	abort: AbortController;
	login: Promise<OAuthCredentials>;
}> {
	const abort = new AbortController();
	const authFired = Promise.withResolvers<OAuthAuthInfo>();
	const flow = new CallbackProbeFlow(
		{
			onAuth: info => authFired.resolve(info),
			signal: abort.signal,
		},
		{ preferredPort: 0 },
	);
	const login = flow.login();
	void login.catch(() => undefined);
	const info = await authFired.promise;
	return { info, abort, login };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("OAuthCallbackFlow callback security", () => {
	it("keeps waiting after invalid callback requests and accepts the legitimate callback", async () => {
		const { info, abort, login } = await startFlow();
		const authUrl = new URL(info.url);
		const redirectUri = authUrl.searchParams.get("redirect_uri");
		const state = authUrl.searchParams.get("state");
		if (!redirectUri || !state) throw new Error("OAuth test flow did not advertise its callback parameters");

		try {
			const invalidCallbacks = [
				`${redirectUri}?error=access_denied&error_description=Denied`,
				redirectUri,
				`${redirectUri}?code=attacker-code&state=wrong-state`,
			];
			for (const callback of invalidCallbacks) {
				const response = await fetch(callback);
				expect(response.status).toBe(500);
			}

			const response = await fetch(`${redirectUri}?code=legitimate-code&state=${encodeURIComponent(state)}`);
			expect(response.status).toBe(200);
			expect((await login).access).toBe("legitimate-code");
		} finally {
			abort.abort("test cleanup");
			await login.catch(() => undefined);
		}
	});

	it("surfaces provider denials that carry the expected state instead of waiting for the timeout", async () => {
		const { info, abort, login } = await startFlow();
		const authUrl = new URL(info.url);
		const redirectUri = authUrl.searchParams.get("redirect_uri");
		const state = authUrl.searchParams.get("state");
		if (!redirectUri || !state) throw new Error("OAuth test flow did not advertise its callback parameters");

		try {
			const response = await fetch(
				`${redirectUri}?error=access_denied&error_description=User%20denied&state=${encodeURIComponent(state)}`,
			);
			expect(response.status).toBe(500);
			await expect(login).rejects.toThrow("Authorization failed: User denied");
		} finally {
			abort.abort("test cleanup");
			await login.catch(() => undefined);
		}
	});

	it("binds localhost callback URLs to the IPv4 loopback interface", async () => {
		const serve = Bun.serve;
		let hostname: string | undefined;
		vi.spyOn(Bun, "serve").mockImplementation(options => {
			hostname = options.hostname;
			return serve(options);
		});

		const { abort, login } = await startFlow();
		try {
			expect(hostname).toBe("127.0.0.1");
		} finally {
			abort.abort("test cleanup");
			await login.catch(() => undefined);
		}
	});
});
