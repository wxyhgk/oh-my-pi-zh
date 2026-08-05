import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadSkills, resetActiveSkillsForTests, setActiveSkills } from "@wxyhgk/pi-coding-agent/extensibility/skills";
import { parseInternalUrl } from "@wxyhgk/pi-coding-agent/internal-urls/parse";
import { SkillProtocolHandler } from "@wxyhgk/pi-coding-agent/internal-urls/skill-protocol";

function makeSkillMd(name: string, dir: string) {
	return `---\nname: ${name}\ndescription: ${name} skill.\n---\n\n# ${name} from ${dir}\n`;
}

const ALL_DEFAULT_SOURCES_DISABLED = {
	enableCodexUser: false,
	enableClaudeUser: false,
	enableClaudeProject: false,
	enablePiUser: false,
	enablePiProject: false,
	enableAgentsUser: false,
	enableAgentsProject: false,
} as const;

describe("skill:// resolution honors skills.customDirectories (#7190)", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		resetActiveSkillsForTests();
		for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
		tempDirs.length = 0;
	});

	it("resolves a skill loaded from a custom directory", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-custom-skills-"));
		tempDirs.push(tempDir);
		const skillDir = path.join(tempDir, "my-custom-skill");
		await fs.mkdir(skillDir, { recursive: true });
		await Bun.write(path.join(skillDir, "SKILL.md"), makeSkillMd("my-custom-skill", tempDir));

		const { skills } = await loadSkills({
			...ALL_DEFAULT_SOURCES_DISABLED,
			customDirectories: [tempDir],
		});
		setActiveSkills(skills);

		const handler = new SkillProtocolHandler();
		const resource = await handler.resolve(parseInternalUrl("skill://my-custom-skill/"));
		expect(resource.sourcePath).toBe(path.join(skillDir, "SKILL.md"));
		expect(resource.content).toContain(`from ${tempDir}`);
	});

	it("keeps first-wins across multiple custom directories", async () => {
		const dirA = await fs.mkdtemp(path.join(os.tmpdir(), "pi-custom-a-"));
		tempDirs.push(dirA);
		const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "pi-custom-b-"));
		tempDirs.push(dirB);
		const skillA = path.join(dirA, "same-name");
		const skillB = path.join(dirB, "same-name");
		await fs.mkdir(skillA, { recursive: true });
		await fs.mkdir(skillB, { recursive: true });
		await Bun.write(path.join(skillA, "SKILL.md"), makeSkillMd("same-name", dirA));
		await Bun.write(path.join(skillB, "SKILL.md"), makeSkillMd("same-name", dirB));

		const { skills, warnings } = await loadSkills({
			...ALL_DEFAULT_SOURCES_DISABLED,
			customDirectories: [dirA, dirB],
		});
		setActiveSkills(skills);

		const dup = skills.find(s => s.name === "same-name");
		expect(dup).toBeDefined();
		// Same-source (custom) duplicates keep first-wins: dirA claims the name.
		expect(dup!.filePath).toBe(path.join(skillA, "SKILL.md"));
		expect(warnings.some(w => w.message.includes("名称冲突"))).toBe(true);

		const handler = new SkillProtocolHandler();
		const resource = await handler.resolve(parseInternalUrl("skill://same-name/"));
		expect(resource.sourcePath).toBe(path.join(skillA, "SKILL.md"));
	});

	it("lets a custom-directory skill override a same-named default-path skill", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-default-skill-"));
		tempDirs.push(cwd);
		const customDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-custom-skill-"));
		tempDirs.push(customDir);

		// A default discovery path (Claude project skills) claims the name first.
		const defaultSkill = path.join(cwd, ".claude", "skills", "shared-name");
		await fs.mkdir(defaultSkill, { recursive: true });
		await Bun.write(path.join(defaultSkill, "SKILL.md"), makeSkillMd("shared-name", "default"));

		// The explicitly configured custom directory holds the same name.
		const customSkill = path.join(customDir, "shared-name");
		await fs.mkdir(customSkill, { recursive: true });
		await Bun.write(path.join(customSkill, "SKILL.md"), makeSkillMd("shared-name", "custom"));

		const { skills } = await loadSkills({
			cwd,
			enableCodexUser: false,
			enableClaudeUser: false,
			enableClaudeProject: true,
			enablePiUser: false,
			enablePiProject: false,
			enableAgentsUser: false,
			enableAgentsProject: false,
			customDirectories: [customDir],
		});
		setActiveSkills(skills);

		const dup = skills.find(s => s.name === "shared-name");
		expect(dup).toBeDefined();
		// The explicitly configured custom directory is the higher-priority source.
		expect(dup!.filePath).toBe(path.join(customSkill, "SKILL.md"));

		const handler = new SkillProtocolHandler();
		const resource = await handler.resolve(parseInternalUrl("skill://shared-name/"));
		expect(resource.sourcePath).toBe(path.join(customSkill, "SKILL.md"));
		expect(resource.content).toContain("from custom");
	});
});
