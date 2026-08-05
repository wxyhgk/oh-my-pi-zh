import type { ConventionalAnalysis } from "../../commit/types";

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

export function validateSummary(summary: string, maxChars: number): ValidationResult {
	const errors: string[] = [];
	if (!summary.trim()) {
		errors.push("摘要为空");
	}
	if (summary.length > maxChars) {
		errors.push(`摘要超过 ${maxChars} 个字符`);
	}
	if (summary.trimEnd().endsWith(".")) {
		errors.push("摘要不能以句号结尾");
	}
	if (summary.includes("\n")) {
		errors.push("摘要必须是单行");
	}
	return { valid: errors.length === 0, errors };
}

export function validateScope(scope: string | null): ValidationResult {
	if (!scope) return { valid: true, errors: [] };
	const errors: string[] = [];
	const segments = scope.split("/");
	if (segments.length > 2) {
		errors.push("作用域最多包含两个段");
	}
	for (const segment of segments) {
		if (!segment) {
			errors.push("作用域段不能为空");
			continue;
		}
		if (segment !== segment.toLowerCase()) {
			errors.push("作用域必须为小写");
		}
		if (!/^[a-z0-9][a-z0-9-_]*$/.test(segment)) {
			errors.push(`作用域段包含无效字符:${segment}`);
		}
	}
	return { valid: errors.length === 0, errors };
}

export function validateAnalysis(analysis: ConventionalAnalysis): ValidationResult {
	const errors: string[] = [];
	const scopeResult = validateScope(analysis.scope);
	if (!scopeResult.valid) {
		errors.push(...scopeResult.errors);
	}
	for (const detail of analysis.details) {
		if (!detail.text.trim()) {
			errors.push("详情文本为空");
			continue;
		}
		if (!detail.text.trim().endsWith(".")) {
			errors.push(`详情必须以句号结尾:${detail.text}`);
		}
		if (detail.text.length > 120) {
			errors.push(`详情超过 120 个字符:${detail.text}`);
		}
	}
	return { valid: errors.length === 0, errors };
}
