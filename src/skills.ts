/**
 * 技能（票 10）与同步（票 23）。
 *
 * 技能本体随包发布在 <repo>/skills/<name>/SKILL.md：pi 会自动发现包的 skills/ 目录，
 * 所以「装了包就能用」。sync 只服务想把技能放到全局目录（~/.pi/agent/skills/pi-staffs）的场景。
 */
import {
   cpSync,
   existsSync,
   mkdirSync,
   readdirSync,
   readFileSync,
   rmSync,
   writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type StaffsSkill = { name: string; description: string; path: string };

const skillsRoot = (): string =>
   join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

/** 扫描随包技能：没有 name/description 的目录直接跳过（无效 frontmatter 加载不了）。 */
export const listStaffsSkills = (
   root: string = skillsRoot(),
): StaffsSkill[] => {
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

/** 目标目录里记录「上次同步写过哪些技能」的清单文件名（评审 P2：同步后要能清掉源里已删的技能）。 */
const MANIFEST_FILE = ".pi-staffs-manifest.json";
/** 技能目录名白名单：首字符必须字母数字，杜绝 "./"/"../" 之类路径穿越名。 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 读上次同步写下的技能名清单；文件缺失或损坏都当「一无所知」——宁可不清理，也不误删。 */
const readManifest = (target: string): string[] => {
   try {
      const path = join(target, MANIFEST_FILE);
      if (!existsSync(path)) return [];
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!Array.isArray(raw)) return [];
      return raw.filter(
         (name): name is string =>
            typeof name === "string" && SAFE_NAME.test(name),
      );
   } catch {
      return [];
   }
};

const writeManifest = (target: string, names: string[]): void => {
   writeFileSync(
      join(target, MANIFEST_FILE),
      JSON.stringify(names, null, 2) + "\n",
   );
};

/**
 * 同步到全局技能目录；同名目录直接覆盖（技能是包的一部分）。
 * 同步前先清掉「上次同步写过、这次源清单里已不存在」的技能目录；清单之外的目录
 * （用户自放、旧版本同步留下的）一律不碰——没有可靠归属证明就不删，只清自己写过的。
 */
export const syncStaffsSkills = (
   target: string = join(homedir(), ".pi", "agent", "skills", "pi-staffs"),
): { target: string; copied: string[]; removed: string[] } => {
   const skills = listStaffsSkills();
   const names = skills.map((skill) => skill.name);
   mkdirSync(target, { recursive: true });
   const removed: string[] = [];
   for (const name of readManifest(target)) {
      if (names.includes(name)) continue;
      const dir = join(target, name);
      if (existsSync(dir)) {
         rmSync(dir, { recursive: true, force: true });
         removed.push(name);
      }
   }
   for (const skill of skills)
      cpSync(dirname(skill.path), join(target, skill.name), {
         recursive: true,
      });
   writeManifest(target, names);
   return { target, copied: names, removed };
};
