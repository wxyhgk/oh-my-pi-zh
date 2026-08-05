import { type } from "@wxyhgk/omptype";
import type { CommitAgentState } from "../../../commit/agentic/state";
import { CHANGELOG_CATEGORIES, type ChangelogCategory } from "../../../commit/types";
import type { CustomTool } from "../../../extensibility/custom-tools/types";

const changelogCategoryProperties = {
	"Breaking Changes?": "string[]",
	"Added?": "string[]",
	"Changed?": "string[]",
	"Deprecated?": "string[]",
	"Removed?": "string[]",
	"Fixed?": "string[]",
	"Security?": "string[]",
} as const;

const changelogEntriesSchema = type({
	...changelogCategoryProperties,
});

const changelogEntrySchema = type({
	path: "string",
	entries: changelogEntriesSchema,
	"deletions?": changelogEntriesSchema.describe("要移除的条目"),
});

const proposeChangelogSchema = type({
	entries: changelogEntrySchema.array(),
});

interface ChangelogResponse {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

const allowedCategories = new Set<ChangelogCategory>(CHANGELOG_CATEGORIES);

export function createProposeChangelogTool(
	state: CommitAgentState,
	changelogTargets: string[],
): CustomTool<typeof proposeChangelogSchema> {
	return {
		name: "propose_changelog",
		label: "提出变更日志",
		description: "为指定的 CHANGELOG.md 文件提供变更日志条目。",
		parameters: proposeChangelogSchema,
		async execute(_toolCallId, params) {
			const errors: string[] = [];
			const warnings: string[] = [];
			const targets = new Set(changelogTargets);
			const seen = new Set<string>();

			const normalized = params.entries.map(entry => {
				const cleaned: Record<string, string[]> = {};
				const entries = entry.entries as Record<string, string[]>;
				for (const [category, values] of Object.entries(entries)) {
					if (!allowedCategories.has(category as ChangelogCategory)) {
						errors.push(`未知的变更日志分类:${entry.path}(${category})`);
						continue;
					}
					if (!Array.isArray(values)) {
						errors.push(`无效的变更日志条目:${entry.path}(${category})`);
						continue;
					}
					const items = values.map(value => value.trim().replace(/\.$/, "")).filter(value => value.length > 0);
					if (items.length > 0) {
						cleaned[category] = Array.from(new Set(items));
					}
				}

				let cleanedDeletions: Record<string, string[]> | undefined;
				if (entry.deletions) {
					cleanedDeletions = {};
					const deletions = entry.deletions as Record<string, string[]>;
					for (const [category, values] of Object.entries(deletions)) {
						if (!allowedCategories.has(category as ChangelogCategory)) {
							errors.push(`未知的删除分类:${entry.path}(${category})`);
							continue;
						}
						if (!Array.isArray(values)) {
							errors.push(`无效的删除条目:${entry.path}(${category})`);
							continue;
						}
						const items = values.map(value => value.trim()).filter(value => value.length > 0);
						if (items.length > 0) {
							cleanedDeletions[category] = Array.from(new Set(items));
						}
					}
					if (Object.keys(cleanedDeletions).length === 0) {
						cleanedDeletions = undefined;
					}
				}

				if (Object.keys(cleaned).length === 0 && !cleanedDeletions) {
					warnings.push(`未为 ${entry.path} 提供变更日志条目。`);
				}
				return {
					path: entry.path,
					entries: cleaned,
					deletions: cleanedDeletions,
				};
			});

			for (const entry of normalized) {
				if (targets.size > 0 && !targets.has(entry.path)) {
					errors.push(`不应有变更日志:${entry.path}`);
					continue;
				}
				if (seen.has(entry.path)) {
					errors.push(`重复的变更日志条目:${entry.path}`);
					continue;
				}
				seen.add(entry.path);
			}

			if (targets.size > 0) {
				for (const target of targets) {
					if (!seen.has(target)) {
						errors.push(`缺少 ${target} 的变更日志条目`);
					}
				}
			}

			const response: ChangelogResponse = {
				valid: errors.length === 0,
				errors,
				warnings,
			};

			if (response.valid) {
				state.changelogProposal = { entries: normalized };
			}

			let text = response.valid ? "变更日志条目已接受。" : "变更日志校验失败。";
			if (response.errors.length > 0) {
				text += `\n\n错误:\n${response.errors.map(e => `- ${e}`).join("\n")}`;
			}
			if (response.warnings.length > 0) {
				text += `\n\n警告:\n${response.warnings.map(w => `- ${w}`).join("\n")}`;
			}
			return {
				content: [{ type: "text", text }],
				details: response,
			};
		},
	};
}
