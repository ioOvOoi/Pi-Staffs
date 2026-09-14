/**
 * 宿主侧工具（票 09/13/16/17/18 的落点）。
 *
 * 分工原则：**guest 只有 agents API，宿主才有文件/网络/UI**。所以所有需要 fb/进程/git 的能力都
 * 注册在这里；guest 侧只保留派发与合议（那两件只有它做得了）。
 *
 * 状态一律走 state.ts 的路径解析（环境变量优先），所以冒烟测试能把整条链跑在临时目录里。
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractReceipts, recordReceipts } from "./attempts.ts";
import { readTaskSession, recoverJson, writeTaskSession } from "./hooks.ts";
import {
   addTask,
   claimTask,
   finishTask,
   formatBoard,
   readState,
   readyTasks,
   sendMail,
   statePath,
   takeMail,
   writeState,
   type StaffsState,
   type TaskStatus,
} from "./state.ts";
import {
   createTracker,
   importCandidates,
   type TrackerKind,
} from "./tracker.ts";
import {
   buildReviewBrief,
   formatFindingTasks,
   parseFindings,
   planReviewRound,
} from "./review.ts";
import {
   activePresetName,
   fabricConfigPath,
   loadStaffsConfig,
   readAliases,
   resolveCouncilModels,
   resolveModelRef,
   resolveRole,
   type StaffsConfig,
} from "./config.ts";

type ToolReply = {
   content: Array<{ type: "text"; text: string }>;
   details: Record<string, unknown>;
};

const reply = (
   text: string,
   details: Record<string, unknown> = {},
): ToolReply => ({
   content: [{ type: "text", text }],
   details,
});

export type TrackerSpec = {
   kind: TrackerKind;
   repo?: string;
   directory?: string;
};

export type ToolDeps = {
   statePath?: string;
   cwd?: string;
   /** tracker 配置在会话中途会变（用户改 config 后重载），所以允许传取数函数。 */
   tracker?: TrackerSpec | (() => TrackerSpec);
};

/** 读改写一步到位：工具都是「一件事」，没必要各写一遍读盘/落盘。 */
const mutate = <T>(
   path: string | undefined,
   fn: (state: StaffsState, now: number) => T,
): { value: T; state: StaffsState } => {
   const now = Date.now();
   const state = readState(path, now);
   const value = fn(state, now);
   writeState(state, path);
   return { value, state };
};

const WORKTREE_ROOT = ".staffs/worktrees";

/**
 * worktree 名 → 目录与分支（票 18 的安全边界）。
 *
 * 为什么不能只写 resolve(cwd, WORKTREE_ROOT, params.name)：name 来自模型，
 * 而 "../" 会被 resolve 规范化掉——worktree 因此能建到 .staffs/worktrees 之外，
 * 而我们随后还会往那个目录注入 AGENTS.md、跑 npm install。
 * 分支名同样要合法，否则 git 报的错和真实原因会对不上。
 */
export const worktreeTarget = (
   cwd: string,
   raw: string,
): { directory: string; branch: string } => {
   const name = raw.trim().replace(/\\/g, "/");
   if (!name) throw new Error("staffs_worktree 需要 name");
   if (!/^[A-Za-z0-9._/-]+$/.test(name))
      throw new Error(
         "worktree 名只允许字母、数字、点、下划线、斜杠、短横线：" + raw,
      );
   const root = resolve(cwd, WORKTREE_ROOT);
   const directory = resolve(root, name);
   if (directory === root || !directory.startsWith(root + sep))
      throw new Error("worktree 名不得越出 " + WORKTREE_ROOT + "：" + raw);
   return { directory, branch: "staffs/" + name };
};
const AGENTS_BEGIN = "<!-- pi-staffs:begin -->";
const AGENTS_END = "<!-- pi-staffs:end -->";

const git = (cwd: string, args: string[]): string =>
   execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
   }).trim();

/**
 * 给 worktree 注入 AGENTS.md 块（票 18）。
 * 为什么用块标记：同一文件可能已经有人类写的规约，重写整文件会把人家的内容冲掉。
 */
export const injectAgentsBlock = (directory: string, block: string): string => {
   const path = join(directory, "AGENTS.md");
   const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
   const start = existing.indexOf(AGENTS_BEGIN);
   const end = existing.indexOf(AGENTS_END);
   const wrapped = AGENTS_BEGIN + "\n" + block.trim() + "\n" + AGENTS_END;
   const next =
      start >= 0 && end > start
         ? existing.slice(0, start) +
           wrapped +
           existing.slice(end + AGENTS_END.length)
         : (existing.trim() ? existing.trimEnd() + "\n\n" : "") +
           wrapped +
           "\n";
   writeFileSync(path, next);
   return path;
};

/** 依赖克隆/安装（票 18 的 clonedeps）：只在真有 package.json 时动手，失败不致命。 */
export const installDeps = async (directory: string): Promise<string> => {
   if (!existsSync(join(directory, "package.json")))
      return "无 package.json，跳过依赖安装";
   // 必须走异步 runCli：npm install 动辄几分钟，同步会冻住整个扩展宿主（见 runCli 的注释）。
   const result = await runCli("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: directory,
      timeoutMs: 600_000,
   });
   if (result.code === 0) return "依赖已安装（npm install）";
   const detail = (
      (result.stderr || result.stdout).trim().split("\n")[0] ?? ""
   ).slice(0, 200);
   return (
      "依赖安装失败（不阻塞）：" +
      (detail || "npm 退出码 " + String(result.code))
   );
};

/**
 * 读响应正文，但最多只读 maxBytes 字节：超大响应不再整份进内存。
 * 读够就用 cancel 主动断开，别为了一份我们根本用不上的正文把连接挂着。
 */
const readCappedText = async (
   response: Response,
   maxBytes: number,
): Promise<string> => {
   const body = response.body;
   if (!body) return "";
   const reader = body.getReader();
   const chunks: Uint8Array[] = [];
   let total = 0;
   try {
      while (total < maxBytes) {
         const { done, value } = await reader.read();
         if (done) break;
         if (!value || value.byteLength === 0) continue;
         const room = maxBytes - total;
         chunks.push(value.byteLength > room ? value.subarray(0, room) : value);
         total += Math.min(value.byteLength, room);
      }
   } finally {
      await reader.cancel().catch(() => undefined);
   }
   return Buffer.concat(chunks).toString("utf8");
};

/**
 * 外部进程统一入口：带超时、带上限、不继承 stdin（否则外部 CLI 会抢走宿主输入）。
 * 不用 execFileSync：这类命令动辄几分钟，同步会卡住整个扩展宿主。
 */
const runCli = (
   command: string,
   args: string[],
   options: { cwd: string; timeoutMs: number; input?: string },
): Promise<{ code: number; stdout: string; stderr: string }> =>
   new Promise((resolve) => {
      const child = execFile(
         command,
         args,
         {
            cwd: options.cwd,
            timeout: options.timeoutMs,
            maxBuffer: 8 * 1024 * 1024,
            windowsHide: true,
         },
         (error, stdout, stderr) => {
            const code =
               error && typeof (error as { code?: unknown }).code === "number"
                  ? (error as { code: number }).code
                  : error
                    ? 1
                    : 0;
            resolve({
               code,
               stdout: String(stdout ?? ""),
               stderr: String(stderr ?? ""),
            });
         },
      );
      if (options.input !== undefined) child.stdin?.end(options.input);
   });

export type DoctorInput = {
   config: StaffsConfig;
   aliases: Record<string, string>;
   state: StaffsState;
   path?: string;
   issues?: string[];
};

/** 体检报告（票 14/19）：全部是本地判定，不发网络请求——预检模型可用性由 guest 侧 staffs.preflight 负责。 */
export const formatDoctorReport = (input: DoctorInput): string => {
   const { config, aliases, state } = input;
   const lines = [
      `配置：${input.path ?? "（内存）"}`,
      `档位：${activePresetName(config) || "（无，用角色基线模型）"}｜可用：${Object.keys(config.presets ?? {}).join(", ") || "（空）"}`,
   ];
   for (const name of Object.keys(config.roles)) {
      const role = resolveRole(config, name);
      if (!role) {
         lines.push(`✗ ${name}: 解析失败（加载期已跳过）`);
         continue;
      }
      const resolved = resolveModelRef(role.model, aliases);
      const permissions =
         (
            role as {
               permissions?: {
                  allow?: string[];
                  ask?: string[];
                  deny?: string[];
               };
            }
         ).permissions ?? {};
      lines.push(
         `${role.enabled === false ? "⏸" : "✓"} ${name}: ${resolved ? resolved.ref : "别名解析失败 → " + String(role.model)}` +
            ` · thinking ${role.thinking} · ${role.mode} · tools ${(role.tools ?? []).join(",") || "-"}` +
            ` · 权限 allow ${(permissions.allow ?? []).length}/ask ${(permissions.ask ?? []).length}/deny ${(permissions.deny ?? []).length}`,
      );
   }
   lines.push(
      `合议：${resolveCouncilModels(config, aliases).join(", ") || "（空：staffs.council 会直接拒绝，先配 council.members）"}`,
      `外部引擎：${
         Object.entries(config.acp ?? {})
            .map(([name, engine]) => name + "=" + engine.command)
            .join(", ") || "（空）"
      }`,
      `tracker：${config.tracker.kind}${config.tracker.directory ? " → " + config.tracker.directory : ""}${config.tracker.repo ? " → " + config.tracker.repo : ""}`,
      `看板：派发 ${state.attempts.length} 条｜任务 ${state.tasks.length}（就绪 ${readyTasks(state).length}）｜信箱未读 ${state.mailbox.filter((message) => !message.read).length} 条`,
   );
   for (const issue of input.issues ?? []) lines.push("⚠ 配置问题：" + issue);
   return lines.join("\n");
};

export const registerStaffsTools = (
   pi: ExtensionAPI,
   deps: ToolDeps = {},
): void => {
   const path = deps.statePath;
   const cwd = deps.cwd ?? process.cwd();
   const currentStatePath = (): string => path ?? statePath(cwd);

   pi.registerTool({
      name: "staffs_board",
      label: "Staffs Board",
      description:
         "查看 Pi-Staffs 团队状态：运行中的派发、任务 DAG 就绪集、信箱未读。",
      parameters: Type.Object({ maxTasks: Type.Optional(Type.Number()) }),
      async execute(_id, params) {
         const state = readState(currentStatePath());
         const board = formatBoard(state, { maxTasks: params.maxTasks ?? 12 });
         return reply(
            board || "（团队空闲：没有进行中的派发，也没有未完成任务）",
            {
               attempts: state.attempts.length,
               tasks: state.tasks.length,
            },
         );
      },
   });

   pi.registerTool({
      name: "staffs_goal",
      label: "Staffs Goal",
      description: "记录/读取本会话的目标与验收标准（压缩后仍能恢复判据）。",
      parameters: Type.Object({
         goal: Type.Optional(Type.String()),
         criteria: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_id, params) {
         const { value } = mutate(path, (state, now) =>
            writeTaskSession(
               state,
               {
                  goal: params.goal,
                  criteria: params.criteria,
               },
               now,
            ),
         );
         const session = value;
         return reply(
            [
               "目标：" + (session.goal ?? "（未设置）"),
               "验收标准：",
               ...(session.criteria?.length
                  ? session.criteria.map((item) => "- " + item)
                  : ["（未设置）"]),
            ].join("\n"),
            { session },
         );
      },
   });

   pi.registerTool({
      name: "staffs_task",
      label: "Staffs Task",
      description:
         "团队任务 DAG：add / list / ready / claim / finish（依赖未完成前不可领取）。",
      parameters: Type.Object({
         op: Type.Union([
            Type.Literal("add"),
            Type.Literal("list"),
            Type.Literal("ready"),
            Type.Literal("claim"),
            Type.Literal("finish"),
         ]),
         id: Type.Optional(Type.String()),
         title: Type.Optional(Type.String()),
         role: Type.Optional(Type.String()),
         deps: Type.Optional(Type.Array(Type.String())),
         status: Type.Optional(Type.String()),
         attemptId: Type.Optional(Type.String()),
      }),
      async execute(_id, params) {
         const { value } = mutate(path, (state, now) => {
            if (params.op === "add") {
               if (!params.title) throw new Error("staffs_task add 需要 title");
               return addTask(
                  state,
                  {
                     id: params.id,
                     title: params.title,
                     role: params.role,
                     deps: params.deps,
                  },
                  now,
               );
            }
            if (params.op === "claim") {
               if (!params.id) throw new Error("staffs_task claim 需要 id");
               return claimTask(
                  state,
                  params.id,
                  params.attemptId ?? "manual",
                  now,
               );
            }
            if (params.op === "finish") {
               if (!params.id) throw new Error("staffs_task finish 需要 id");
               return finishTask(
                  state,
                  params.id,
                  (params.status ?? "done") as TaskStatus,
                  now,
               );
            }
            if (params.op === "ready") return readyTasks(state);
            return state.tasks;
         });
         return reply(JSON.stringify(value, null, 2), {
            count: Array.isArray(value) ? value.length : 1,
         });
      },
   });

   pi.registerTool({
      name: "staffs_mail",
      label: "Staffs Mail",
      description:
         "团队信箱：send 投递、inbox 取未读（成员之间不必经过队长中转）。",
      parameters: Type.Object({
         op: Type.Union([Type.Literal("send"), Type.Literal("inbox")]),
         from: Type.Optional(Type.String()),
         to: Type.Optional(Type.String()),
         text: Type.Optional(Type.String()),
         all: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params) {
         const { value } = mutate(path, (state, now) => {
            if (params.op === "send") {
               if (!params.text) throw new Error("staffs_mail send 需要 text");
               return sendMail(
                  state,
                  {
                     from: params.from ?? "orchestrator",
                     to: params.to ?? "*",
                     text: params.text,
                  },
                  now,
               );
            }
            return takeMail(state, params.to ?? "orchestrator", {
               all: params.all === true,
            });
         });
         const list = Array.isArray(value) ? value : [value];
         return reply(
            list.length
               ? list
                    .map((message) =>
                       typeof message === "string"
                          ? message
                          : "[" +
                            message.from +
                            " → " +
                            message.to +
                            "] " +
                            message.text,
                    )
                    .join("\n")
               : "（无新消息）",
            { count: list.length },
         );
      },
   });

   pi.registerTool({
      name: "staffs_ticket",
      label: "Staffs Ticket",
      description:
         "tracker 适配器：list 就绪候选、import 到团队 DAG、close 回写状态（Symphony §11）。",
      parameters: Type.Object({
         op: Type.Union([
            Type.Literal("list"),
            Type.Literal("import"),
            Type.Literal("close"),
         ]),
         id: Type.Optional(Type.String()),
         status: Type.Optional(Type.String()),
         note: Type.Optional(Type.String()),
      }),
      async execute(_id, params) {
         const spec =
            typeof deps.tracker === "function" ? deps.tracker() : deps.tracker;
         const adapter = createTracker(spec?.kind ?? "local-markdown", {
            repo: spec?.repo,
            directory: spec?.directory,
         });
         const state = readState(currentStatePath());
         if (params.op === "list") {
            const candidates = await adapter.listCandidates();
            return reply(
               candidates.length
                  ? candidates
                       .map((item) => item.id + " — " + item.title)
                       .join("\n")
                  : "（没有就绪候选）",
               { count: candidates.length },
            );
         }
         if (params.op === "import") {
            const added = await importCandidates(state, adapter);
            writeState(state, currentStatePath());
            return reply(
               added.length
                  ? "已导入：" + added.map((task) => task.id).join(", ")
                  : "（已是最新，无需导入）",
               { added: added.length },
            );
         }
         if (!params.id) throw new Error("staffs_ticket close 需要 id");
         await adapter.writeState(
            params.id,
            (params.status ?? "done") as TaskStatus,
            params.note,
         );
         return reply(
            "已回写 " + params.id + " → " + (params.status ?? "done"),
         );
      },
   });

   pi.registerTool({
      name: "staffs_record",
      label: "Staffs Record",
      description:
         "把派发回执（含 attempts 的 JSON）落进看板；手动回报时用它。",
      parameters: Type.Object({
         payload: Type.String({ description: "含 pi-staffs 回执的 JSON 文本" }),
      }),
      async execute(_id, params) {
         const receipts = extractReceipts(params.payload);
         if (!receipts.length) {
            const parsed = recoverJson(params.payload);
            if (parsed && typeof parsed === "object") {
               const outcome = recordReceipts([parsed as never], {
                  path: currentStatePath(),
               });
               return reply("已记录 " + outcome.recorded + " 次尝试", outcome);
            }
            return reply("没找到 Pi-Staffs 回执：请传 guest 返回的原始 JSON", {
               recorded: 0,
            });
         }
         const outcome = recordReceipts(receipts, { path: currentStatePath() });
         return reply("已记录 " + outcome.recorded + " 次尝试", { ...outcome });
      },
   });

   pi.registerTool({
      name: "staffs_ask",
      label: "Staffs Ask",
      description: "问用户一个问题并等待回答（无 UI 时退化为「请直接回复」）。",
      parameters: Type.Object({
         question: Type.String(),
         options: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
         if (!ctx.hasUI || !ctx.ui)
            return reply(
               "当前没有交互界面，无法弹窗。请把这句直接问用户：\n" +
                  params.question,
            );
         if (params.options?.length) {
            const picked = await ctx.ui.select(params.question, params.options);
            return reply(
               picked ? "用户选择：" + picked : "用户未选择（可能取消了弹窗）",
            );
         }
         const answer = await ctx.ui.input(params.question);
         return reply(
            answer ? "用户回答：" + answer : "用户未回答（可能取消了弹窗）",
         );
      },
   });

   pi.registerTool({
      name: "staffs_webfetch",
      label: "Staffs WebFetch",
      description: "抓取网页并转成纯文本（有长度上限，便于塞进上下文）。",
      parameters: Type.Object({
         url: Type.String(),
         maxChars: Type.Optional(Type.Number()),
      }),
      async execute(_id, params, signal) {
         const limit = Math.min(Math.max(params.maxChars ?? 8000, 500), 40_000);
         let target: URL;
         try {
            target = new URL(params.url);
         } catch {
            // 非法 URL 不该是「未处理的异常」，给模型一句能照着改的错。
            throw new Error("staffs_webfetch 需要合法的绝对 URL：" + params.url.slice(0, 120));
         }
         if (target.protocol !== "http:" && target.protocol !== "https:")
            throw new Error(
               "staffs_webfetch 只支持 http/https：" + target.protocol,
            );
         // 调用方的 signal 只覆盖用户取消；服务端挂着不回时会一直等，所以再叠一个硬超时。
         const deadline = AbortSignal.timeout(30_000);
         const response = await fetch(target, {
            signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
         });
         // 先按字节封顶再解码：超出上限的部分没必要读（旧实现是 response.text() 全读）。
         const raw = await readCappedText(
            response,
            Math.max(limit, 1024) * 4 + 65_536,
         );
         const text = raw
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/\s+/g, " ")
            .trim();
         return reply(
            "HTTP " +
               response.status +
               " — " +
               text.slice(0, limit) +
               (text.length > limit ? " …（已截断）" : ""),
            { status: response.status, length: text.length },
         );
      },
   });

   pi.registerTool({
      name: "staffs_worktree",
      label: "Staffs Worktree",
      description:
         "并行写隔离：git worktree 建/列/删，建时注入 AGENTS.md 规约块并尽量装依赖。",
      parameters: Type.Object({
         op: Type.Union([
            Type.Literal("create"),
            Type.Literal("list"),
            Type.Literal("remove"),
         ]),
         name: Type.Optional(Type.String()),
      }),
      async execute(_id, params) {
         if (params.op === "list") {
            const out = git(cwd, ["worktree", "list", "--porcelain"]);
            return reply(out || "（没有 worktree）");
         }
         if (!params.name) throw new Error("staffs_worktree 需要 name");
         const { directory, branch } = worktreeTarget(cwd, params.name);
         if (params.op === "remove") {
            git(cwd, ["worktree", "remove", directory, "--force"]);
            return reply("已移除 worktree " + directory);
         }
         mkdirSync(dirname(directory), { recursive: true });
         git(cwd, ["worktree", "add", directory, "-b", branch]);
         const injected = injectAgentsBlock(
            directory,
            [
               "# Pi-Staffs 隔离工作区",
               "",
               "- 本目录是一个独立 worktree，分支 `" + branch + "`。",
               "- 只改本目录内的文件；改完回报 diff 摘要与验证命令，不要自行合并。",
               "- 需要跨文件重构或共享状态时，先回话给队长，不要偷偷改主工作区。",
            ].join("\n"),
         );
         const installed = await installDeps(directory);
         return reply(
            [
               "worktree：" + directory,
               "AGENTS.md：" + injected,
               installed,
            ].join("\n"),
            { directory, injected, installed },
         );
      },
   });

   pi.registerTool({
      name: "staffs_interview",
      label: "Staffs Interview",
      description:
         "逐题访谈并产出带 frontmatter 的 markdown 需求稿（有 UI 时用弹窗，否则用传入的 answers）。",
      parameters: Type.Object({
         topic: Type.String(),
         questions: Type.Array(Type.String()),
         answers: Type.Optional(Type.Array(Type.String())),
         output: Type.Optional(Type.String()),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
         const target = resolve(
            cwd,
            params.output ?? join(".staffs", "interview.md"),
         );
         // 续问（票 17 验收）：文件已在就先读回来，已答过的问题不再问一遍——重开会话能接着问。
         const existing = existsSync(target)
            ? parseInterview(readFileSync(target, "utf8"))
            : undefined;
         const answered = new Map(
            (existing?.items ?? []).map((item) => [item.question, item.answer]),
         );
         const collected: string[] = [];
         for (const [index, question] of params.questions.entries()) {
            const provided = params.answers?.[index];
            if (provided !== undefined) {
               collected.push(provided);
               continue;
            }
            const known = answered.get(question);
            if (
               known !== undefined &&
               known.trim() &&
               !known.startsWith("（未回答")
            ) {
               collected.push(known);
               continue;
            }
            if (!ctx.hasUI || !ctx.ui) {
               collected.push("（未回答：当前无交互界面）");
               continue;
            }
            const answer = await ctx.ui.input(question);
            collected.push(answer ?? "（未回答）");
         }
         // 旧稿里没被重问的条目保留在前面：面试稿是历史记录，不是每次覆盖的临时文件。
         const items = [...(existing?.items ?? [])];
         for (const [index, question] of params.questions.entries()) {
            const item = { question, answer: collected[index] ?? "（未回答）" };
            const at = items.findIndex((known) => known.question === question);
            if (at >= 0) items[at] = item;
            else items.push(item);
         }
         const pending = items.some(
            (item) => !item.answer.trim() || item.answer.startsWith("（未回答"),
         );
         const doc: InterviewDoc = {
            topic: params.topic,
            createdAt: existing?.createdAt || new Date().toISOString(),
            status: pending ? "in-progress" : "complete",
            items,
         };
         const markdown = formatInterview(doc);
         mkdirSync(dirname(target), { recursive: true });
         writeFileSync(target, markdown);
         return reply("已写入 " + target + "\n\n" + markdown.slice(0, 2000), {
            path: target,
            status: doc.status,
         });
      },
   });

   pi.registerTool({
      name: "staffs_doctor",
      label: "Staffs Doctor",
      description:
         "体检 Pi-Staffs：配置、档位、角色模型解析、权限表、合议成员、外部引擎、tracker 与看板。",
      parameters: Type.Object({}),
      async execute() {
         const outcome = loadStaffsConfig();
         const report = formatDoctorReport({
            config: outcome.config,
            aliases: readAliases(fabricConfigPath()),
            state: readState(currentStatePath()),
            path: outcome.path,
            issues: outcome.issues,
         });
         return reply(report, { issues: outcome.issues.length });
      },
   });

   pi.registerTool({
      name: "staffs_astgrep",
      label: "Staffs AstGrep",
      description:
         "结构化代码搜索/替换（ast-grep）。未安装时给出安装指引；给 rewrite 才会改盘。",
      parameters: Type.Object({
         pattern: Type.String(),
         lang: Type.Optional(Type.String()),
         path: Type.Optional(Type.String()),
         rewrite: Type.Optional(
            Type.String({
               description: "给了就做替换（--rewrite + --update-all，会改盘）",
            }),
         ),
      }),
      async execute(_id, params) {
         const probe = await runCli("ast-grep", ["--version"], {
            cwd,
            timeoutMs: 15000,
         });
         if (probe.code !== 0)
            return reply(
               "未找到 ast-grep，无法做结构化搜索。安装：npm i -g @ast-grep/cli（或 cargo install ast-grep）。\n" +
                  probe.stderr.slice(0, 500),
               { ok: false },
            );
         const args = astGrepArgs({
            pattern: params.pattern,
            ...(params.lang === undefined ? {} : { lang: params.lang }),
            ...(params.path === undefined ? {} : { path: params.path }),
            ...(params.rewrite === undefined
               ? {}
               : { rewrite: params.rewrite }),
         });
         const result = await runCli("ast-grep", args, {
            cwd,
            timeoutMs: 120000,
         });
         const output = (result.stdout + result.stderr).trim();
         return reply(output ? output.slice(0, 20000) : "（无匹配）", {
            ok: result.code === 0,
            code: result.code,
         });
      },
   });

   pi.registerTool({
      name: "staffs_acp",
      label: "Staffs Acp",
      description:
         "把任务交给外部 CLI 引擎（config.acp 里声明的 codex/gemini/claude 等）。只允许白名单引擎。",
      parameters: Type.Object({
         engine: Type.String(),
         prompt: Type.String(),
         timeoutMs: Type.Optional(Type.Number()),
      }),
      async execute(_id, params) {
         const { config } = loadStaffsConfig();
         const engine = config.acp?.[params.engine];
         if (!engine)
            return reply(
               `未配置外部引擎 ${params.engine}；可选：${Object.keys(config.acp ?? {}).join(", ") || "（空）"}`,
               { ok: false },
            );
         const args = (engine.args ?? []).map((arg) =>
            arg.split("{prompt}").join(params.prompt),
         );
         const usesStdin =
            engine.stdin === true ||
            !(engine.args ?? []).some((arg) => arg.includes("{prompt}"));
         const result = await runCli(engine.command, args, {
            cwd,
            timeoutMs: params.timeoutMs ?? engine.timeoutMs ?? 120000,
            ...(usesStdin ? { input: params.prompt } : {}),
         });
         const text = [result.stdout.trim(), result.stderr.trim()]
            .filter(Boolean)
            .join("\n--- stderr ---\n");
         return reply(
            `[${params.engine}] 退出码 ${result.code}\n${text.slice(0, 20000) || "（无输出）"}`,
            { ok: result.code === 0, code: result.code, engine: params.engine },
         );
      },
   });

   /**
    * 复审桥（票 08）：宿主只负责「取 diff / 组 brief / 解析 findings」，
    * 真正的派发交给 guest 的 staffs.run —— 干净上下文靠派发一个新子 agent 实现，而不是在本会话里自问自答。
    */
   pi.registerTool({
      name: "staffs_review",
      label: "Staffs Review",
      description:
         "两段式复审：给 task（可带 base/diff）返回交给 oracle 的干净上下文 brief；给 findingsText 则解析成待修条目与回合决定。",
      parameters: Type.Object({
         task: Type.String(),
         base: Type.Optional(Type.String()),
         diff: Type.Optional(Type.String()),
         acceptance: Type.Optional(Type.Array(Type.String())),
         focus: Type.Optional(Type.Array(Type.String())),
         findingsText: Type.Optional(Type.String()),
         round: Type.Optional(Type.Number()),
         maxRounds: Type.Optional(Type.Number()),
      }),
      async execute(_id, params) {
         if (params.findingsText !== undefined) {
            const findings = parseFindings(params.findingsText);
            const decision = planReviewRound({
               round: params.round ?? 0,
               findings,
               ...(params.maxRounds === undefined
                  ? {}
                  : { maxRounds: params.maxRounds }),
            });
            return reply(
               [
                  decision.action === "fix" ? "继续修：" : "停下：",
                  decision.reason,
                  "",
                  decision.action === "fix"
                     ? formatFindingTasks(decision.findings)
                     : "",
               ]
                  .join("\n")
                  .trim(),
               { action: decision.action, findings: decision.findings.length },
            );
         }
         let diff = params.diff;
         if (diff === undefined) {
            const base = params.base ?? "HEAD";
            try {
               diff = git(cwd, ["diff", base]);
            } catch (error) {
               diff = `（取 git diff ${base} 失败：${error instanceof Error ? error.message : String(error)}）`;
            }
         }
         const acceptance =
            params.acceptance ??
            readTaskSession(readState(currentStatePath())).criteria ??
            [];
         const brief = buildReviewBrief({
            task: params.task,
            diff: diff ?? "",
            acceptance,
            ...(params.base ? { base: params.base } : {}),
            ...(params.focus ? { focus: params.focus } : {}),
         });
         return reply(
            '下面这段交给干净上下文的 oracle 子 agent（staffs.run({ role: "oracle", task: brief })），把它的回话原样传回本工具：\n\n' +
               brief,
            { chars: brief.length },
         );
      },
   });
};

/**
 * 面试稿（票 17）。为什么要有 frontmatter 与 parser：中断后要能续问，就得把「问过什么、答了什么」
 * 变成可读回的数据，而不是每次覆盖一份人看的 markdown。parser 与 formatter 成对，冒烟测试钉住往返一致。
 */
export type InterviewDoc = {
   topic: string;
   createdAt: string;
   status: "in-progress" | "complete";
   items: Array<{ question: string; answer: string }>;
};

export const formatInterview = (doc: InterviewDoc): string => {
   const lines = [
      "---",
      "topic: " + doc.topic,
      "createdAt: " + doc.createdAt,
      "status: " + doc.status,
      "---",
      "# 访谈：" + doc.topic,
      "",
   ];
   for (const item of doc.items)
      lines.push("## " + item.question, "", item.answer, "");
   return lines.join("\n");
};

/** 读回面试稿；缺 frontmatter 或缺 topic 视为「不是我们的稿子」（返回 undefined，调用方当新稿处理）。 */
export const parseInterview = (markdown: string): InterviewDoc | undefined => {
   const head = /^---\n([\s\S]*?)\n---\n?/.exec(markdown);
   if (!head) return undefined;
   const meta: Record<string, string> = {};
   for (const line of head[1].split("\n")) {
      const at = line.indexOf(":");
      if (at > 0) meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
   }
   const topic = meta.topic;
   if (!topic) return undefined;
   const items: InterviewDoc["items"] = [];
   for (const chunk of markdown.slice(head[0].length).split(/^## /m).slice(1)) {
      const breakAt = chunk.indexOf("\n");
      const question = (breakAt < 0 ? chunk : chunk.slice(0, breakAt)).trim();
      const answer = (breakAt < 0 ? "" : chunk.slice(breakAt + 1)).trim();
      if (question) items.push({ question, answer });
   }
   return {
      topic,
      createdAt: meta.createdAt ?? "",
      status: meta.status === "complete" ? "complete" : "in-progress",
      items,
   };
};

/** ast-grep 参数表（纯函数，便于钉住）：只有给了 rewrite 才带 --update-all（那会改盘）。 */
export const astGrepArgs = (params: {
   pattern: string;
   lang?: string;
   path?: string;
   rewrite?: string;
}): string[] => {
   const args = ["run", "--pattern", params.pattern];
   if (params.lang) args.push("--lang", params.lang);
   if (params.rewrite) args.push("--rewrite", params.rewrite, "--update-all");
   args.push(params.path ?? ".");
   return args;
};
