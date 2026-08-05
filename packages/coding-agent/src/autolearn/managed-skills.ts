/**
 * Managed-skills primitives for the experimental auto-learn feature.
 *
 * Managed skills are auto-generated/enhanced `SKILL.md` files kept in an
 * isolated directory (`~/.omp/agent/managed-skills`) separate from
 * user-authored skills (`~/.omp/agent/skills`). They are discovered and
 * surfaced like normal skills, but every write here is confined to
 * `getManagedSkillsDir()` — auto-management can never touch authored skills.
 */
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

/** Provider id stamped on discovered managed skills (distinguishes them from authored). */
export const MANAGED_SKILLS_PROVIDER_ID = "omp-managed";

/** Hard cap on a managed SKILL.md body to keep generated skills bounded. */
export const MAX_MANAGED_SKILL_BYTES = 64_000;

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Resolve the isolated managed-skills directory (`~/.omp/agent/managed-skills`). */
export function getManagedSkillsDir(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "managed-skills");
}

/**
 * Validate + normalize a managed-skill name. Throws on anything outside the
 * strict allowlist so a bad name can never escape `getManagedSkillsDir()`
 * (blocks `..`, slashes, empty, and uppercase).
 */
export function sanitizeSkillName(raw: string): string {
	const name = raw.trim().toLowerCase();
	if (!SKILL_NAME_PATTERN.test(name)) {
		throw new Error(
			`技能名称 "${raw}" 无效。请使用小写字母、数字和连字符(1-64 个字符,以字母或数字开头)。`,
		);
	}
	return name;
}

/**
 * Whether `name` is a safe managed-skill name (the exact post-sanitize shape).
 * Used to validate names read from disk at discovery time — a managed
 * `SKILL.md` whose `frontmatter.name` was not produced by `sanitizeSkillName`
 * (e.g. hand-placed) must not render unescaped into the system prompt.
 */
export function isValidManagedSkillName(name: string): boolean {
	return SKILL_NAME_PATTERN.test(name);
}

/**
 * Neutralize a machine-generated managed-skill description so it cannot break
 * out of the system prompt's `<skills>` listing. Managed descriptions are
 * generated from prior task content and persist across sessions, so this is a
 * trust boundary: strip control/format chars, angle brackets (`<system-directive>`
 * / `</skills>`), and Markdown fence delimiters (backticks, `~~~`), then collapse
 * to a single line. Applied on BOTH write and read so existing files are safe too.
 */
export function sanitizeManagedDescription(raw: string): string {
	return raw
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/[<>`]/g, "")
		.replace(/~{2,}/g, "~")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Serialize the minimal `name`/`description` frontmatter block via the repo's
 * YAML helper (round-trips through `parseFrontmatter`).
 */
export function toSkillFrontmatter(name: string, description: string): string {
	const frontmatter = YAML.stringify(
		{ name, description: sanitizeManagedDescription(description) },
		null,
		2,
	).trimEnd();
	return `---\n${frontmatter}\n---\n`;
}

export interface WriteManagedSkillInput {
	action: "create" | "update";
	name: string;
	description: string;
	body: string;
}

/**
 * Serialize create/update/delete on the same skill name. Both tools are
 * non-exclusive, so a parallel tool batch in one turn can run two mutations on
 * the same skill at once (e.g. an update observing the file mid-delete). This
 * per-name promise chain runs same-skill mutations in submission order while
 * different names still proceed in parallel. In-process only; cross-process
 * races are out of scope.
 */
const skillMutationChains = new Map<string, Promise<unknown>>();
function serializeSkillMutation<T>(name: string, op: () => Promise<T>): Promise<T> {
	const prev = skillMutationChains.get(name) ?? Promise.resolve();
	const run = prev.then(op, op);
	const guarded = run.catch(() => {});
	skillMutationChains.set(name, guarded);
	void guarded.finally(() => {
		if (skillMutationChains.get(name) === guarded) skillMutationChains.delete(name);
	});
	return run;
}

/**
 * Reject when the managed-skills root itself is a symlink. lstat on a child
 * follows intermediate components, so a symlinked root would let an otherwise
 * valid name write/delete outside the isolated directory (e.g. onto authored
 * skills). Checked before composing any child path.
 */
async function assertManagedRootSafe(): Promise<void> {
	const rootStat = await fs.lstat(getManagedSkillsDir()).catch(err => {
		if (isEnoent(err)) return null;
		throw err;
	});
	if (rootStat?.isSymbolicLink()) {
		throw new Error("托管技能根目录是符号链接;拒绝在托管目录之外操作。");
	}
}

const UPDATE_FILE_OPEN_FLAGS = fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW;

function assertManagedSkillFileSafeForUpdate(name: string, fileStat: Stats): void {
	if (!fileStat.isFile()) {
		throw new Error(`托管技能 "${name}" 的 SKILL.md 不是普通文件;拒绝覆盖。`);
	}
	if (fileStat.nlink > 1) {
		throw new Error(
			`托管技能 "${name}" 的 SKILL.md 有 ${fileStat.nlink} 个硬链接;拒绝覆盖可能在其他位置由用户创建的文件。`,
		);
	}
}

async function openManagedSkillFileForUpdate(name: string, file: string) {
	try {
		return await fs.open(file, UPDATE_FILE_OPEN_FLAGS);
	} catch (err) {
		if ((err as { code?: string }).code === "ELOOP") {
			throw new Error(`托管技能 "${name}" 的 SKILL.md 是符号链接;拒绝覆盖。`);
		}
		throw err;
	}
}

/** Create or update a managed `SKILL.md`. Returns the resolved file path. */
export async function writeManagedSkill(input: WriteManagedSkillInput): Promise<{ path: string }> {
	const name = sanitizeSkillName(input.name);
	const description = sanitizeManagedDescription(input.description);
	const body = input.body.trim();
	// Reject empty content: an all-whitespace/control description sanitizes to ""
	// and the `requireDescription` discovery scan then silently drops the skill,
	// so the tool would report success for a skill that never appears.
	if (!description) {
		throw new Error(`托管技能 "${name}" 需要非空的描述。`);
	}
	if (!body) {
		throw new Error(`托管技能 "${name}" 需要非空的正文。`);
	}
	const content = `${toSkillFrontmatter(name, description)}\n${body}\n`;
	// Cap the UTF-8 byte size of the FINAL file (body + description + frontmatter),
	// not the UTF-16 code-unit length of the body alone.
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > MAX_MANAGED_SKILL_BYTES) {
		throw new Error(
			`托管技能为 ${bytes} 字节;上限为 ${MAX_MANAGED_SKILL_BYTES} 字节。请精简正文或描述。`,
		);
	}
	return serializeSkillMutation(name, async () => {
		await assertManagedRootSafe();
		const dir = path.join(getManagedSkillsDir(), name);
		const file = path.join(dir, "SKILL.md");
		// Reject a symlinked skill directory: an intermediate symlink would let the
		// write escape the isolated managed root. lstat does not follow the final
		// component, so a symlinked `dir` is caught here.
		const dirStat = await fs.lstat(dir).catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		if (dirStat?.isSymbolicLink()) {
			throw new Error(
				`托管技能 "${name}" 经由符号链接解析;拒绝在托管目录之外写入。`,
			);
		}
		if (input.action === "create") {
			await fs.mkdir(dir, { recursive: true });
			// O_CREAT|O_EXCL ("wx"): atomic create that fails if the file already
			// exists (closing the check-then-write race) and refuses a symlinked SKILL.md.
			try {
				await fs.writeFile(file, content, { flag: "wx" });
			} catch (err) {
				if ((err as { code?: string }).code === "EEXIST") {
					throw new Error(`托管技能 "${name}" 已存在。请使用 action "update" 修改。`);
				}
				throw err;
			}
			return { path: file };
		}
		// update: the file must already exist, be a plain managed file, and must
		// not share an inode with a user-authored file via hard link. Open the
		// checked file handle before truncating so a path swap after lstat cannot
		// redirect the write into a symlink or newly hard-linked target.
		const fileStat = await fs.lstat(file).catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		if (fileStat === null) {
			throw new Error(`托管技能 "${name}" 不存在。请使用 action "create" 添加。`);
		}
		if (fileStat.isSymbolicLink()) {
			throw new Error(`托管技能 "${name}" 的 SKILL.md 是符号链接;拒绝覆盖。`);
		}
		assertManagedSkillFileSafeForUpdate(name, fileStat);
		const handle = await openManagedSkillFileForUpdate(name, file);
		try {
			const openStat = await handle.stat();
			assertManagedSkillFileSafeForUpdate(name, openStat);
			await handle.truncate(0);
			await handle.writeFile(content);
		} finally {
			await handle.close();
		}
		return { path: file };
	});
}

/** Delete a managed skill directory. Throws when it does not exist. */
export async function deleteManagedSkill(name: string): Promise<void> {
	const safe = sanitizeSkillName(name);
	await serializeSkillMutation(safe, async () => {
		await assertManagedRootSafe();
		const dir = path.join(getManagedSkillsDir(), safe);
		// Refuse to follow a symlinked skill directory (rm would delete the target).
		const dirStat = await fs.lstat(dir).catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		if (dirStat?.isSymbolicLink()) {
			throw new Error(`托管技能 "${safe}" 是符号链接;拒绝在托管目录之外删除。`);
		}
		try {
			await fs.rm(dir, { recursive: true });
		} catch (err) {
			if (isEnoent(err)) {
				throw new Error(`托管技能 "${safe}" 不存在。`);
			}
			throw err;
		}
	});
}
