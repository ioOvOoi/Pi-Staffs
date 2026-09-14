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

/** 行首锚点（P1-6）：marker 必须是所在行第一个 token，如 `"marker": "<值>"` 或裸 `marker: <值>`。 */
const MARKER_LINE_RE = /^[\t ]*["']?marker["']?\s*:\s*["']?$/i;

/** 回执字段白名单（P1-6）：只收已知字段，多余的 key（含伪造注入）一律丢弃。 */
const RECEIPT_FIELDS = [
      "marker",
      "role",
      "ok",
      "model",
      "kind",
      "error",
      "handle",
      "attempts",
] as const;
const ATTEMPT_FIELDS = [
      "id",
      "role",
      "model",
      "attempt",
      "at",
      "ok",
      "kind",
      "reason",
      "ms",
] as const;

const pickFields = (
      raw: Record<string, unknown>,
      fields: readonly string[],
): Record<string, unknown> => {
      const clean: Record<string, unknown> = {};
      for (const field of fields) if (field in raw) clean[field] = raw[field];
      return clean;
};

/**
 * 校验并净化一条解析结果（P1-6）：marker 必须等于仓内常量、attempts 必须是数组，
 * 其余字段按白名单收；不匹配/畸形的输入返回 undefined（丢弃），不污染看板。
 */
const sanitizeReceipt = (parsed: unknown): Receipt | undefined => {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return undefined;
      const raw = parsed as Record<string, unknown>;
      if (raw.marker !== RECEIPT_MARKER) return undefined;
      if (!Array.isArray(raw.attempts)) return undefined;
      const attempts: ReceiptAttempt[] = raw.attempts
            .filter(
                  (entry) =>
                        entry !== null &&
                        typeof entry === "object" &&
                        !Array.isArray(entry),
            )
            .map(
                  (entry) =>
                        pickFields(
                              entry as Record<string, unknown>,
                              ATTEMPT_FIELDS,
                        ) as ReceiptAttempt,
            );
      return { ...pickFields(raw, RECEIPT_FIELDS), attempts } as Receipt;
};

/**
 * 从一个 fabric_exec 结果文本里剥出全部回执（P1-6）。
 * 为什么不用后向括号回溯：marker 与对象起点之间若隔着含 `{` 的字符串（错误/正文），
 * 后向数括号会错认起点，把真回执整条吞掉。
 * 这里向前单遍扫描：跳过字符串与转义，维护「对象起点」栈；只在行首出现 marker 键值时认领，
 * 且认领后解析必须通过 marker/attempts 校验与字段白名单，否则丢弃。
 */
export const extractReceipts = (text: string): Receipt[] => {
      const receipts: Receipt[] = [];
      const stack: number[] = [];
      let inString = false;
      let escaped = false;
      let index = 0;
      while (index < text.length) {
            const char = text[index];
            // marker 探测放最前：回执的 marker 恰在 JSON 字符串的值里，若放在字符串状态机分支之后永远扫不到。
            if (char === "p" && text.startsWith(RECEIPT_MARKER, index)) {
                  const found = index;
                  const lineStart = text.lastIndexOf("\n", found - 1) + 1;
                  const linePrefix = text.slice(lineStart, found);
                  const start = stack.length > 0 ? stack[stack.length - 1] : -1;
                  if (MARKER_LINE_RE.test(linePrefix) && start >= 0) {
                        const slice = sliceObject(text, start);
                        if (slice) {
                              try {
                                    const receipt = sanitizeReceipt(
                                          JSON.parse(slice),
                                    );
                                    if (receipt) {
                                          receipts.push(receipt);
                                          // 认领成功：整片对象连同内部文本一起跳过（嵌套 marker 一并忽略，
                                          // 防伪造回执借真回执的正文重复记账），并复位字符串状态与对象栈
                                          //（切片是配平的 JSON，结尾必在字符串之外，内部对象一并弹出）。
                                          while (
                                                stack.length > 0 &&
                                                stack[stack.length - 1] >= start
                                          )
                                                stack.pop();
                                          inString = false;
                                          escaped = false;
                                          index = start + slice.length;
                                          continue;
                                    }
                              } catch {
                                    // 半截 JSON（输出被截断）不是错误：跳过这一条，别打断主流程。
                              }
                        }
                  }
                  // 未认领（行首不成立/无外层对象/解析被拒）：跳过 marker，避免死循环。
                  index = found + RECEIPT_MARKER.length;
                  continue;
            }
            if (inString) {
                  if (escaped) escaped = false;
                  else if (char === "\\") escaped = true;
                  else if (char === '"') inString = false;
                  index++;
                  continue;
            }
            if (char === '"') {
                  inString = true;
                  index++;
                  continue;
            }
            if (char === "{") {
                  stack.push(index);
                  index++;
                  continue;
            }
            if (char === "}") {
                  // 配平失败（截断/畸形文本）就丢弃对象起点，不阻塞后面继续找。
                  stack.pop();
                  index++;
                  continue;
            }
            index++;
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
                        entry.id ??
                        attemptRole +
                              ":" +
                              model +
                              ":" +
                              (entry.at ?? now) +
                              ":" +
                              (entry.attempt ?? 1);
                  // 记账守卫（P1-8）：已结终态的记录不许被迟到/重放的结果覆盖；
                  // owner 双方都已知且不同（转派后）时也不许覆盖，防旧 attempt 的结果污染新 attempt。
                  const existing = state.attempts.find(
                        (attempt) => attempt.id === id,
                  );
                  if (existing?.phase === "settled") continue;
                  if (
                        existing?.owner &&
                        options.owner &&
                        existing.owner !== options.owner
                  )
                        continue;
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
                              notes: entry.reason
                                    ? [String(entry.reason).slice(0, 200)]
                                    : [],
                        },
                        now,
                  );
                  recorded++;
            }
      }
      if (recorded) writeState(state, options.path);
      return { recorded, receipts: receipts.length };
};
