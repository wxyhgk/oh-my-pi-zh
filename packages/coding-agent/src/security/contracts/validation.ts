import { type } from "@wxyhgk/omptype";
import { getSecurityContractSchemas } from "./schemas";
import type { SecurityFinding, SecurityScan, SecurityScanBundle, SecurityScanPlan } from "./types";

function schemaError(label: string, errors: type.errors): Error {
	return new Error(`${label} 未通过 schema 校验:${errors.summary}`);
}

export function parseSecurityFinding(value: unknown): SecurityFinding {
	const { securityFindingSchema } = getSecurityContractSchemas();
	const result = securityFindingSchema(value);
	if (result instanceof type.errors) throw schemaError("安全发现", result);
	return result as SecurityFinding;
}

export function parseSecurityScan(value: unknown): SecurityScan {
	const { securityScanSchema } = getSecurityContractSchemas();
	const result = securityScanSchema(value);
	if (result instanceof type.errors) throw schemaError("安全扫描", result);
	return result as SecurityScan;
}

export function parseSecurityScanPlan(value: unknown): SecurityScanPlan {
	const { securityScanPlanSchema } = getSecurityContractSchemas();
	const result = securityScanPlanSchema(value);
	if (result instanceof type.errors) throw schemaError("安全扫描计划", result);
	return result as SecurityScanPlan;
}

export function parseSecurityScanBundle(value: unknown): SecurityScanBundle {
	const { securityScanBundleSchema } = getSecurityContractSchemas();
	const result = securityScanBundleSchema(value);
	if (result instanceof type.errors) throw schemaError("安全扫描包", result);
	const bundle = result as SecurityScanBundle;
	const findingIds = new Set(bundle.findings.map(finding => finding.id));
	if (findingIds.size !== bundle.findings.length) throw new Error("安全扫描包含重复的发现 ID");
	const referencedFindingIds = new Set(bundle.scan.findingIds);
	if (referencedFindingIds.size !== bundle.scan.findingIds.length) {
		throw new Error("安全扫描清单包含重复的发现引用");
	}
	for (const findingId of referencedFindingIds) {
		if (!findingIds.has(findingId)) throw new Error(`安全扫描引用了缺失的发现:${findingId}`);
	}
	for (const findingId of findingIds) {
		if (!referencedFindingIds.has(findingId))
			throw new Error(`安全扫描清单遗漏了发现:${findingId}`);
	}
	for (const finding of bundle.findings) {
		if (finding.scanId !== bundle.scan.id) {
			throw new Error(`发现 ${finding.id} 属于 ${finding.scanId},预期为 ${bundle.scan.id}`);
		}
		const evidenceIds = new Set(finding.evidence.map(evidence => evidence.id));
		if (evidenceIds.size !== finding.evidence.length) {
			throw new Error(`发现 ${finding.id} 包含重复的证据 ID`);
		}
		const occurrenceIds = new Set(finding.occurrences.map(occurrence => occurrence.id));
		if (occurrenceIds.size !== finding.occurrences.length) {
			throw new Error(`发现 ${finding.id} 包含重复的出现 ID`);
		}
		for (const occurrence of finding.occurrences) {
			for (const evidenceId of occurrence.evidenceIds) {
				if (!evidenceIds.has(evidenceId)) {
					throw new Error(`出现 ${occurrence.id} 引用了缺失的证据:${evidenceId}`);
				}
			}
		}
	}
	return bundle;
}
