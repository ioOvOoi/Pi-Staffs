/**
 * 技能（票 10）与同步（票 23）。
 *
 * 技能本体随包发布在 <repo>/skills/<name>/SKILL.md：pi 会自动发现包的 skills/ 目录，
 * 所以「装了包就能用」。sync 只服务想把技能放到全局目录（~/.pi/agent/skills/pi-staffs）的场景。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type StaffsSkill = { name: string; description: string; path: string };

const skillsRoot = (): string =>
   join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

/** 扫描随包技能：没有 name/description 的目录直接跳过（无效 frontmatter 加载不了）。 */
export const listStaffsSkills = (root: string = skillsRoot()): StaffsSkill[] => {
   if (!existsSync(root)) return [];
   const skills: StaffsSkill[] = [];
   for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name, "SKILL.md");
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf8");
      const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim();
      const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim();
      if (!name || !description) continue;
      skills.push({ name, description, path });
   }
   return skills.sort((a, b) => a.name.localeCompare(b.name));
};

/** 同步到全局技能目录；同名目录直接覆盖（技能是包的一部分）。 */
export const syncStaffsSkills = (
   target: string = join(homedir(), ".pi", "agent", "skills", "pi-staffs"),
): { target: string; copied: string[] } => {
   const skills = listStaffsSkills();
   mkdirSync(target, { recursive: true });
   for (const skill of skills)
      cpSync(dirname(skill.path), join(target, skill.name), { recursive: true });
   return { target, copied: skills.map((skill) => skill.name) };
};
