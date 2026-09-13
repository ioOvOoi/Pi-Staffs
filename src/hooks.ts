/**
 * omo-slim 钩子的移植与改造（票 09）。
 *
 * 取舍原则：**只移植在 Pi 侧有真实落点的钩子**；凡是要「拦截模型输出」而 Pi 事件不提供的，
 * 一律降级成通知或直接不做——宁可少一个钩子，也不要一段永远不触发的死代码。
 * 这里每个判断都是纯函数（状态进、文本出），所以能在冒烟测试里逐条钉住；registerStaffsHooks 只做接线。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
   DEFAULT_STALL_MS,
   formatBoard,
   markStalled,
   readState,
   writeState,
   type Attempt,
   type StaffsState,
} from "./state.ts";

/** 看门狗周期：60s 够快也够省（默认 stall 阈值 120s）。 */
export const WATCHDOG_INTERVAL_MS = 60_000;

/** 会话目标与验收标准（task-session-manager 的移植）：没有它，长任务压缩后会失去判据。 */
export type TaskSession = {
   goal?: string;
   criteria?: string[];
   updatedAt?: number;
};

export const readTaskSession = (state: StaffsState): TaskSession => {
   const raw = state.taskSession;
   return raw && typeof raw === "object" ? (raw as TaskSession) : {};
};

export const writeTaskSession = (
   state: StaffsState,
   patch: TaskSession,
   now: number = Date.now(),
): TaskSession => {
   const next: TaskSession = { ...readTaskSession(state), ...patch, updatedAt: now };
   state.taskSession = next;
   state.updatedAt = now;
   return next;
};

/** 只读判断（不改状态）：提醒与看门狗共用，避免「提醒一下顺手改了状态」这种隐式写。 */
export const stalledCandidates = (
   state: StaffsState,
   now: number,
   stallMs: number = DEFAULT_STALL_MS,
): Attempt[] =>
   state.attempts.filter(
      (attempt) =>
         (attempt.phase === "running" || attempt.phase === "awaiting") &&
         now - attempt.heartbeatAt >= stallMs,
   );

/**
 * phase-reminder 的等价物：只在「明显缺件」时出话，其余时候返回空串。
 * 空串是刻意的——往上下文里塞恒定文本会打掉 prompt cache（票 20）。
 */
export const phaseReminder = (state: StaffsState, now: number = Date.now()): string => {
   const session = readTaskSession(state);
   const running = state.attempts.filter((attempt) => attempt.phase !== "settled");
   const open = state.tasks.filter(
      (task) => task.status !== "done" && task.status !== "canceled",
   );
   const lines: string[] = [];
   if (running.length && !session.criteria?.length)
      lines.push("派发已开始但没有验收标准：用 staffs_task 记下这次要满足的可测条件。");
   if (open.length && !running.length)
      lines.push(
         "有 " + open.length + " 个未完成任务却没人领：先看 staffs_board，再决定领取还是改派。",
      );
   const stalled = stalledCandidates(state, now);
   if (stalled.length)
      lines.push(
         "疑似卡住：" +
            stalled.map((attempt) => attempt.id + "(" + attempt.role + ")").join(", ") +
            "——心跳静默超阈值；用 staffs.task('status'|" + "'stop'|" + "'revive') 处理。",
      );
   return lines.join("\n");
};

/** 每轮注入 = 看板 + 提醒；两者都为空时不注入任何东西（前缀稳定 = cache 命中）。 */
export const buildTurnInjection = (
   state: StaffsState,
   now: number = Date.now(),
): string =>
   [formatBoard(state, { now }), phaseReminder(state, now)]
      .filter((part) => part && part.trim())
      .join("\n\n");

/** 工具调用的稳定指纹：键排序，避免同一输入因为键序不同被判成不同调用。 */
export const stableKey = (input: unknown): string => {
   if (input === undefined || input === null) return "";
   if (typeof input !== "object") return String(input).slice(0, 200);
   const source = input as Record<string, unknown>;
   const ordered: Record<string, unknown> = {};
   for (const key of Object.keys(source).sort()) ordered[key] = source[key];
   try {
      return JSON.stringify(ordered).slice(0, 200);
   } catch {
      return "[unserializable]";
   }
};

/** tool-loop-guard：连续 N 次完全相同的调用，通常是模型在打转（omo-slim 的同名钩子）。 */
export const toolLoopGuard = (
   recent: Array<{ name: string; key: string }>,
   repeatLimit = 4,
): string | undefined => {
   if (recent.length < repeatLimit) return undefined;
   const tail = recent.slice(-repeatLimit);
   const first = tail[0];
   if (!first) return undefined;
   if (tail.every((entry) => entry.name === first.name && entry.key === first.key))
      return (
         "同一条 " +
         first.name +
         " 调用已连续出现 " +
         repeatLimit +
         " 次：换策略，别重试同一个输入（" +
         first.key.slice(0, 80) +
         "）。"
      );
   return undefined;
};

/** search-path-guard：Pi 生态里 ffgrep/fffind 更快也更省 token，命中就提示一句。 */
export const searchPathGuard = (
   toolName: string,
   input: unknown,
): string | undefined => {
   if (toolName !== "bash" || !input || typeof input !== "object") return undefined;
   const command = (input as Record<string, unknown>).command;
   if (typeof command !== "string" || !command) return undefined;
   const noisy = /(^|[;&|]\s*)(rg|grep|find|fd)\s/.test(command);
   const recursive = /grep\s+-[a-zA-Z]*r|rg\s|find\s+\./.test(command);
   if (!noisy || !recursive) return undefined;
   return "路径/内容搜索优先用 fffind / ffgrep（pi-fff），比 bash 里的 rg/find 更省 token。";
};

/** post-file-tool-nudge：改完文件马上提示验证，抑制「改完就说完成」。 */
export const postFileToolNudge = (toolName: string, path?: string): string | undefined => {
   if (toolName !== "edit" && toolName !== "write") return undefined;
   return "已修改" + (path ? " " + path : "") + "：跑最小验证（类型/单测/直接探针），别只读代码下结论。";
};

/** 从工具入参里取一个可读目标（edit/write 用 path，bash 用命令首段）。 */
export const describeTarget = (input: unknown): string | undefined => {
   if (!input || typeof input !== "object") return undefined;
   const record = input as Record<string, unknown>;
   if (typeof record.path === "string") return record.path;
   if (typeof record.command === "string") return record.command.slice(0, 60);
   return undefined;
};

/** json-error-recovery：从带噪声的文本里抠出第一个完整 JSON 对象或数组。 */
export const recoverJson = (text: string): unknown | undefined => {
   const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
   const candidates = [fence?.[1], text].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
   );
   for (const candidate of candidates) {
      for (const [open, close] of [
         ["{", "}"],
         ["[", "]"],
      ] as const) {
         const start = candidate.indexOf(open);
         if (start < 0) continue;
         let depth = 0;
         let inString = false;
         let escaped = false;
         for (let index = start; index < candidate.length; index++) {
            const char = candidate[index];
            if (inString) {
               if (escaped) escaped = false;
               else if (char === "\\") escaped = true;
               else if (char === '"') inString = false;
               continue;
            }
            if (char === '"') inString = true;
            else if (char === open) depth++;
            else if (char === close) {
               depth--;
               if (depth === 0) {
                  try {
                     return JSON.parse(candidate.slice(start, index + 1));
                  } catch {
                     break;
                  }
               }
            }
         }
      }
   }
   return undefined;
};

/**
 * cache-monitor（票 20 的轻量版）：注入内容指纹。
 * 同一档位与状态下两次构建必须一致，否则前缀每次都变，prompt cache 全灭。
 */
export const fingerprint = (parts: Array<string | undefined>): string => {
   const text = parts.filter((part): part is string => !!part).join("\u0000");
   let hash = 5381;
   for (let index = 0; index < text.length; index++)
      hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
   return (hash >>> 0).toString(16);
};

export type HookDeps = {
   statePath?: string;
   notify?: (message: string, level?: "info" | "warning" | "error") => void;
};

/**
 * 接线。状态在内存里缓存、每轮结束落盘：tool_call 是热路径，不能每次读盘。
 * 看门狗只标记（markStalled）不杀进程——handle 在 guest 里，宿主只能把事实写下来让编排者处置。
 */
export const registerStaffsHooks = (pi: ExtensionAPI, deps: HookDeps = {}): void => {
   const recent: Array<{ name: string; key: string }> = [];

   /**
    * 看门狗扫一遍：**每次重读磁盘再标记**。
    * 为什么不缓存一份状态：工具（staffs_task / staffs_mail / staffs_record）与 guest 回执都各自
    * 直接读写同一个状态文件，把注册期的旧快照写回去会抹掉别人刚写的任务与 attempt——
    * 那是最难查的一类「数据自己消失」。重读的文件只有几 KB。
    */
   const sweep = (): Attempt[] => {
      const state = readState(deps.statePath);
      const stalled = markStalled(state, DEFAULT_STALL_MS);
      if (stalled.length) writeState(state, deps.statePath);
      return stalled;
   };

   pi.on("tool_call", (event, ctx) => {
      const entry = { name: event.toolName, key: stableKey(event.input) };
      const guard = toolLoopGuard([...recent, entry]);
      recent.push(entry);
      if (recent.length > 20) recent.shift();
      if (guard) return { block: true, reason: guard };
      const hint = searchPathGuard(event.toolName, event.input);
      if (hint && ctx.hasUI) ctx.ui.notify(hint, "info");
      return;
   });

   pi.on("tool_result", (event, ctx) => {
      const notice = postFileToolNudge(event.toolName, describeTarget(event.input));
      if (notice && ctx.hasUI) ctx.ui.notify(notice, "info");
      return;
   });

   pi.on("turn_end", () => {
      sweep();
   });

   pi.on("session_shutdown", () => {
      sweep();
   });

   const timer = setInterval(() => {
      const stalled = sweep();
      if (!stalled.length) return;
      deps.notify?.(
         "Pi-Staffs 看门狗：" +
            stalled.map((attempt) => attempt.id + "(" + attempt.role + ")").join(", ") +
            " 心跳靜止，已标记 stalled",
         "warning",
      );
   }, WATCHDOG_INTERVAL_MS);
   timer.unref?.();
};
