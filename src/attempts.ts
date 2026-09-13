/**
 * 派发回执（receipt）的采集与落盘。
 *
 * 为什么需要这一层：Fabric 的 agent handle 生在 guest（fabric_exec 的代码作用域）里，宿主侧工具
 * 够不着它；唯一可达的通道是 guest 的返回值。所以 guest 内核在结果上打 marker，宿主在 tool_result
 * 事件里认领它。认不出、解析失败都不抛错——看板是助力，不该成为派发的前置条件。
 */
import {
   readState,
   upsertAttempt,
   writeState,
   type AttemptTerminal,
   type StaffsState,
} from "./state.ts";

/** 与 src/guest/kernel.js 里的 __STAFFS_MARKER 必须一致（冒烟测试会钉住这一点）。 */
export const RECEIPT_MARKER = "pi-staffs/attempts/v1";

export type ReceiptAttempt = {
   id?: string;
   role?: string;
   model?: string;
   attempt?: number;
   at?: number;
   ok?: boolean;
   kind?: string;
   reason?: string;
   ms?: number;
};

export type Receipt = {
   marker?: string;
   role?: string;
   ok?: boolean;
   model?: string;
   kind?: string;
   error?: string;
   handle?: unknown;
   attempts?: ReceiptAttempt[];
};

/**
 * 从 start 处的 `{` 找配对 `}`：跳过字符串与转义，避免把字符串里的括号算进去。
 * 返回切片文本；配对不上返回 undefined。
 */
const sliceObject = (text: string, start: number): string | undefined => {
   let depth = 0;
   let inString = false;
   let escaped = false;
   for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (inString) {
         if (escaped) escaped = false;
         else if (char === "\\") escaped = true;
         else if (char === '"') inString = false;
         continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth++;
      else if (char === "}") {
         depth--;
         if (depth === 0) return text.slice(start, index + 1);
      }
   }
   return undefined;
};

/** 从 marker 处往左找它所属对象的 `{`：按括号配平回溯。 */
const enclosingStart = (text: string, markerAt: number): number => {
   let depth = 0;
   for (let index = markerAt; index >= 0; index--) {
      const char = text[index];
      if (char === "}") depth++;
      else if (char === "{") {
         if (depth === 0) return index;
         depth--;
      }
   }
   return -1;
};

/**
 * 从一个 fabric_exec 结果文本里剥出全部回执。
 * 为什么不用「贪婪正则」：回执里嵌着 attempts 数组与 result 正文，正则会在第一个 `}` 就截断。
 */
export const extractReceipts = (text: string): Receipt[] => {
   const receipts: Receipt[] = [];
   let cursor = 0;
   while (cursor < text.length) {
      const found = text.indexOf(RECEIPT_MARKER, cursor);
      if (found < 0) break;
      cursor = found + RECEIPT_MARKER.length;
      const start = enclosingStart(text, found);
      if (start < 0) continue;
      const slice = sliceObject(text, start);
      if (!slice) continue;
      try {
         const parsed = JSON.parse(slice) as Receipt;
         if (parsed && typeof parsed === "object" && Array.isArray(parsed.attempts))
            receipts.push(parsed);
      } catch {
         // 半截 JSON（输出被截断）不是错误：跳过这一条，别打断主流程。
      }
   }
   return receipts;
};

/** 尝试类别 → 终态：限次用尽是独立终态（D26），其余按 ok 分成功/失败。 */
export const terminalOf = (attempt: ReceiptAttempt): AttemptTerminal => {
   const kind = String(attempt.kind ?? "");
   if (attempt.ok === true) return "succeeded";
   if (kind === "rateLimit") return "rate-limited-exhausted";
   if (kind === "timeout") return "timed-out";
   return "failed";
};

export type RecordOutcome = { recorded: number; receipts: number };

/**
 * 把回执写进状态文件。owner 用于「转派后旧结果不得覆盖新 attempt」的比对（AgentTeams 不变量）。
 * 只记真实调用（backoff 是等待记录，不是一次模型调用），否则看板会把重试次数读成两倍。
 */
export const recordReceipts = (
   receipts: Receipt[],
   options: { path?: string; now?: number; owner?: string } = {},
): RecordOutcome => {
   const now = options.now ?? Date.now();
   const state: StaffsState = readState(options.path, now);
   let recorded = 0;
   for (const receipt of receipts) {
      const role = String(receipt.role ?? "");
      for (const entry of receipt.attempts ?? []) {
         if (String(entry.kind ?? "") === "backoff") continue;
         const attemptRole = String(entry.role ?? role ?? "unknown");
         const model = String(entry.model ?? receipt.model ?? "");
         const id =
            entry.id ?? attemptRole + ":" + model + ":" + (entry.at ?? now) + ":" + (entry.attempt ?? 1);
         upsertAttempt(
            state,
            {
               id,
               role: attemptRole,
               model,
               phase: "settled",
               terminal: terminalOf(entry),
               startedAt: entry.at ?? now,
               owner: options.owner,
               notes: entry.reason ? [String(entry.reason).slice(0, 200)] : [],
            },
            now,
         );
         recorded++;
      }
   }
   if (recorded) writeState(state, options.path);
   return { recorded, receipts: receipts.length };
};
