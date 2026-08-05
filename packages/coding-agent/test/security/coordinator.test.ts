import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@wxyhgk/pi-ai/api-registry";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@wxyhgk/pi-ai/auth-storage";
import { createMockModel, type MockResponseSource, registerMockApi } from "@wxyhgk/pi-ai/providers/mock";
import { $ } from "bun";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import {
	createNativeSecurityProvenance,
	DEFAULT_SECURITY_GIT_ADAPTER,
	SecurityCoordinator,
	type SecurityGitAdapter,
	type SecurityScanBundle,
	SecurityStore,
} from "../../src/security";
import { SessionManager } from "../../src/session/session-manager";

const MOCK_SOURCE_ID = "security-coordinator-test";
let temporaryRoot = "";
let repositoryRoot = "";
let stateRoot = "";
let credentialStore: AuthCredentialStore | null = null;
let authStorage: AuthStorage;
let settings: Settings;
let credentialId = 0;

const gitAdapter: SecurityGitAdapter = {
	root: async () => repositoryRoot,
	headSha: async () => "a".repeat(40),
	resolveRef: async (_cwd, refName) => (refName === "base" ? "b".repeat(40) : "c".repeat(40)),
	diffTree: async () => "fixture-diff",
	status: async () => "",
	files: async () => ["src/app.ts"],
	untracked: async () => [],
};

beforeEach(async () => {
	temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-security-coordinator-"));
	repositoryRoot = path.join(temporaryRoot, "repo");
	stateRoot = path.join(temporaryRoot, "state");
	await fs.mkdir(path.join(repositoryRoot, "src"), { recursive: true });
	await Bun.write(path.join(repositoryRoot, "src", "app.ts"), "export const app = true;\n");
	credentialStore = await SqliteAuthCredentialStore.open(path.join(temporaryRoot, "agent.db"));
	authStorage = new AuthStorage(credentialStore);
	await authStorage.set("openai-codex", {
		type: "oauth",
		access: "fixture-access-token",
		refresh: "fixture-refresh-token",
		expires: Date.now() + 60 * 60_000,
		accountId: "workspace-fixture",
		email: "security@example.invalid",
		orgId: "workspace-fixture",
		orgName: "pro",
	});
	const account = authStorage.listOAuthAccounts("openai-codex")[0];
	if (!account) throw new Error("expected fixture OAuth account");
	credentialId = account.credentialId;
	settings = Settings.isolated({ "security.enabled": true, "compaction.enabled": false });
	registerMockApi(MOCK_SOURCE_ID);
});

afterEach(async () => {
	vi.restoreAllMocks();
	unregisterCustomApis(MOCK_SOURCE_ID);
	settings.cancelPendingSaves();
	credentialStore?.close();
	credentialStore = null;
	await fs.rm(temporaryRoot, { recursive: true, force: true });
});

function storeFactory(): Promise<SecurityStore> {
	return SecurityStore.open(repositoryRoot, { stateRoot });
}

function coordinatorWithMockSession(responses: MockResponseSource) {
	const mock = createMockModel({
		id: "security-mock",
		provider: "openai-codex",
		responses,
	});
	const modelRegistry = new ModelRegistry(authStorage, path.join(temporaryRoot, "models.yml"));
	const coordinator = new SecurityCoordinator(
		{
			cwd: repositoryRoot,
			settings,
			authStorage,
			modelRegistry,
			activeModel: mock.model,
			sessionId: "parent-session",
			agentId: "Main",
		},
		{ openStore: storeFactory, gitAdapter },
	);
	return { coordinator, mock };
}

describe("native security coordinator", () => {
	test("scripted mock model publishes a canonical completed scan and restartable session", async () => {
		const { coordinator, mock } = coordinatorWithMockSession([
			{
				content: [
					{
						type: "toolCall",
						name: "security_publish",
						arguments: {
							findings: [
								{
									rule_id: "fixture.command-injection",
									title: "Untrusted command reaches a shell",
									summary: "A fixture value is interpolated into a shell command.",
									severity: "high",
									confidence: "high",
									category: "command-injection",
									locations: [{ path: "src/app.ts", start_line: 1, role: "sink" }],
									evidence: [{ label: "shell sink", explanation: "Fixture evidence" }],
									remediation: "Use an argument-vector API.",
									validation: "validated",
								},
							],
							coverage: { completeness: "complete" },
							report: "# Fixture security report\n\nOne validated finding.\n",
						},
					},
				],
			},
			{ content: ["Security publication completed."] },
		]);
		const createdPlan = await coordinator.preflight({ credentialId, model: mock.model });
		const started = await coordinator.start({ planId: createdPlan.id });
		const terminal = await coordinator.wait(started.operationId);
		expect(terminal.phase).toBe("completed");
		expect(terminal.findingCount).toBe(1);
		const bundle = await (await storeFactory()).getBundle(terminal.scanId);
		expect(bundle?.scan.status).toBe("completed");
		expect(bundle?.findings).toHaveLength(1);
		expect(terminal.sessionFile).toBeDefined();
		if (!terminal.sessionFile) throw new Error("expected persisted security session");
		const reopened = await SessionManager.open(terminal.sessionFile, undefined, undefined, {
			initialCwd: repositoryRoot,
		});
		expect(reopened.getSessionId()).toBeTruthy();
	});

	test("records a terminal failure when initial scan persistence fails", async () => {
		const mock = createMockModel({ id: "security-mock", provider: "openai-codex" });
		const store = await storeFactory();
		const coordinator = new SecurityCoordinator(
			{
				cwd: repositoryRoot,
				settings,
				authStorage,
				modelRegistry: new ModelRegistry(authStorage, path.join(temporaryRoot, "models.yml")),
				activeModel: mock.model,
			},
			{
				openStore: async () => store,
				gitAdapter,
				createSession: async () => {
					throw new Error("session must not launch when persistence fails");
				},
			},
		);
		const plan = await coordinator.preflight({ credentialId, model: mock.model });
		vi.spyOn(store, "putBundle").mockRejectedValue(new Error("security store unavailable"));
		const started = await coordinator.start({ planId: plan.id });
		await expect(coordinator.wait(started.operationId)).rejects.toThrow("security store unavailable");
		expect(await coordinator.status(started.operationId)).toMatchObject({
			phase: "failed",
			error: "security store unavailable",
		});
	});

	test("cancellation before session launch has no inference side effects", async () => {
		let sessionCreations = 0;
		const mock = createMockModel({ id: "security-mock", provider: "openai-codex" });
		const modelRegistry = new ModelRegistry(authStorage, path.join(temporaryRoot, "models.yml"));
		const coordinator = new SecurityCoordinator(
			{
				cwd: repositoryRoot,
				settings,
				authStorage,
				modelRegistry,
				activeModel: mock.model,
				sessionId: "parent-session",
			},
			{
				openStore: storeFactory,
				gitAdapter,
				createSession: async () => {
					sessionCreations++;
					throw new Error("session must not launch after cancellation");
				},
			},
		);
		const createdPlan = await coordinator.preflight({ credentialId, model: mock.model });
		const started = await coordinator.start({ planId: createdPlan.id });
		expect(await coordinator.cancel(started.operationId)).toBeTrue();
		const terminal = await coordinator.wait(started.operationId);
		expect(terminal.phase).toBe("cancelled");
		expect(sessionCreations).toBe(0);
		expect(mock.calls).toHaveLength(0);
		const bundle = await (await storeFactory()).getBundle(terminal.scanId);
		expect(bundle?.scan.status).toBe("cancelled");
	});

	test("mid-review cancellation aborts the session and retains an honest partial record", async () => {
		const promptStarted = Promise.withResolvers<void>();
		const promptFinished = Promise.withResolvers<void>();
		let abortCalls = 0;
		const mock = createMockModel({ id: "security-mock", provider: "openai-codex" });
		const modelRegistry = new ModelRegistry(authStorage, path.join(temporaryRoot, "models.yml"));
		const coordinator = new SecurityCoordinator(
			{
				cwd: repositoryRoot,
				settings,
				authStorage,
				modelRegistry,
				activeModel: mock.model,
				sessionId: "parent-session",
			},
			{
				openStore: storeFactory,
				gitAdapter,
				createSession: async () => ({
					prompt: async () => {
						promptStarted.resolve();
						await promptFinished.promise;
						throw new Error("review interrupted");
					},
					waitForIdle: async () => undefined,
					abort: async () => {
						abortCalls++;
						promptFinished.resolve();
					},
					dispose: async () => undefined,
				}),
			},
		);
		const createdPlan = await coordinator.preflight({ credentialId, model: mock.model });
		const started = await coordinator.start({ planId: createdPlan.id });
		await promptStarted.promise;
		expect(await coordinator.cancel(started.operationId)).toBeTrue();
		const terminal = await coordinator.wait(started.operationId);
		expect(terminal.phase).toBe("cancelled");
		expect(abortCalls).toBe(1);
		const bundle = await (await storeFactory()).getBundle(terminal.scanId);
		expect(bundle?.scan.status).toBe("cancelled");
		expect(bundle?.findings).toEqual([]);
	});
	test("ref-diff execution checks out the immutable head and supplies the exact diff", async () => {
		await $`git init --initial-branch=main`.cwd(repositoryRoot).quiet();
		await $`git config user.name Fixture`.cwd(repositoryRoot).quiet();
		await $`git config user.email fixture@example.invalid`.cwd(repositoryRoot).quiet();
		await $`git add src/app.ts`.cwd(repositoryRoot).quiet();
		await $`git commit -m base`.cwd(repositoryRoot).quiet();
		const baseRevision = (await $`git rev-parse HEAD`.cwd(repositoryRoot).text()).trim();
		await Bun.write(path.join(repositoryRoot, "src", "app.ts"), "export const app = 'head';\n");
		await $`git add src/app.ts`.cwd(repositoryRoot).quiet();
		await $`git commit -m head`.cwd(repositoryRoot).quiet();
		const headRevision = (await $`git rev-parse HEAD`.cwd(repositoryRoot).text()).trim();
		const mock = createMockModel({ id: "security-mock", provider: "openai-codex" });
		let executionRoot = "";
		let request = "";
		let reviewedContent = "";
		const coordinator = new SecurityCoordinator(
			{
				cwd: repositoryRoot,
				settings,
				authStorage,
				modelRegistry: new ModelRegistry(authStorage, path.join(temporaryRoot, "models.yml")),
				activeModel: mock.model,
			},
			{
				openStore: storeFactory,
				gitAdapter: DEFAULT_SECURITY_GIT_ADAPTER,
				createSession: async input => {
					executionRoot = input.executionRoot;
					return {
						prompt: async text => {
							request = text;
							reviewedContent = await Bun.file(path.join(input.executionRoot, "src", "app.ts")).text();
							return true;
						},
						waitForIdle: async () => undefined,
						abort: async () => undefined,
						dispose: async () => undefined,
					};
				},
			},
		);
		const plan = await coordinator.preflight({
			credentialId,
			model: mock.model,
			target: { kind: "ref_diff", baseRevision, headRevision },
		});
		const started = await coordinator.start({ planId: plan.id });
		const terminal = await coordinator.wait(started.operationId);
		expect(terminal.phase).toBe("partial");
		expect(executionRoot).not.toBe(repositoryRoot);
		expect(reviewedContent).toBe("export const app = 'head';\n");
		expect(request).toContain("请求的基准到最新差异");
		expect(request).toContain("+export const app = 'head';");
		await expect(fs.stat(executionRoot)).rejects.toThrow();
	});

	test("restart recovery reconciles an interrupted persisted operation", async () => {
		const { coordinator, mock } = coordinatorWithMockSession([]);
		const plan = await coordinator.preflight({ credentialId, model: mock.model });
		const store = await storeFactory();
		const operationId = "secop_restart_fixture";
		const scanId = "secscan_restartfixture";
		const provenance = createNativeSecurityProvenance({
			createdAt: "2026-07-29T00:00:00.000Z",
			account: plan.account,
			planFingerprint: plan.fingerprint,
			workflowFingerprint: plan.workflowFingerprint,
			operationId,
		});
		const interrupted: SecurityScanBundle = {
			scan: {
				documentType: "omp-security.scan",
				schemaVersion: "1.0",
				id: scanId,
				projectKey: store.projectKey,
				status: "running",
				createdAt: plan.createdAt,
				startedAt: "2026-07-29T00:00:00.000Z",
				plan,
				target: plan.target,
				producer: provenance.producer,
				provenance,
				findingIds: [],
				coverage: {
					mode: "repository",
					completeness: "unknown",
					inventoryStrategy: "repository",
					includePaths: [],
					excludePaths: [],
					surfaces: [],
					explicitExclusions: [],
					deferred: [{ id: "scan-pending", reason: "Security review is still running" }],
				},
			},
			findings: [],
		};
		await store.putBundle(interrupted);
		const restarted = new SecurityCoordinator(
			{
				cwd: repositoryRoot,
				settings,
				authStorage,
				modelRegistry: new ModelRegistry(authStorage, path.join(temporaryRoot, "models.yml")),
				activeModel: mock.model,
			},
			{ openStore: storeFactory, gitAdapter },
		);
		expect(await restarted.status(operationId)).toMatchObject({
			operationId,
			scanId,
			phase: "failed",
			error: "安全扫描因进程重启而中断",
		});
		expect((await store.getBundle(scanId))?.scan).toMatchObject({
			status: "failed",
			error: "安全扫描因进程重启而中断",
		});
		expect((await restarted.listOperations()).map(operation => operation.operationId)).toContain(operationId);
	});
});
