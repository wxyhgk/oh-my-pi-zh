import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, ToolTier } from "@oh-my-pi/pi-agent-core";
import securityScanDescription from "../prompts/tools/security-scan.md" with { type: "text" };
import { selectSecurityAccount } from "../security/auth";
import {
	CodexSecurityCloudClient,
	type CodexSecurityCloudConfiguration,
	type CodexSecurityCloudStats,
	pullCodexSecurityCloudResults,
} from "../security/cloud";
import { createSecurityEvidenceId, type SecurityEvidence, type SecurityValidationStatus } from "../security/contracts";
import type { SecurityOperationSnapshot } from "../security/coordinator";
import { getSecurityCoordinator } from "../security/coordinator";
import type { SecurityTargetRequest } from "../security/preflight";
import { SecurityStore } from "../security/store";
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

const securityScanSchema = type({
	action:
		"'preflight' | 'start' | 'status' | 'cancel' | 'validate' | 'cloud_scans' | 'cloud_start' | 'cloud_status' | 'cloud_pull'",
	"plan_id?": "string",
	"operation_id?": "string",
	"target_kind?": "'repository' | 'scoped_path' | 'ref_diff' | 'working_tree'",
	"include_paths?": "string[]",
	"exclude_paths?": "string[]",
	"base_revision?": "string",
	"head_revision?": "string",
	"knowledge_base_paths?": "string[]",
	"output_root?": "string",
	"archive_existing?": "boolean",
	"credential_id?": "number.integer >= 1",
	"scan_id?": "string",
	"finding_id?": "string",
	"validation_status?": "'unvalidated' | 'validated' | 'rejected' | 'partial' | 'error'",
	"validation_summary?": "string",
	"validation_evidence?": type({ label: "string > 0", explanation: "string" }).array(),
	"cloud_configuration_id?": "string",
	"repository_id?": "string",
	"repository_url?": "string",
	"environment_id?": "string",
	"lookback_days?": "number.integer >= 1 | 'all'",
});

type SecurityScanParams = typeof securityScanSchema.infer;

export interface SecurityScanToolDetails {
	action: SecurityScanParams["action"];
	plan?: { id: string; fingerprint: string };
	operation?: SecurityOperationSnapshot;
	cancelled?: boolean;
	finding?: { id: string; validationStatus: SecurityValidationStatus };
	cloudConfigurations?: CodexSecurityCloudConfiguration[];
	cloudStats?: CodexSecurityCloudStats;
	cloudScan?: { id: string; repositoryUrl: string };
	importedScan?: { id: string; findingCount: number };
}

function targetFromParams(params: SecurityScanParams): SecurityTargetRequest {
	const common = { includePaths: params.include_paths, excludePaths: params.exclude_paths };
	switch (params.target_kind ?? "repository") {
		case "scoped_path": {
			if (!params.include_paths?.some(value => value.trim().length > 0)) {
				throw new ToolError("scoped_path 安全扫描至少需要一个 include path");
			}
			return { kind: "scoped_path", includePaths: params.include_paths, excludePaths: params.exclude_paths };
		}
		case "working_tree":
			return { kind: "working_tree", ...common };
		case "ref_diff":
			if (!params.base_revision || !params.head_revision) {
				throw new ToolError("ref_diff 预检需要 base_revision 和 head_revision");
			}
			return {
				kind: "ref_diff",
				baseRevision: params.base_revision,
				headRevision: params.head_revision,
				...common,
			};
		default:
			return { kind: "repository", ...common };
	}
}

function requireValue(value: string | undefined, label: string): string {
	if (!value?.trim()) throw new ToolError(`${label} 是此操作所必需的`);
	return value.trim();
}

function cloudClientForSession(session: ToolSession, credentialId?: number): CodexSecurityCloudClient {
	if (!session.authStorage) throw new ToolError("Codex Security 云端需要认证注册表");
	const account = selectSecurityAccount(
		session.authStorage,
		"openai-codex",
		credentialId,
		session.getSessionId?.() ?? undefined,
	);
	return new CodexSecurityCloudClient({ authStorage: session.authStorage, account });
}

function textResult(text: string, details: SecurityScanToolDetails): AgentToolResult<SecurityScanToolDetails> {
	return { content: [{ type: "text", text }], details };
}

export class SecurityScanTool implements AgentTool<typeof securityScanSchema, SecurityScanToolDetails> {
	readonly name = "security_scan";
	readonly approval: ToolTier = "exec";
	readonly label = "安全扫描";
	readonly loadMode = "discoverable";
	readonly summary = "运行 OMP 原生扫描与显式的 Codex Security 云端操作";
	readonly description = securityScanDescription.trim();
	readonly parameters = securityScanSchema;
	readonly strict = true;

	constructor(readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: SecurityScanParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<SecurityScanToolDetails>> {
		if (!this.session.settings.get("security.enabled")) {
			throw new ToolError("安全功能已禁用。使用 security_scan 前请启用 security.enabled。");
		}
		const coordinatorForSession = () => {
			if (!this.session.modelRegistry || !this.session.authStorage) {
				throw new ToolError("安全扫描需要会话模型与认证注册表");
			}
			return getSecurityCoordinator({
				cwd: this.session.cwd,
				settings: this.session.settings,
				authStorage: this.session.authStorage,
				modelRegistry: this.session.modelRegistry,
				activeModel: this.session.getActiveModel?.(),
				sessionId: this.session.getSessionId?.() ?? undefined,
				agentId: this.session.getAgentId?.() ?? undefined,
				asyncJobManager: this.session.asyncJobManager,
			});
		};
		switch (params.action) {
			case "preflight": {
				const model = this.session.getActiveModel?.();
				const plan = await coordinatorForSession().preflight({
					target: targetFromParams(params),
					knowledgeBasePaths: params.knowledge_base_paths,
					outputRoot: params.output_root,
					archiveExisting: params.archive_existing,
					credentialId: params.credential_id,
					model,
					signal,
				});
				return textResult(
					[
						`安全计划 ${plan.id} 已就绪。`,
						`指纹:${plan.fingerprint}。`,
						`使用 action=start 和 plan_id=${plan.id} 启动它。`,
					].join(" "),
					{ action: params.action, plan: { id: plan.id, fingerprint: plan.fingerprint } },
				);
			}
			case "start": {
				const operation = await coordinatorForSession().start({
					planId: requireValue(params.plan_id, "plan_id"),
				});
				return textResult(`安全扫描 ${operation.scanId} 已以 ${operation.operationId} 启动。`, {
					action: params.action,
					operation,
				});
			}
			case "status": {
				const operationId = requireValue(params.operation_id, "operation_id");
				const operation = await coordinatorForSession().status(operationId);
				if (!operation) throw new ToolError(`未知的安全操作:${operationId}`);
				return textResult(
					`安全扫描 ${operation.scanId}:${operation.phase};${operation.findingCount} 个发现。`,
					{ action: params.action, operation },
				);
			}
			case "cancel": {
				const operationId = requireValue(params.operation_id, "operation_id");
				const cancelled = await coordinatorForSession().cancel(operationId);
				return textResult(
					cancelled ? `已请求取消 ${operationId}。` : `没有运行中的操作 ${operationId}。`,
					{
						action: params.action,
						cancelled,
						operation: (await coordinatorForSession().status(operationId)) ?? undefined,
					},
				);
			}
			case "cloud_scans": {
				const configurations = await cloudClientForSession(
					this.session,
					params.credential_id,
				).listAllConfigurations(signal);
				return textResult(
					configurations.length === 0
						? "没有可用的 Codex Security 云端扫描配置。"
						: configurations
								.map(
									item =>
										`${item.id} ${item.currentStep ?? "未知"} repo=${item.repositoryId} environment=${item.environmentId} ${item.repositoryUrl}`,
								)
								.join("\n"),
					{ action: params.action, cloudConfigurations: configurations },
				);
			}
			case "cloud_start": {
				const configuration = await cloudClientForSession(this.session, params.credential_id).startScan({
					repositoryId: requireValue(params.repository_id, "repository_id"),
					repositoryUrl: requireValue(params.repository_url, "repository_url"),
					environmentId: requireValue(params.environment_id, "environment_id"),
					lookbackDays: params.lookback_days,
					signal,
				});
				return textResult(
					`Codex Security 云端扫描 ${configuration.id} 已为 ${configuration.repositoryUrl} 启动。这会消耗云端扫描额度。`,
					{
						action: params.action,
						cloudScan: { id: configuration.id, repositoryUrl: configuration.repositoryUrl },
					},
				);
			}
			case "cloud_status": {
				const stats = await cloudClientForSession(this.session, params.credential_id).getStats(
					requireValue(params.cloud_configuration_id, "cloud_configuration_id"),
					signal,
				);
				return textResult(
					`Codex Security 云端扫描 ${stats.configurationId}:${stats.currentStep ?? "未知"};${stats.finishedCommits} 个已完成提交,${stats.pendingCommits} 个待处理。`,
					{ action: params.action, cloudStats: stats },
				);
			}
			case "cloud_pull": {
				const store = await SecurityStore.openForCwd(this.session.cwd, { signal });
				const bundle = await pullCodexSecurityCloudResults({
					client: cloudClientForSession(this.session, params.credential_id),
					configurationId: requireValue(params.cloud_configuration_id, "cloud_configuration_id"),
					store,
					signal,
				});
				return textResult(
					`已将 ${bundle.findings.length} 个 Codex Security 云端发现导入为安全扫描 ${bundle.scan.id}。`,
					{
						action: params.action,
						importedScan: { id: bundle.scan.id, findingCount: bundle.findings.length },
					},
				);
			}
			case "validate": {
				const scanId = requireValue(params.scan_id, "scan_id");
				const findingId = requireValue(params.finding_id, "finding_id");
				const status = params.validation_status;
				if (!status) throw new ToolError("此操作需要 validation_status");
				const summary = requireValue(params.validation_summary, "validation_summary");
				const store = await SecurityStore.openForCwd(this.session.cwd, { signal });
				const finding = await store.getFinding(scanId, findingId);
				if (!finding) throw new ToolError(`未知的安全发现:${findingId}`);
				const evidence: SecurityEvidence[] = (params.validation_evidence ?? []).map((item, index) => ({
					id: createSecurityEvidenceId(
						finding.fingerprint,
						`validation:${item.label}`,
						finding.evidence.length + index,
					),
					kind: "validation",
					label: item.label,
					explanation: item.explanation,
				}));
				const updated = await store.updateValidation(
					scanId,
					findingId,
					{
						status,
						summary,
						evidenceIds: evidence.map(item => item.id),
						validatedAt: new Date().toISOString(),
					},
					evidence,
				);
				return textResult(`发现 ${updated.id} 的验证状态现为 ${updated.validation.status}。`, {
					action: params.action,
					finding: { id: updated.id, validationStatus: updated.validation.status },
				});
			}
		}
	}
}
