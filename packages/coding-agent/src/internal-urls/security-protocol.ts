import * as path from "node:path";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { isSettingsInitialized, settings } from "../config/settings";
import { getDefault } from "../config/settings-schema";
import type { SecurityFinding } from "../security/contracts";
import { createPublicSecurityScan, redactPrivateSecurityMetadata } from "../security/provenance";
import { createSecurityResource } from "../security/resource-output";
import type { SecurityScanSummary } from "../security/store";
import { SecurityStore } from "../security/store";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

export type SecurityStoreResolver = (cwd: string, signal?: AbortSignal) => Promise<SecurityStore>;

export function isSecurityEnabled(): boolean {
	if (!isSettingsInitialized()) return getDefault("security.enabled");
	try {
		return settings.get("security.enabled");
	} catch {
		return getDefault("security.enabled");
	}
}

function securityEnabledFromContext(context?: ResolveContext): boolean | undefined {
	if (!context?.settings || typeof context.settings !== "object") return undefined;
	try {
		const get = Reflect.get(context.settings, "get");
		if (typeof get !== "function") return undefined;
		const enabled = Reflect.apply(get, context.settings, ["security.enabled"]);
		return typeof enabled === "boolean" ? enabled : undefined;
	} catch {
		return undefined;
	}
}

const SECURITY_DISABLED_MESSAGE =
	"security:// 已禁用。请通过设置 `security.enabled = true`(设置 → 工具 → 安全)启用。";

export class SecurityDisabledError extends Error {
	constructor() {
		super(SECURITY_DISABLED_MESSAGE);
		this.name = "SecurityDisabledError";
	}
}

function splitSecurityPath(url: InternalUrl): string[] {
	const host = url.rawHost || url.hostname;
	const pathname = (url.rawPathname ?? url.pathname).replace(/^\/+/, "");
	return [host, ...pathname.split("/")].filter(Boolean).map(segment => decodeURIComponent(segment));
}

function formatScans(scans: SecurityScanSummary[]): string {
	if (scans.length === 0) return "# 安全扫描\n\n此项目未存储任何扫描。\n";
	const rows = scans.map(
		scan =>
			`- \`${scan.id}\` — ${scan.status};${scan.findingCount} 个发现;${scan.producer.name};${scan.createdAt}`,
	);
	return `# 安全扫描\n\n${rows.join("\n")}\n`;
}

function formatFinding(finding: SecurityFinding): string {
	const locations = finding.occurrences.flatMap(occurrence => occurrence.locations);
	const locationLines = locations.map(location => {
		const end = location.endLine && location.endLine !== location.startLine ? `-${location.endLine}` : "";
		return [
			`- \`${sanitizeText(location.path)}:${location.startLine}${end}\``,
			location.role ? ` (${sanitizeText(location.role)})` : "",
		].join("");
	});
	const evidence = finding.evidence.map(
		item => `- **${sanitizeText(item.label)}** — ${sanitizeText(item.explanation)}`,
	);
	return [
		`# ${sanitizeText(finding.title)}`,
		"",
		`- ID: \`${finding.id}\``,
		`- 规则:\`${sanitizeText(finding.ruleId)}\``,
		`- 严重级别:**${finding.severity.level}**`,
		`- 置信度:**${finding.confidence.level}**`,
		`- 处置:**${finding.disposition.status}**`,
		`- 指纹:\`${finding.fingerprint}\``,
		"",
		"## 摘要",
		"",
		sanitizeText(finding.summary),
		"",
		"## 位置",
		"",
		...(locationLines.length > 0 ? locationLines : ["未记录源代码位置。"]),
		"",
		"## 证据",
		"",
		...(evidence.length > 0 ? evidence : ["未记录展开的证据。"]),
		"",
		"## 修复建议",
		"",
		sanitizeText(finding.remediation ?? "未记录修复指导。"),
		"",
	].join("\n");
}

export class SecurityProtocolHandler implements ProtocolHandler {
	readonly scheme = "security";
	readonly immutable = true;
	readonly #resolveStore: SecurityStoreResolver;
	readonly #enabled: () => boolean;

	constructor(
		resolveStore: SecurityStoreResolver = (cwd, signal) => SecurityStore.openForCwd(cwd, { signal }),
		enabled: () => boolean = isSecurityEnabled,
	) {
		this.#resolveStore = resolveStore;
		this.#enabled = enabled;
	}

	async #store(context?: ResolveContext): Promise<SecurityStore> {
		return this.#resolveStore(path.resolve(context?.cwd ?? process.cwd()), context?.signal);
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		if (!(securityEnabledFromContext(context) ?? this.#enabled())) throw new SecurityDisabledError();
		const parts = splitSecurityPath(url);
		const store = await this.#store(context);
		if (parts.length === 0) {
			return createSecurityResource({
				url: "security://",
				content: [
					"# 安全",
					"",
					"OMP 软件安全分析资源。该命名空间只读;如需修改请使用明确的安全命令或工具。",
					"",
					"- `security://scans` — 列出扫描",
					"",
				].join("\n"),
				contentType: "text/markdown",
				isDirectory: true,
			});
		}
		if (parts[0] !== "scans") throw new Error(`未知的安全资源:security://${parts.join("/")}`);
		if (parts.length === 1) {
			return createSecurityResource({
				url: "security://scans",
				content: formatScans(await store.listScans()),
				contentType: "text/markdown",
				isDirectory: true,
			});
		}
		const scanId = parts[1];
		const bundle = await store.getBundle(scanId);
		if (!bundle) throw new Error(`未知的安全扫描:${scanId}`);
		if (parts.length === 2) {
			return createSecurityResource({
				url: `security://scans/${scanId}`,
				content: [
					`# 安全扫描 ${scanId}`,
					"",
					`- 状态:**${bundle.scan.status}**`,
					`- 提供方:**${sanitizeText(bundle.scan.producer.name)}**`,
					`- 发现数:**${bundle.findings.length}**`,
					`- 覆盖率:**${bundle.scan.coverage.completeness}**`,
					`- 目标:\`${sanitizeText(bundle.scan.target.displayName)}\``,
					"",
					"资源:`manifest`、`findings`、`coverage`、`report`、`sarif`、`provenance`。",
					"",
				].join("\n"),
				contentType: "text/markdown",
				isDirectory: true,
			});
		}
		switch (parts[2]) {
			case "manifest":
				if (parts.length !== 3) throw new Error(`未知的安全资源:security://${parts.join("/")}`);
				return createSecurityResource({
					url: `security://scans/${scanId}/manifest`,
					content: `${JSON.stringify(createPublicSecurityScan(bundle.scan, { includePlan: true }), null, 2)}\n`,
					contentType: "application/json",
				});
			case "findings": {
				if (parts.length === 3) {
					const listing = bundle.findings.map(finding =>
						[
							`- \`${finding.id}\` **${finding.severity.level}** — ${sanitizeText(finding.title)}`,
							` (\`${sanitizeText(finding.ruleId)}\`)`,
						].join(""),
					);
					return createSecurityResource({
						url: `security://scans/${scanId}/findings`,
						content: `# ${scanId} 的发现\n\n${listing.length > 0 ? listing.join("\n") : "无发现。"}\n`,
						contentType: "text/markdown",
						isDirectory: true,
					});
				}
				if (parts.length !== 4) throw new Error(`未知的安全资源:security://${parts.join("/")}`);
				const findingId = parts[3];
				const finding = await store.getFinding(scanId, findingId);
				if (!finding) throw new Error(`未知的安全发现:${findingId}`);
				return createSecurityResource({
					url: `security://scans/${scanId}/findings/${findingId}`,
					content: formatFinding(finding),
					contentType: "text/markdown",
				});
			}
			case "coverage":
				if (parts.length !== 3) throw new Error(`未知的安全资源:security://${parts.join("/")}`);
				return createSecurityResource({
					url: `security://scans/${scanId}/coverage`,
					content: `${JSON.stringify(bundle.scan.coverage, null, 2)}\n`,
					contentType: "application/json",
				});
			case "report":
				if (parts.length !== 3) throw new Error(`未知的安全资源:security://${parts.join("/")}`);
				if (bundle.report === undefined) throw new Error(`安全扫描 ${scanId} 没有报告`);
				return createSecurityResource({
					url: `security://scans/${scanId}/report`,
					content: bundle.report,
					contentType: "text/markdown",
				});
			case "sarif":
				if (parts.length !== 3) throw new Error(`未知的安全资源:security://${parts.join("/")}`);
				if (bundle.sarif === undefined) throw new Error(`安全扫描 ${scanId} 没有 SARIF 导出`);
				return createSecurityResource({
					url: `security://scans/${scanId}/sarif`,
					content: `${JSON.stringify(bundle.sarif, null, 2)}\n`,
					contentType: "application/json",
				});
			case "provenance":
				if (parts.length !== 3) throw new Error(`未知的安全资源:security://${parts.join("/")}`);
				return createSecurityResource({
					url: `security://scans/${scanId}/provenance`,
					content: `${JSON.stringify(redactPrivateSecurityMetadata(bundle.scan.provenance), null, 2)}\n`,
					contentType: "application/json",
				});
			default:
				throw new Error(`未知的安全资源:security://${parts.join("/")}`);
		}
	}

	async complete(query = "", context?: ResolveContext): Promise<UrlCompletion[]> {
		if (!(securityEnabledFromContext(context) ?? this.#enabled())) return [];
		const store = await this.#store(context);
		const scans = await store.listScans();
		const candidates: UrlCompletion[] = [{ value: "scans", label: "扫描", description: "已存储的安全扫描" }];
		for (const scan of scans.slice(0, 50)) {
			const prefix = `scans/${scan.id}`;
			candidates.push({
				value: prefix,
				label: scan.id,
				description: `${scan.status};${scan.findingCount} 个发现`,
			});
			for (const child of ["manifest", "findings", "coverage", "report", "sarif", "provenance"]) {
				candidates.push({ value: `${prefix}/${child}`, label: `${scan.id}/${child}` });
			}
		}
		const normalizedQuery = query.trim().toLowerCase();
		if (!normalizedQuery) return candidates;
		return candidates.filter(candidate =>
			[candidate.value, candidate.label ?? "", candidate.description ?? ""].some(value =>
				value.toLowerCase().includes(normalizedQuery),
			),
		);
	}
}
