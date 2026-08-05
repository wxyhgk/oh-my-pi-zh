import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearAwsCredentialCache,
	resolveAwsCredentials,
	tokenizeCredentialProcessCommand,
} from "@oh-my-pi/pi-ai/providers/aws-credentials";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { removeWithRetries } from "../../utils/src/temp";
import { waitForDelayOrAbort } from "./helpers";

// `credential_process` integration coverage. Drives a real `Bun.spawn`
// against a fixture script so the JSON envelope contract, exit-code
// handling, abort propagation, cache behavior, and the POSIX-style
// tokenizer are all exercised end-to-end.

const ENV_KEYS = [
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_PROFILE",
	"AWS_SDK_LOAD_CONFIG",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_CONFIG_FILE",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_EC2_METADATA_DISABLED",
	"AWS_EC2_METADATA_SERVICE_ENDPOINT",
	"AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AWS_ROLE_ARN",
	"AWS_ROLE_SESSION_NAME",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_CONTAINER_AUTHORIZATION_TOKEN",
	"AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
] as const;

function quoteForConfig(p: string): string {
	if (!/[\s"]/.test(p)) return p;
	// Wrap in double quotes; our tokenizer preserves backslashes so Windows
	// paths survive without further escaping.
	return `"${p.replace(/(["])/g, "\\$1")}"`;
}

describe("tokenizeCredentialProcessCommand", () => {
	test("splits on whitespace", () => {
		expect(tokenizeCredentialProcessCommand("/bin/auth --json")).toEqual(["/bin/auth", "--json"]);
	});

	test("collapses runs of whitespace", () => {
		expect(tokenizeCredentialProcessCommand("  a\tb \n c")).toEqual(["a", "b", "c"]);
	});

	test("double quotes preserve Windows backslashes", () => {
		expect(tokenizeCredentialProcessCommand(`"C:\\Program Files\\auth\\tool.exe" --json`)).toEqual([
			"C:\\Program Files\\auth\\tool.exe",
			"--json",
		]);
	});

	test('double quotes still escape $ ` " and \\', () => {
		expect(tokenizeCredentialProcessCommand(`"a\\"b" "\\$x" "\\\\n"`)).toEqual([`a"b`, "$x", "\\n"]);
	});

	test("single quotes are fully literal", () => {
		expect(tokenizeCredentialProcessCommand(`'C:\\path with spaces\\bin' --x`)).toEqual([
			"C:\\path with spaces\\bin",
			"--x",
		]);
	});

	test("backslash outside quotes escapes the next character", () => {
		expect(tokenizeCredentialProcessCommand(`a\\ b c`)).toEqual(["a b", "c"]);
	});

	test("rejects unterminated quotes", () => {
		expect(() => tokenizeCredentialProcessCommand(`"unterminated`)).toThrow(/unterminated/);
		expect(() => tokenizeCredentialProcessCommand(`'half`)).toThrow(/unterminated/);
	});

	test("empty input yields no tokens", () => {
		expect(tokenizeCredentialProcessCommand("")).toEqual([]);
		expect(tokenizeCredentialProcessCommand("   \t  ")).toEqual([]);
	});
});

describe("resolveAwsCredentials", () => {
	let tmp: string;
	const saved = new Map<string, string | undefined>();

	beforeEach(async () => {
		for (const k of ENV_KEYS) {
			saved.set(k, Bun.env[k]);
			delete Bun.env[k];
		}
		Bun.env.AWS_EC2_METADATA_DISABLED = "true";
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aws-credproc-"));
		clearAwsCredentialCache();
	});

	afterEach(async () => {
		for (const [k, v] of saved) {
			if (v === undefined) delete Bun.env[k];
			else Bun.env[k] = v;
		}
		saved.clear();
		await removeWithRetries(tmp);
		clearAwsCredentialCache();
	});

	async function writeFixture(name: string, body: string): Promise<string> {
		const p = path.join(tmp, name);
		await Bun.write(p, body);
		return p;
	}

	async function writeConfig(profile: string, line: string): Promise<void> {
		const cfg = path.join(tmp, "config");
		await Bun.write(cfg, `[profile ${profile}]\n${line}\n`);
		Bun.env.AWS_CONFIG_FILE = cfg;
		// Point shared credentials at a known-empty file so static-creds resolution
		// definitely misses.
		const sharedPath = path.join(tmp, "credentials");
		await Bun.write(sharedPath, "");
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = sharedPath;
	}

	test("parses a Version 1 envelope and honors Expiration", async () => {
		const script = await writeFixture(
			"good.js",
			`console.log(JSON.stringify({Version:1,AccessKeyId:"AKIATEST",SecretAccessKey:"sek",SessionToken:"tok",Expiration:"2099-01-01T00:00:00Z"}));`,
		);
		await writeConfig("good", `credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`);

		const creds = await resolveAwsCredentials({ profile: "good", region: "us-east-1" });
		expect(creds.accessKeyId).toBe("AKIATEST");
		expect(creds.secretAccessKey).toBe("sek");
		expect(creds.sessionToken).toBe("tok");
		expect(creds.expiresAt).toBe(Date.parse("2099-01-01T00:00:00Z"));
	});

	test("caches by profile so the helper is only invoked once", async () => {
		const counterPath = path.join(tmp, "calls.txt");
		const script = await writeFixture(
			"counted.js",
			`const fs=require("node:fs");
			 const prev=fs.existsSync(${JSON.stringify(counterPath)})?Number(fs.readFileSync(${JSON.stringify(counterPath)},"utf8")):0;
			 fs.writeFileSync(${JSON.stringify(counterPath)},String(prev+1));
			 console.log(JSON.stringify({Version:1,AccessKeyId:"AKIA",SecretAccessKey:"s",Expiration:"2099-01-01T00:00:00Z"}));`,
		);
		await writeConfig(
			"counted",
			`credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`,
		);

		await resolveAwsCredentials({ profile: "counted" });
		await resolveAwsCredentials({ profile: "counted" });
		const calls = Number(await Bun.file(counterPath).text());
		expect(calls).toBe(1);
	});

	test("rejects unsupported envelope versions", async () => {
		const script = await writeFixture(
			"badversion.js",
			`console.log(JSON.stringify({Version:2,AccessKeyId:"a",SecretAccessKey:"b"}));`,
		);
		await writeConfig("badv", `credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`);
		await expect(resolveAwsCredentials({ profile: "badv" })).rejects.toThrow(/unsupported Version 2/);
	});

	test("surfaces stderr on non-zero exit", async () => {
		const script = await writeFixture("fail.js", `process.stderr.write("auth helper broke");process.exit(7);`);
		await writeConfig(
			"failing",
			`credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`,
		);
		await expect(resolveAwsCredentials({ profile: "failing" })).rejects.toThrow(/exited 7.*auth helper broke/);
	});

	test("aborts a long-running helper when the caller's signal fires", async () => {
		const script = await writeFixture("hang.js", `setTimeout(()=>{},60_000);`);
		await writeConfig("hangs", `credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`);
		const ctrl = new AbortController();
		const promise = resolveAwsCredentials({ profile: "hangs", signal: ctrl.signal });
		setTimeout(() => ctrl.abort(new Error("test abort")), 50);
		await expect(promise).rejects.toBeDefined();
	});

	test("resolves ECS container credentials with the authorization token", async () => {
		const credentialsPath = path.join(tmp, "empty-credentials");
		const configPath = path.join(tmp, "empty-config");
		await Promise.all([Bun.write(credentialsPath, ""), Bun.write(configPath, "")]);
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath;
		Bun.env.AWS_CONFIG_FILE = configPath;
		Bun.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = "/v2/credentials/test";
		Bun.env.AWS_CONTAINER_AUTHORIZATION_TOKEN = "container-auth";
		const capture: { url?: string; authorization?: string | null } = {};
		const fetchImpl: FetchImpl = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				capture.url = String(input);
				capture.authorization = new Headers(init?.headers).get("authorization");
				return Response.json({
					AccessKeyId: "AKIAECS",
					SecretAccessKey: "ecs-secret",
					Token: "ecs-token",
					Expiration: "2099-01-01T00:00:00Z",
				});
			},
			{ preconnect: fetch.preconnect },
		);

		const credentials = await resolveAwsCredentials({ fetch: fetchImpl });

		expect(capture.url).toBe("http://169.254.170.2/v2/credentials/test");
		expect(capture.authorization).toBe("container-auth");
		expect(credentials).toEqual({
			accessKeyId: "AKIAECS",
			secretAccessKey: "ecs-secret",
			sessionToken: "ecs-token",
			expiresAt: Date.parse("2099-01-01T00:00:00Z"),
		});
	});

	test("rejects dynamic container credentials without expiration", async () => {
		const credentialsPath = path.join(tmp, "empty-dynamic-credentials");
		const configPath = path.join(tmp, "empty-dynamic-config");
		await Promise.all([Bun.write(credentialsPath, ""), Bun.write(configPath, "")]);
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath;
		Bun.env.AWS_CONFIG_FILE = configPath;
		Bun.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = "/v2/credentials/rotating";
		let calls = 0;
		const fetchImpl: FetchImpl = Object.assign(
			async () => {
				calls++;
				return Response.json({
					AccessKeyId: "AKIAECS",
					SecretAccessKey: "ecs-secret",
					Token: "ecs-token",
				});
			},
			{ preconnect: fetch.preconnect },
		);

		await expect(resolveAwsCredentials({ fetch: fetchImpl })).rejects.toThrow(/missing or invalid Expiration/);
		expect(calls).toBe(1);
	});

	test("rejects container relative URIs that can replace the metadata host", async () => {
		const credentialsPath = path.join(tmp, "empty-relative-credentials");
		const configPath = path.join(tmp, "empty-relative-config");
		await Promise.all([Bun.write(credentialsPath, ""), Bun.write(configPath, "")]);
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath;
		Bun.env.AWS_CONFIG_FILE = configPath;
		Bun.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = "//attacker.invalid/credentials";

		await expect(resolveAwsCredentials()).rejects.toThrow(/single-host absolute path/);
	});

	test("honors AWS_EC2_METADATA_SERVICE_ENDPOINT for instance-role credentials", async () => {
		const credentialsPath = path.join(tmp, "empty-imds-credentials");
		const configPath = path.join(tmp, "empty-imds-config");
		await Promise.all([Bun.write(credentialsPath, ""), Bun.write(configPath, "")]);
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath;
		Bun.env.AWS_CONFIG_FILE = configPath;
		Bun.env.AWS_EC2_METADATA_DISABLED = "false";
		Bun.env.AWS_EC2_METADATA_SERVICE_ENDPOINT = "http://imds.internal:8181/";
		const requestedUrls: string[] = [];
		const fetchImpl: FetchImpl = Object.assign(
			async (input: string | URL | Request) => {
				const url = String(input);
				requestedUrls.push(url);
				if (url.endsWith("/latest/api/token")) return new Response("imds-token");
				if (url.endsWith("/latest/meta-data/iam/security-credentials/")) return new Response("test-role");
				return Response.json({
					AccessKeyId: "AKIAIMDS",
					SecretAccessKey: "imds-secret",
					Token: "imds-session",
					Expiration: "2099-01-01T00:00:00Z",
				});
			},
			{ preconnect: fetch.preconnect },
		);

		const credentials = await resolveAwsCredentials({ fetch: fetchImpl });

		expect(requestedUrls).toEqual([
			"http://imds.internal:8181/latest/api/token",
			"http://imds.internal:8181/latest/meta-data/iam/security-credentials/",
			"http://imds.internal:8181/latest/meta-data/iam/security-credentials/test-role",
		]);
		expect(credentials.accessKeyId).toBe("AKIAIMDS");
		expect(credentials.sessionToken).toBe("imds-session");
	});

	test("uses the IPv6 IMDS endpoint when endpoint mode requests it", async () => {
		const credentialsPath = path.join(tmp, "empty-ipv6-imds-credentials");
		const configPath = path.join(tmp, "empty-ipv6-imds-config");
		await Promise.all([Bun.write(credentialsPath, ""), Bun.write(configPath, "")]);
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath;
		Bun.env.AWS_CONFIG_FILE = configPath;
		Bun.env.AWS_EC2_METADATA_DISABLED = "false";
		Bun.env.AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE = "IPv6";
		const requestedUrls: string[] = [];
		const fetchImpl: FetchImpl = Object.assign(
			async (input: string | URL | Request) => {
				const url = String(input);
				requestedUrls.push(url);
				if (url.endsWith("/latest/api/token")) return new Response("imds-token");
				if (url.endsWith("/latest/meta-data/iam/security-credentials/")) return new Response("test-role");
				return Response.json({
					AccessKeyId: "AKIAIMDS",
					SecretAccessKey: "imds-secret",
					Token: "imds-session",
					Expiration: "2099-01-01T00:00:00Z",
				});
			},
			{ preconnect: fetch.preconnect },
		);

		await resolveAwsCredentials({ fetch: fetchImpl });

		expect(requestedUrls[0]).toBe("http://[fd00:ec2::254]/latest/api/token");
	});

	test("gives each IMDS request its own timeout budget", async () => {
		const credentialsPath = path.join(tmp, "empty-slow-imds-credentials");
		const configPath = path.join(tmp, "empty-slow-imds-config");
		await Promise.all([Bun.write(credentialsPath, ""), Bun.write(configPath, "")]);
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath;
		Bun.env.AWS_CONFIG_FILE = configPath;
		Bun.env.AWS_EC2_METADATA_DISABLED = "false";
		Bun.env.AWS_EC2_METADATA_SERVICE_ENDPOINT = "http://slow-imds.internal";
		let calls = 0;
		const fetchImpl: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				await waitForDelayOrAbort(450, init?.signal ?? undefined);
				calls++;
				if (calls === 1) return new Response("imds-token");
				if (calls === 2) return new Response("test-role");
				return Response.json({
					AccessKeyId: "AKIASLOWIMDS",
					SecretAccessKey: "imds-secret",
					Token: "imds-session",
					Expiration: "2099-01-01T00:00:00Z",
				});
			},
			{ preconnect: fetch.preconnect },
		);

		const credentials = await resolveAwsCredentials({ fetch: fetchImpl });

		expect(calls).toBe(3);
		expect(credentials.accessKeyId).toBe("AKIASLOWIMDS");
	});

	test("exchanges web identity tokens for STS credentials", async () => {
		const tokenPath = path.join(tmp, "web-identity-token");
		await Bun.write(tokenPath, "signed-identity-token\n");
		Bun.env.AWS_WEB_IDENTITY_TOKEN_FILE = tokenPath;
		Bun.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/test-role";
		Bun.env.AWS_ROLE_SESSION_NAME = "test-session";
		await writeConfig("regional", "region = cn-north-1");
		let requestedUrl = "";
		let requestBody = "";
		const fetchImpl: FetchImpl = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				requestedUrl = String(input);
				requestBody = String(init?.body);
				return new Response(
					`<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials>
						<AccessKeyId>AKIAWEB</AccessKeyId><SecretAccessKey>web-secret</SecretAccessKey>
						<SessionToken>web-token</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration>
					</Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`,
					{ headers: { "content-type": "text/xml" } },
				);
			},
			{ preconnect: fetch.preconnect },
		);

		const credentials = await resolveAwsCredentials({ profile: "regional", fetch: fetchImpl });

		expect(requestedUrl).toBe("https://sts.cn-north-1.amazonaws.com.cn/");
		expect(new URLSearchParams(requestBody).get("WebIdentityToken")).toBe("signed-identity-token");
		expect(new URLSearchParams(requestBody).get("RoleSessionName")).toBe("test-session");
		expect(credentials).toEqual({
			accessKeyId: "AKIAWEB",
			secretAccessKey: "web-secret",
			sessionToken: "web-token",
			expiresAt: Date.parse("2099-01-01T00:00:00Z"),
		});
	});

	test("rejects web-identity responses without a valid expiration", async () => {
		const tokenPath = path.join(tmp, "web-identity-token-without-expiration");
		await Bun.write(tokenPath, "signed-identity-token\n");
		Bun.env.AWS_WEB_IDENTITY_TOKEN_FILE = tokenPath;
		Bun.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/test-role";
		const fetchImpl: FetchImpl = Object.assign(
			async () =>
				new Response(
					`<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials>
						<AccessKeyId>AKIAWEB</AccessKeyId><SecretAccessKey>web-secret</SecretAccessKey>
						<SessionToken>web-token</SessionToken>
					</Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`,
					{ headers: { "content-type": "text/xml" } },
				),
			{ preconnect: fetch.preconnect },
		);

		await expect(resolveAwsCredentials({ region: "us-east-1", fetch: fetchImpl })).rejects.toThrow(
			/missing or invalid Expiration/,
		);
	});
});
