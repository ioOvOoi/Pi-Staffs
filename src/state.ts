/**
 * 项目态（票 12/13 的落盘面）：单一状态文件 `<cwd>/.staffs/state.json`（D14：单一状态文件）。
 *
 * 为什么落在磁盘而不是内存：attempt 与任务 DAG 必须在会话崩溃、压缩、切档位之后仍然可读——
 * omo-slim 的 task-session-manager 为此写了 25 个文件，我们用一个 JSON 加一组纯函数做到同一件事。
 *
 * 术语照搬地图：attempt 是「一次有状态的派发」（D10），终态必须区分 succeeded / failed /
 * timed-out / stalled / canceled / rate-limited-exhausted，因为重试与日志策略因终态而异。
 *
 * 写入一律原子（临时文件 + rename）：TUI 面板与工具会并发读，半截 JSON 会直接崩掉渲染。
 */
import {
   closeSync,
   existsSync,
   fsyncSync,
   mkdirSync,
   openSync,
   readFileSync,
   renameSync,
   writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const STATE_VERSION = 1;

/** 派发相位；`awaiting` = 已交出 handle 等结果（spawn 的常态）。 */
export type AttemptPhase = "queued" | "running" | "awaiting" | "settled";

/** 终态集合（D10）。rate-limited-exhausted 是 D26 的产物：限次用尽，但没换模型。 */
export type AttemptTerminal =
   | "succeeded"
   | "failed"
   | "timed-out"
   | "stalled"
   | "canceled"
   | "rate-limited-exhausted";

export type Attempt = {
   id: string;
   role: string;
   model: string;
   phase: AttemptPhase;
   terminal?: AttemptTerminal;
   taskId?: string;
   /** 派发方（父会话）标识，用于「转派后旧 attempt 结果不得覆盖」的比对。 */
   owner?: string;
   startedAt: number;
   /** 最后一次心跳；看门狗（票 14）用它判 stalled。 */
   heartbeatAt: number;
   finishedAt?: number;
   notes: string[];
};

export type TaskStatus =
   | "todo"
   | "ready"
   | "running"
   | "done"
   | "blocked"
   | "canceled";

export type TeamTask = {
   id: string;
   title: string;
   role?: string;
   /** 依赖的任务 id；未全部 done 前不可领取（AgentTeams 语义，D9）。 */
   deps: string[];
   status: TaskStatus;
   attemptId?: string;
   updatedAt: number;
};

export type MailMessage = {
   id: string;
   from: string;
   to: string;
   text: string;
   at: number;
   read: boolean;
};

export type StaffsState = {
   stateVersion: number;
   updatedAt: number;
   attempts: Attempt[];
   tasks: TeamTask[];
   mailbox: MailMessage[];
   [key: string]: unknown;
};

/** 看门狗阈值：omo-slim 用 2 分钟无新事件判「可能卡住」，照抄这个数量级。 */
export const DEFAULT_STALL_MS = 120_000;

/** 状态文件路径：环境变量优先（冒烟测试靠它隔离，绝不碰用户真实项目）。 */
export const statePath = (
   cwd: string = process.cwd(),
   env: NodeJS.ProcessEnv = process.env,
): string =>
   env.PI_STAFFS_STATE?.trim() || join(cwd, ".staffs", "state.json");

export const emptyState = (now: number = Date.now()): StaffsState => ({
   stateVersion: STATE_VERSION,
   updatedAt: now,
   attempts: [],
   tasks: [],
   mailbox: [],
});

/** 读状态：不存在/坏 JSON 都退回空态。为什么不忍错：状态可重建，一个坏文件不该卡住会话。 */
export const readState = (
   path: string = statePath(),
   now: number = Date.now(),
): StaffsState => {
   if (!existsSync(path)) return emptyState(now);
   try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<StaffsState>;
      return {
         ...emptyState(now),
         ...raw,
         stateVersion: STATE_VERSION,
         attempts: Array.isArray(raw.attempts) ? raw.attempts : [],
         tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
         mailbox: Array.isArray(raw.mailbox) ? raw.mailbox : [],
      };
   } catch {
      return emptyState(now);
   }
};

/** 原子写（与 config.ts 同一手法：临时文件 + fsync + rename，权限 0600）。 */
export const writeState = (state: StaffsState, path: string = statePath()): string => {
   mkdirSync(dirname(path), { recursive: true });
   const temporary = `${path}.${process.pid}.tmp`;
   const descriptor = openSync(temporary, "w", 0o600);
   try {
      writeSync(descriptor, `${JSON.stringify(state, null, 2)}\n`);
      fsyncSync(descriptor);
   } finally {
      closeSync(descriptor);
   }
   renameSync(temporary, path);
   return path;
};

/** 递增 id：不用随机数是为了日志可比对、测试可断言。 */
const nextId = (prefix: string, count: number): string =>
   `${prefix}-${String(count + 1).padStart(3, "0")}`;

export const upsertAttempt = (
   state: StaffsState,
   input: Partial<Attempt> & { role: string },
   now: number = Date.now(),
): Attempt => {
   const existing = input.id
      ? state.attempts.find((attempt) => attempt.id === input.id)
      : undefined;
   if (existing) {
      existing.heartbeatAt = now;
      existing.phase = input.phase ?? existing.phase;
      existing.terminal = input.terminal ?? existing.terminal;
      if (input.model) existing.model = input.model;
      if (input.taskId) existing.taskId = input.taskId;
      if (input.notes?.length) existing.notes.push(...input.notes);
      if (existing.phase === "settled") existing.finishedAt ??= now;
      state.updatedAt = now;
      return existing;
   }
   const attempt: Attempt = {
      id: input.id ?? nextId("attempt", state.attempts.length),
      role: input.role,
      model: input.model ?? "",
      phase: input.phase ?? "running",
      terminal: input.terminal,
      taskId: input.taskId,
      owner: input.owner,
      startedAt: input.startedAt ?? now,
      heartbeatAt: now,
      notes: input.notes ?? [],
   };
   state.attempts.push(attempt);
   state.updatedAt = now;
   return attempt;
};

/** 结终态。已 settled 的 attempt 不再改写——迟到的结果不许覆盖新 attempt（AgentTeams 不变量）。 */
export const settleAttempt = (
   state: StaffsState,
   id: string,
   terminal: AttemptTerminal,
   note: string | undefined = undefined,
   now: number = Date.now(),
): Attempt | undefined => {
   const attempt = state.attempts.find((entry) => entry.id === id);
   if (!attempt || attempt.phase === "settled") return undefined;
   attempt.phase = "settled";
   attempt.terminal = terminal;
   attempt.finishedAt = now;
   attempt.heartbeatAt = now;
   if (note) attempt.notes.push(note);
   state.updatedAt = now;
   return attempt;
};

/** 心跳：长时间运行的工具调用每轮刷一次，看门狗才不会误判。 */
export const touchAttempt = (
   state: StaffsState,
   id: string,
   now: number = Date.now(),
): void => {
   const attempt = state.attempts.find((entry) => entry.id === id);
   if (!attempt || attempt.phase === "settled") return;
   attempt.heartbeatAt = now;
   state.updatedAt = now;
};

/**
 * 看门狗（票 14）：running/awaiting 且心跳超时的 attempt 判 stalled。
 * 为什么不直接杀子会话：Fabric 的 handle 在 guest 里，宿主只能标记——标记后由编排者决定重新派发。
 */
export const markStalled = (
   state: StaffsState,
   stallMs: number = DEFAULT_STALL_MS,
   now: number = Date.now(),
): Attempt[] => {
   const stalled: Attempt[] = [];
   for (const attempt of state.attempts) {
      if (attempt.phase !== "running" && attempt.phase !== "awaiting") continue;
      if (now - attempt.heartbeatAt < stallMs) continue;
      attempt.phase = "settled";
      attempt.terminal = "stalled";
      attempt.finishedAt = now;
      attempt.notes.push(`心跳静止 ${Math.round((now - attempt.heartbeatAt) / 1000)}s`);
      stalled.push(attempt);
   }
   if (stalled.length) state.updatedAt = now;
   return stalled;
};

export const addTask = (
   state: StaffsState,
   input: { id?: string; title: string; role?: string; deps?: string[] },
   now: number = Date.now(),
): TeamTask => {
   const task: TeamTask = {
      id: input.id ?? nextId("task", state.tasks.length),
      title: input.title,
      role: input.role,
      deps: input.deps ?? [],
      status: "todo",
      updatedAt: now,
   };
   state.tasks.push(task);
   state.updatedAt = now;
   return task;
};

/** 依赖全部 done 且自身未开工的任务 = 就绪（AgentTeams 的 ready 集合）。 */
export const readyTasks = (state: StaffsState): TeamTask[] => {
   const done = new Set(
      state.tasks.filter((task) => task.status === "done").map((task) => task.id),
   );
   return state.tasks.filter(
      (task) =>
         (task.status === "todo" || task.status === "blocked") &&
         task.deps.every((dep) => done.has(dep)),
   );
};

/** 领取：只有就绪任务能领；被领过的任务不可重复领取（防重复劳动，Anthropic 的典型失败）。 */
export const claimTask = (
   state: StaffsState,
   id: string,
   attemptId: string,
   now: number = Date.now(),
): TeamTask => {
   const task = state.tasks.find((entry) => entry.id === id);
   if (!task) throw new Error(`未知任务：${id}`);
   const ready = readyTasks(state).some((entry) => entry.id === id);
   if (!ready) {
      const blockedBy = task.deps.filter(
         (dep) => state.tasks.find((entry) => entry.id === dep)?.status !== "done",
      );
      throw new Error(
         blockedBy.length
            ? `任务 ${id} 的依赖未完成：${blockedBy.join(", ")}`
            : `任务 ${id} 当前状态 ${task.status} 不可领取`,
      );
   }
   task.status = "running";
   task.attemptId = attemptId;
   task.updatedAt = now;
   state.updatedAt = now;
   return task;
};

export const finishTask = (
   state: StaffsState,
   id: string,
   status: TaskStatus,
   now: number = Date.now(),
): TeamTask => {
   const task = state.tasks.find((entry) => entry.id === id);
   if (!task) throw new Error(`未知任务：${id}`);
   task.status = status;
   task.updatedAt = now;
   state.updatedAt = now;
   return task;
};

export const sendMail = (
   state: StaffsState,
   input: { from: string; to: string; text: string },
   now: number = Date.now(),
): MailMessage => {
   const message: MailMessage = {
      id: nextId("mail", state.mailbox.length),
      from: input.from,
      to: input.to,
      text: input.text,
      at: now,
      read: false,
   };
   state.mailbox.push(message);
   state.updatedAt = now;
   return message;
};

/** 取信：默认只取未读；`all` 给面板用。 */
export const takeMail = (
   state: StaffsState,
   to: string,
   options: { all?: boolean; markRead?: boolean } = {},
): MailMessage[] => {
   const messages = state.mailbox.filter(
      (message) =>
         (message.to === to || message.to === "*") &&
         (options.all === true || !message.read),
   );
   if (options.markRead !== false)
      for (const message of messages) message.read = true;
   return messages;
};

const age = (from: number, now: number): string =>
   `${Math.max(0, Math.round((now - from) / 1000))}s`;

/**
 * 渲染任务板（注入用的 markdown）。空态返回空串：没有团队工作时**不注入任何东西**——
 * 注入空标题也会改前缀、打掉 prompt cache（票 20 的出发点）。
 */
export const formatBoard = (
   state: StaffsState,
   options: { now?: number; stallMs?: number; maxTasks?: number } = {},
): string => {
   const now = options.now ?? Date.now();
   const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
   const running = state.attempts.filter(
      (attempt) => attempt.phase === "running" || attempt.phase === "awaiting",
   );
   const open = state.tasks.filter(
      (task) => task.status !== "done" && task.status !== "canceled",
   );
   if (!running.length && !open.length) return "";
   const lines: string[] = ["### Pi-Staffs 团队状态"];
   if (open.length) {
      lines.push("任务：");
      for (const task of open.slice(0, options.maxTasks ?? 12)) {
         const deps = task.deps.length ? ` ← ${task.deps.join(",")}` : "";
         lines.push(
            `- ${task.id} [${task.status}] ${task.title}${deps}${task.role ? ` (${task.role})` : ""}`,
         );
      }
      const ready = readyTasks(state);
      if (ready.length)
         lines.push(`就绪可领：${ready.map((task) => task.id).join(", ")}`);
   }
   if (running.length) {
      lines.push("运行中：");
      for (const attempt of running) {
         const silent = now - attempt.heartbeatAt;
         const stalled = silent >= stallMs ? " **疑似卡住**" : "";
         // 相位（running / awaiting）必须显示：awaiting = 已交句柄在等结果，与 running 的处置不同。
         lines.push(
            `- ${attempt.id} ${attempt.role} [${attempt.phase}] (${attempt.model}) 心跳 ${age(attempt.heartbeatAt, now)} 前${stalled}`,
         );
      }
   }
   // 未读一律计数：只数广播会让「直接寄给某角色」的信在看板上永远不出现，人也就永远不知道它被读没读。
   const unread = state.mailbox.filter((message) => !message.read).length;
   if (unread) lines.push(`团队信箱未读：${unread}`);
   return lines.join("\n");
};

/**
 * widget 面板（票 15）：把看板摊成行数组交给 `ctx.ui.setWidget`。
 * 与 footer 的分工：footer 只放「需要人管」的数字，面板给完整视图；两者同源（formatBoard），
 * 所以不会出现「面板说 3 个、footer 说 2 个」这种第二真相源问题。
 * 空态返回空数组——空面板不占屏幕，也不需要在事件里判空。
 */
export const formatPanel = (
   state: StaffsState,
   options: { now?: number; stallMs?: number; maxTasks?: number } = {},
): string[] => {
   const board = formatBoard(state, options);
   return board ? board.split("\n").filter((line) => line.trim()) : [];
};

/**
 * footer 一行摘要（票 15）。为什么单独抽成纯函数：相位判定曾经被写成 `attempt.status`（Attempt 没有
 * 这个字段），于是 footer 永远显示不出东西——抽出来冒烟测试才钉得住。
 * 返回 undefined 表示没有需要人管的东西，调用方据此清掉状态行。
 */
export const footerSummary = (state: StaffsState): string | undefined => {
   const open = state.attempts.filter((attempt) => attempt.phase !== "settled");
   const stalled = state.attempts.filter((attempt) => attempt.terminal === "stalled");
   const ready = readyTasks(state).length;
   const unread = state.mailbox.filter((message) => !message.read).length;
   const parts = [
      open.length ? `跑 ${open.length}` : "",
      stalled.length ? `停 ${stalled.length}` : "",
      ready ? `就绪 ${ready}` : "",
      unread ? `信 ${unread}` : "",
   ].filter(Boolean);
   return parts.length ? "staffs · " + parts.join(" · ") : undefined;
};
