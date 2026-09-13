/**
 * Pi-Staffs guest 侧派发内核。它被 src/prelude.ts 原样读成字符串、注入到 fabric_exec 代码之前。
 *
 * 为什么逻辑住在 guest：真正派发的是沙箱里的 agents.run()，重试与退避必须发生在调用它的那个
 * 循环里——宿主的 pi.on("tool_call") 只能改写代码，改不了控制流。
 *
 * 注入约束（改这个文件前先读）：
 *  - 不能 import、不能引用模块外的变量（注入后不存在）；
 *  - 只写 JS（用 JSDoc 标类型，tsconfig 开了 checkJs），宿主冒烟测试用 new Function 直接执行它；
 *  - 外部依赖（agents / 时钟 / sleep / 随机）走 __staffsEnv 或参数，测试才能确定性。
 *
 * 失败分类是分水岭：admission 的原文保证「task was not sent」（pi-fabric worker.ts 的错误文本），
 * 说明任务根本没发出去 → 同一个模型重试是安全的；而 other（真任务失败）绝不能重试，
 * 重试只会把同一个错误再犯一遍。
 *
 * D24：不再自动换备用模型——模型由「档位 + 角色」唯一确定（D23），这里只做同模型重试与退避。
 */

/** 宿主用它在 fabric_exec 结果里认出「这是 Pi-Staffs 的派发回执」，据此落盘看板。 */
const __STAFFS_MARKER = "pi-staffs/attempts/v1";

/** @typedef {{ attemptsPerModel?: number; maxRetries?: number; initialRetryDelayMs?: number; retryDelayMs?: number; backoffBaseMs: number; backoffCapMs: number }} StaffsPolicy */
/** @typedef {{ model: string; attempt: number; at: number; ok: boolean; kind: string; reason: string; ms: number }} AttemptRecord */
/** @typedef {{ agents?: any }} StaffsHost */
/** @typedef {{ now?: () => number; sleep?: (ms: number) => Promise<void>; random?: () => number; agents?: any }} StaffsEnv */

/** 测试与宿主可以塞 globalThis.__staffsEnv 覆盖时钟/休眠/随机/宿主 API。
 * @returns {StaffsEnv} */
function __staffsEnv() {
   const env = /** @type {any} */ (globalThis).__staffsEnv;
   return env && typeof env === "object" ? env : {};
}

/** @returns {number} */
function __staffsNow() {
   const env = __staffsEnv();
   return typeof env.now === "function" ? env.now() : Date.now();
}

/** @param {number} ms @returns {Promise<void>} */
function __staffsSleep(ms) {
   const env = __staffsEnv();
   if (typeof env.sleep === "function") return env.sleep(ms);
   return new Promise((resolve) => {
      setTimeout(() => resolve(), Math.max(0, ms));
   });
}

/** @returns {number} */
function __staffsRandom() {
   const env = __staffsEnv();
   return typeof env.random === "function" ? env.random() : Math.random();
}

/** 宿主 API：Fabric 在 guest 顶层声明了 agents，我们只在真正调用时取用（TDZ 也用 try 兜住）。
 * @returns {StaffsHost} */
function __staffsHost() {
   const env = __staffsEnv();
   let realAgents;
   try {
      // @ts-expect-error —— agents 由 Fabric 在 guest 顶层声明，宿主类型系统看不到
      realAgents = agents;
   } catch {
      realAgents = undefined;
   }
   return { agents: env.agents || realAgents };
}

/**
 * 失败文本 → 类别。顺序有意为之：admission 的失败里常带 "timed out"，必须先判它。
 * @param {unknown} text
 * @returns {"admission" | "rateLimit" | "unavailable" | "timeout" | "aborted" | "other"}
 */
function __staffsClassify(text) {
   const value = String(text || "").toLowerCase();
   if (
      /admission (timed out|aborted)|rpc admission|admission completed|depth limit|start limit/.test(
         value,
      )
   ) {
      return "admission";
   }
   if (
      /\b429\b|too many requests|rate.?limit|quota|overload|capacity|resource[_ ]exhausted/.test(
         value,
      )
   ) {
      return "rateLimit";
   }
   if (
      /no credentials|not found|unknown model|unavailable|invalid model|missing api key|unauthorized|\b(401|403|404)\b/.test(
         value,
      )
   ) {
      return "unavailable";
   }
   if (/timed?[_ ]?out|timeout|deadline exceeded|etimedout/.test(value))
      return "timeout";
   if (/abort|cancel/.test(value)) return "aborted";
   return "other";
}

/**
 * 只有「任务没送出去」与「限流/超时」值得重试同一个模型。
 * unavailable（引用/凭据错）与 other（真任务失败）重试没有意义：前者每次都一样，
 * 后者会把同样的错再犯一遍。
 * @param {string} kind @returns {boolean}
 */
function __staffsRetryable(kind) {
   return kind === "admission" || kind === "rateLimit" || kind === "timeout";
}

/**
 * 退避下限：子 pi 冷启动实测约 34s（Windows + 完整扩展套件），准入窗口才 90s，
 * 比 15s 更早重试几乎必然再撞一次准入超时。
 * @param {string} kind @returns {number}
 */
function __staffsFloorMs(kind) {
   return kind === "admission" ? 15000 : 0;
}

/**
 * 解析错误文本里的 Retry-After（秒数或 HTTP 日期），上限 120s。解析不到返回 0。
 * @param {unknown} text @param {number} now @returns {number}
 */
function __staffsRetryAfterMs(text, now) {
   const value = String(text || "");
   const seconds = value.match(/retry[-\s]?after\D{0,10}(\d+(?:\.\d+)?)/i);
   if (seconds)
      return Math.min(
         120000,
         Math.max(0, Math.round(Number(seconds[1]) * 1000)),
      );
   const date = value.match(
      /retry[-\s]?after\D{0,10}([A-Z][a-z]{2},[^;,\n]+GMT)/i,
   );
   if (date) {
      const at = Date.parse(date[1]);
      if (!Number.isNaN(at)) return Math.min(120000, Math.max(0, at - now));
   }
   return 0;
}

/**
 * 指数退避 + 抖动。attempt 从 1 开始；抖动取 [0.5, 1.5) 倍，避免整队同时重试造成二次拥塞。
 * @param {number} attempt @param {number} baseMs @param {number} capMs @param {number} random @returns {number}
 */
function __staffsBackoffMs(attempt, baseMs, capMs, random) {
   const base = Math.max(1, baseMs) * 2 ** Math.max(0, attempt - 1);
   const jittered = base * (0.5 + random);
   return Math.max(0, Math.min(Math.max(1, capMs), Math.round(jittered)));
}

/**
 * 把角色提示与任务拼成一次派发的 task（语义照抄 role-router 的 combineRoleInstructions）。
 * @param {unknown} instructions @param {string} task @returns {string}
 */
function __staffsCombine(instructions, task) {
   const roleText = typeof instructions === "string" ? instructions.trim() : "";
   const taskText = String(task || "").trim();
   if (!roleText) return taskText;
   if (!taskText) return roleText;
   return roleText + "\n\nTask:\n" + taskText;
}

/**
 * 单模型派发循环：同模型最多 attemptsPerModel 次，可重试的类别之间退避。
 * @param {{
 *   host: StaffsHost;
 *   model: string;
 *   task: string;
 *   request: Record<string, unknown>;
 *   policy?: Partial<StaffsPolicy>;
 *   spawn?: boolean;
 * }} deps
 * @returns {Promise<{ ok: boolean; model: string; attempts: AttemptRecord[]; result?: any; handle?: any; error?: string; kind?: string; marker?: string }>}
 */
async function __staffsRun(deps) {
   const host = deps.host || {};
   const agents = host.agents;
   if (!agents || typeof agents.run !== "function") {
      throw new Error(
         "Pi-Staffs 需要 Fabric 的 agents API：请在 fabric_exec 里派发",
      );
   }
   const model = typeof deps.model === "string" ? deps.model.trim() : "";
   if (!model) {
      throw new Error(
         "Pi-Staffs 该角色没有可解析的模型：检查角色的 model、当前档位的覆盖、以及 fabric.json 别名",
      );
   }
   const policy = deps.policy || {};
   // D26：maxRetries 是「同一模型允许的连续可重试失败上限」，总尝试次数 = 1 + maxRetries；
   // 没配 maxRetries 时退回旧字段 attemptsPerModel（含首次），保证老配置与冒烟测试语义不变。
   const maxRetries = Number(policy.maxRetries);
   const maxAttempts = Number.isFinite(maxRetries)
      ? Math.max(1, Math.floor(maxRetries) + 1)
      : Math.max(1, Math.floor(Number(policy.attemptsPerModel) || 2));
   // D26：这两个是**下限**等待，真正的等待仍取「退避 / 类别地板 / Retry-After / 它」的最大值。
   const initialRetryDelayMs = Math.max(
      0,
      Number(policy.initialRetryDelayMs) || 0,
   );
   const retryDelayMs = Math.max(0, Number(policy.retryDelayMs) || 0);
   const backoffBaseMs = Math.max(1, Number(policy.backoffBaseMs) || 1500);
   const backoffCapMs = Math.max(
      backoffBaseMs,
      Number(policy.backoffCapMs) || 30000,
   );
   /** @type {AttemptRecord[]} */
   const attempts = [];
   let lastError = "";
   let lastKind = "other";

   for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = __staffsNow();
      let ok = false;
      let text = "";
      let result;
      try {
         const request = { ...deps.request, task: deps.task, model };
         result =
            deps.spawn === true
               ? await agents.spawn(request)
               : await agents.run(request);
         ok = !(
            result &&
            typeof result.error === "string" &&
            result.error.trim()
         );
         if (!ok) text = String(result && result.error);
      } catch (error) {
         text = error instanceof Error ? error.message : String(error);
      }
      const kind = ok ? "ok" : __staffsClassify(text);
      attempts.push({
         model,
         attempt,
         at: startedAt,
         ok,
         kind,
         reason: ok ? "成功" : text.slice(0, 300),
         ms: __staffsNow() - startedAt,
      });
      if (ok) {
         return deps.spawn === true
            ? {
                 ok: true,
                 model,
                 attempts,
                 handle: result,
                 marker: __STAFFS_MARKER,
              }
            : { ok: true, model, attempts, result, marker: __STAFFS_MARKER };
      }
      lastError = text;
      lastKind = kind;
      if (!__staffsRetryable(kind) || attempt >= maxAttempts) break;
      const retryAfterMs = __staffsRetryAfterMs(text, __staffsNow());
      const delay = Math.max(
         __staffsFloorMs(kind),
         retryAfterMs,
         attempt === 1 ? initialRetryDelayMs : retryDelayMs,
         __staffsBackoffMs(
            attempt,
            backoffBaseMs,
            backoffCapMs,
            __staffsRandom(),
         ),
      );
      attempts.push({
         model,
         attempt,
         at: __staffsNow(),
         ok: false,
         kind: "backoff",
         reason:
            `退避 ${delay}ms` + (retryAfterMs > 0 ? "（Retry-After）" : ""),
         ms: 0,
      });
      await __staffsSleep(delay);
   }
   return {
      ok: false,
      model,
      attempts,
      error: lastError || "Pi-Staffs 派发失败",
      kind: lastKind,
      marker: __STAFFS_MARKER,
   };
}

/** 从 Fabric 的任意返回形状里抠出正文文本（不同 runner 给 result / text / output）。
 * @param {any} result @returns {string} */
function __staffsText(result) {
   if (typeof result === "string") return result;
   if (!result || typeof result !== "object") return "";
   for (const key of ["result", "text", "output", "content", "message"]) {
      const value = result[key];
      if (typeof value === "string" && value.trim()) return value;
      if (Array.isArray(value)) {
         const joined = value
            .map((part) =>
               typeof part === "string"
                  ? part
                  : String((part && part.text) || ""),
            )
            .join("");
         if (joined.trim()) return joined;
      }
   }
   return "";
}

/** 抠出 token 用量（有就记账，没有就 0——不猜）。
 * @param {any} result @returns {{ in: number; out: number; total: number }} */
function __staffsUsage(result) {
   const usage =
      result && typeof result === "object"
         ? result.usage || result.tokens
         : undefined;
   /** @param {unknown} value @returns {number} */
   const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
   if (!usage || typeof usage !== "object") return { in: 0, out: 0, total: 0 };
   const input = num(
      usage.input ?? usage.prompt ?? usage.inputTokens ?? usage.promptTokens,
   );
   const output = num(
      usage.output ??
         usage.completion ??
         usage.outputTokens ??
         usage.completionTokens,
   );
   return {
      in: input,
      out: output,
      total: num(usage.total ?? usage.totalTokens) || input + output,
   };
}

/**
 * 合议（票 07）：同一问题并行跑多个模型，汇总后由 synth 模型合成单一答案。
 * 为什么放在 guest：agents.run 只在 guest 侧可达（票 02 逐行读出的结论）。
 * 设计约束：任何一路失败都不拖垮整体；只有判断、没有写操作（D5 单写者）。
 * @returns {Promise<{ ok: boolean; members: any[]; synthesis?: any; usage: any; budgetExceeded?: boolean; error?: string }>}
 * @param {any} deps
 */
async function __staffsCouncil(deps) {
   const host = (deps && deps.host) || {};
   const agents = host.agents;
   if (!agents || typeof agents.run !== "function")
      throw new Error(
         "Pi-Staffs 合议需要 Fabric 的 agents API：请在 fabric_exec 里运行",
      );
   const members = Array.isArray(deps.models)
      ? deps.models.filter(
           (/** @type {unknown} */ model) =>
              typeof model === "string" && model.trim(),
        )
      : [];
   if (members.length < 2)
      throw new Error(
         "Pi-Staffs 合议至少需要 2 个模型：请在 ~/.pi/agent/pi-staffs.json 里配 council.models",
      );
   const policy = deps.policy || {};
   const settled = await Promise.all(
      members.map(async (/** @type {string} */ model) => {
         const receipt = await __staffsRun({
            host,
            model,
            task: deps.task,
            request: deps.request || {},
            policy,
            spawn: false,
         });
         return {
            model,
            ok: receipt.ok === true,
            answer: __staffsText(receipt.result),
            error: receipt.error || "",
            attempts: receipt.attempts,
            usage: __staffsUsage(receipt.result),
         };
      }),
   );
   const totals = settled.reduce(
      (acc, member) => ({
         in: acc.in + member.usage.in,
         out: acc.out + member.usage.out,
         total: acc.total + member.usage.total,
      }),
      { in: 0, out: 0, total: 0 },
   );
   const budget = Number(deps.budgetTokens);
   const overBudget =
      Number.isFinite(budget) && budget > 0 && totals.total >= budget;
   const usable = settled.filter((member) => member.ok && member.answer);
   if (!usable.length)
      return {
         ok: false,
         members: settled,
         usage: totals,
         error: "所有合议模型都失败了",
      };
   if (!deps.synthModel || overBudget)
      return {
         ok: true,
         members: settled,
         usage: totals,
         budgetExceeded: overBudget,
      };
   const digest = usable
      .map((member) => "## " + member.model + "\n" + member.answer)
      .join("\n\n");
   const synth = await __staffsRun({
      host,
      model: deps.synthModel,
      task: String(deps.synthInstructions || "") + "\n\n" + digest,
      request: {},
      policy,
      spawn: false,
   });
   return {
      ok: synth.ok === true,
      members: settled,
      synthesis: {
         model: deps.synthModel,
         ok: synth.ok === true,
         answer: __staffsText(synth.result),
         error: synth.error || "",
         usage: __staffsUsage(synth.result),
      },
      usage: totals,
   };
}

/**
 * 任务句柄族（票 16）：Fabric 的 agent 生命周期在 guest 侧（agents.*），宿主工具够不着，
 * 所以 status/list/stop/steer/resume/wait 做成 guest 函数——不是偷懒，是唯一可达通道。
 * 方法名逐一对齐 fabric 的 agents API，缺哪个就报哪个，不静默降级。
 */
const __staffsTaskOps = [
   "status",
   "list",
   "stop",
   "steer",
   "resume",
   "wait",
   "compact",
];

/** @param {StaffsHost} host @param {unknown} op @param {unknown[]} args @returns {Promise<any>} */
async function __staffsTaskCall(host, op, args) {
   const agents = host && host.agents;
   const name = String(op || "");
   if (!__staffsTaskOps.includes(name))
      throw new Error(
         "Unknown Pi-Staffs task op: " +
            name +
            "（可用：" +
            __staffsTaskOps.join(", ") +
            "）",
      );
   if (!agents || typeof agents[name] !== "function")
      throw new Error(
         "当前 Fabric 的 agents API 没有 " + name + "()，该操作不可用",
      );
   return agents[name].apply(agents, Array.isArray(args) ? args : []);
}

/**
 * reviver（票 16）：句柄死了不重开整个流程，而是按原任务重新拉一个同角色 agent。
 * 只在状态明确属于「失败/取不到」时才复活，活着的一律不打扰（避免重复劳动）。
 * dispatch 由 prelude 注入（内核里够不到 prelude 的派发封装）。
 * @param {StaffsHost} host @param {any} request @param {(request: any, spawn: boolean) => Promise<any>} dispatch
 */
async function __staffsRevive(host, request, dispatch) {
   const agents = host && host.agents;
   const input = request && typeof request === "object" ? request : {};
   const id = typeof input.id === "string" ? input.id.trim() : "";
   if (!id) throw new Error("Pi-Staffs revive 需要 id（要复活的 agent 句柄）");
   let status;
   if (agents && typeof agents.status === "function") {
      try {
         status = await agents.status(id);
      } catch (error) {
         status = {
            error: error instanceof Error ? error.message : String(error),
         };
      }
   }
   const state = String((status && (status.state || status.status)) || "");
   const dead =
      state === "failed" ||
      state === "error" ||
      state === "cancelled" ||
      !!status?.error;
   if (!dead) return { revived: false, state: state || "unknown", status };
   const task =
      typeof input.task === "string" && input.task.trim()
         ? input.task
         : String((status && status.task) || "");
   if (!task.trim())
      throw new Error(
         "Pi-Staffs revive 缺少任务文本：句柄状态里没有 task，请显式传 task",
      );
   const fresh = await dispatch({ role: input.role, task }, true);
   return {
      revived: true,
      previous: id,
      state: state || "unknown",
      handle: fresh.handle,
      attempts: fresh.attempts,
   };
}

/**
 * 预检（票 14 的快速失败）：用 agents.models() 判断引用是否存在，缺失时列出该 provider 的候选模型。
 * @param {StaffsHost} host @param {Record<string, string>} models @param {string[]=} roles
 * @returns {Promise<{ ok: boolean; models: Array<{ model: string; available: boolean; candidates: string[] }>; missing: string[] }>}
 */
async function __staffsPreflight(host, models, roles) {
   const agents = host && host.agents;
   if (!agents || typeof agents.models !== "function") {
      throw new Error("当前 Fabric 不支持 agents.models()，无法预检模型可用性");
   }
   const available = await agents.models({ refresh: false });
   const known = new Set();
   /** @type {Map<string, string[]>} */
   const byProvider = new Map();
   for (const info of Array.isArray(available) ? available : []) {
      const provider = String((info && info.provider) || "");
      const id = String((info && (info.id || info.resolvedModel)) || "");
      if (!provider || !id) continue;
      known.add(provider + "/" + id);
      if (info.key) known.add(String(info.key));
      const list = byProvider.get(provider) || [];
      list.push(id);
      byProvider.set(provider, list);
   }
   const targets = [];
   for (const name of Object.keys(models)) {
      if (Array.isArray(roles) && roles.length > 0 && !roles.includes(name))
         continue;
      targets.push(models[name]);
   }
   const unique = Array.from(new Set(targets));
   const entries = unique.map((model) => {
      const slash = model.indexOf("/");
      const provider = slash > 0 ? model.slice(0, slash) : model;
      return {
         model,
         available: known.has(model),
         candidates: (byProvider.get(provider) || []).slice(0, 8),
      };
   });
   const missing = entries
      .filter((entry) => !entry.available)
      .map((entry) => entry.model);
   return { ok: missing.length === 0, models: entries, missing };
}
