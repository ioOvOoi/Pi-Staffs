/**
 * tracker 适配器（票 12 / D11）：契约四个操作 `list_candidates` / `fetch_issue` /
 * `normalize` / `write_state`，local-markdown 为默认实现，GitHub Issues 为第二个实现
 * （D18：证明契约真能换实现，而不是为单个实现造接口）。
 *
 * 为什么契约里没有「关闭 issue」这类动作：写回只需要一个状态字段——Symphony 的教训是
 * tracker 的写面越窄，越不会在异步对账时把别人的状态改坏。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
   addTask,
   type StaffsState,
   type TaskStatus,
   type TeamTask,
} from "./state.ts";

const run = promisify(execFile);

export type TrackerCandidate = {
   id: string;
   title: string;
   labels?: string[];
   url?: string;
};

export type TrackerIssue = {
   id: string;
   title: string;
   body: string;
   labels: string[];
   deps?: string[];
   url?: string;
};

export type TrackerAdapter = {
   name: string;
   /** 就绪候选（未关闭的条目）；过滤规则由适配器自己解释（Symphony §8.2）。 */
   listCandidates(): Promise<TrackerCandidate[]>;
   fetchIssue(id: string): Promise<TrackerIssue | undefined>;
   /** 归一成团队任务；id 由条目 id 决定，保证重复导入幂等。 */
   normalize(issue: TrackerIssue): {
      id: string;
      title: string;
      deps: string[];
   };
   writeState(id: string, status: TaskStatus, note?: string): Promise<void>;
};

/** 极简 frontmatter 解析：只认 `key: value` 与 `key: [a, b]`，够读我们自己写的票。 */
export const parseFrontmatter = (
   text: string,
): { data: Record<string, string | string[]>; body: string } => {
   const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
   if (!match) return { data: {}, body: text };
   const data: Record<string, string | string[]> = {};
   for (const line of match[1].split(/\r?\n/)) {
      const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
      if (!pair) continue;
      const [, key, rawValue] = pair;
      const value = rawValue.trim();
      data[key] =
         value.startsWith("[") && value.endsWith("]")
            ? value
                 .slice(1, -1)
                 .split(",")
                 .map((item) => item.trim())
                 .filter(Boolean)
            : value.replace(/^["']|["']$/g, "");
   }
   return { data, body: text.slice(match[0].length) };
};

/** 默认 tracker：`.scratch/pi-staffs/issues/*.md`（D8 的 local-markdown）。 */
export const localMarkdownTracker = (
   directory: string = join(process.cwd(), ".scratch", "pi-staffs", "issues"),
): TrackerAdapter => {
   const fileOf = (id: string): string => join(directory, `${id}.md`);
   return {
      name: "local-markdown",
      async listCandidates() {
         if (!existsSync(directory)) return [];
         const out: TrackerCandidate[] = [];
         for (const file of readdirSync(directory)) {
            if (!file.endsWith(".md")) continue;
            const id = file.slice(0, -3);
            const { data } = parseFrontmatter(
               readFileSync(join(directory, file), "utf8"),
            );
            const status = String(data.status ?? "todo");
            if (status === "done" || status === "canceled") continue;
            out.push({
               id,
               title: String(data.title ?? id),
               labels: Array.isArray(data.labels) ? data.labels : [],
            });
         }
         return out;
      },
      async fetchIssue(id) {
         const path = fileOf(id);
         if (!existsSync(path)) return undefined;
         const { data, body } = parseFrontmatter(readFileSync(path, "utf8"));
         return {
            id,
            title: String(data.title ?? id),
            body: body.trim(),
            labels: Array.isArray(data.labels) ? data.labels : [],
            deps: Array.isArray(data.deps) ? data.deps : [],
         };
      },
      normalize(issue) {
         return {
            id: issue.id,
            title: issue.title,
            deps: issue.deps ?? [],
         };
      },
      async writeState(id, status, note) {
         // 只追加不重写：票文件是人的工作区，适配器不该有「重写整个正文」的权力。
         mkdirSync(directory, { recursive: true });
         const { appendFile } = await import("node:fs/promises");
         await appendFile(
            fileOf(id),
            `\n<!-- pi-staffs: ${status}${note ? ` ${note}` : ""} @${new Date().toISOString()} -->\n`,
         );
      },
   };
};

/**
 * GitHub Issues 适配器（D18）：用现成 `gh` CLI 与用户 token，不引入 HTTP 客户端。
 * 每次调用都可能失败（未安装/未登录）——失败就抛出人话错误，让编排者知道降级到 local-markdown。
 */
export const githubTracker = (repo?: string): TrackerAdapter => {
   const args = (rest: string[]): string[] =>
      repo ? ["-R", repo, ...rest] : rest;
   const call = async (rest: string[]): Promise<string> => {
      try {
         const { stdout } = await run("gh", args(rest), { maxBuffer: 8 << 20 });
         return stdout;
      } catch (error) {
         const text = error instanceof Error ? error.message : String(error);
         throw new Error(
            `gh 调用失败（先用 gh auth status 确认登录）：${text.slice(0, 200)}`,
         );
      }
   };
   return {
      name: "github-issues",
      async listCandidates() {
         const raw = await call([
            "issue",
            "list",
            "--state",
            "open",
            "--limit",
            "50",
            "--json",
            "number,title,labels,url",
         ]);
         const parsed = JSON.parse(raw) as Array<{
            number: number;
            title: string;
            labels?: Array<{ name: string }>;
            url?: string;
         }>;
         return parsed.map((issue) => ({
            id: `#${issue.number}`,
            title: issue.title,
            labels: (issue.labels ?? []).map((label) => label.name),
            url: issue.url,
         }));
      },
      async fetchIssue(id) {
         const number = id.replace(/^#/, "");
         const raw = await call([
            "issue",
            "view",
            number,
            "--json",
            "number,title,body,labels,url",
         ]);
         const issue = JSON.parse(raw) as {
            number: number;
            title: string;
            body?: string;
            labels?: Array<{ name: string }>;
            url?: string;
         };
         return {
            id: `#${issue.number}`,
            title: issue.title,
            body: issue.body ?? "",
            labels: (issue.labels ?? []).map((label) => label.name),
            url: issue.url,
         };
      },
      normalize(issue) {
         // GitHub 没有依赖字段：正文里的 `Depends on: #12, #13` 是唯一可读的依赖表达（Symphony §11 同做法）。
         const deps = Array.from(
            issue.body.matchAll(/depends on:\s*([^\n]+)/gi),
         ).flatMap((match) =>
            Array.from(match[1].matchAll(/#\d+/g)).map((hit) => hit[0]),
         );
         return { id: issue.id, title: issue.title, deps };
      },
      async writeState(id, status, note) {
         await call([
            "issue",
            "comment",
            id.replace(/^#/, ""),
            "--body",
            `pi-staffs: ${status}${note ? ` — ${note}` : ""}`,
         ]);
         if (status === "done")
            await call(["issue", "close", id.replace(/^#/, "")]);
      },
   };
};

export type TrackerKind = "local-markdown" | "github-issues";

export const createTracker = (
   kind: TrackerKind = "local-markdown",
   options: { repo?: string; directory?: string } = {},
): TrackerAdapter =>
   kind === "github-issues"
      ? githubTracker(options.repo)
      : localMarkdownTracker(options.directory);

/** 把 tracker 的候选导入团队状态：已存在的任务不重复添加（幂等，Symphony §7.4）。 */
export const importCandidates = async (
   state: StaffsState,
   adapter: TrackerAdapter,
   now: number = Date.now(),
): Promise<TeamTask[]> => {
   const existing = new Set(state.tasks.map((task) => task.id));
   const added: TeamTask[] = [];
   for (const candidate of await adapter.listCandidates()) {
      const issue = await adapter.fetchIssue(candidate.id);
      if (!issue) continue;
      const normalized = adapter.normalize(issue);
      if (existing.has(normalized.id)) continue;
      added.push(
         addTask(
            state,
            {
               id: normalized.id,
               title: normalized.title,
               deps: normalized.deps,
            },
            now,
         ),
      );
      existing.add(normalized.id);
   }
   return added;
};
