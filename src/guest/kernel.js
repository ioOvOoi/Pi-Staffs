/**
 * Pi-Staffs guest 侧韧性内核。它被 src/prelude.ts 原样读成字符串、注入到 fabric_exec 代码之前。
 *
 * 为什么逻辑住在 guest：真正派发的是沙箱里的 agents.run()，退避与换模型必须发生在调用它的
 * 那个循环里——宿主的 pi.on("tool_call") 只能改写代码，改不了控制流。
 *
 * 注入约束（改这个文件前先读）：
 *  - 不能 import、不能引用模块外的变量（注入后不存在）；
 *  - 只写 JS（用 JSDoc 标类型，tsconfig 开了 checkJs），宿主冒烟测试用 new Function 直接执行它；
 *  - 外部依赖（agents / mesh / 时钟 / sleep / 随机）走 __staffsEnv 或参数，测试才能确定性。
 *
 * 失败分类是分水岭：admission 的原文保证「task was not sent」（pi-fabric worker.ts 的错误文本），
 * 说明任务根本没发出去 → 可以安全重试；而 other（真任务失败）绝不能重试或换模型，
 * 换模型只会把同一个错误再犯一遍，还会烧掉备胎。
 */

/** @typedef {{ failures: number; cooldownUntil: number; lastError?: string; updatedAt: number }} HealthEntry */
/** @typedef {{ attemptsPerModel: number; backoffBaseMs: number; backoffCapMs: number }} StaffsPolicy */
/** @typedef {{ model: string; attempt: number; ok: boolean; kind: string; reason: string; ms: number }} AttemptRecord */
/** @typedef {{ agents?: any; mesh?: any }} StaffsHost */
/** @typedef {{ now?: () => number; sleep?: (ms: number) => Promise<void>; random?: () => number; agents?: any; mesh?: any }} StaffsEnv */

const __STAFFS_HEALTH_PREFIX = "pi-staffs:health:";

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

/** 宿主 API：Fabric 在 guest 顶层声明了 agents/mesh，我们只在真正调用时取用（TDZ 也用 try 兜住）。
 * @returns {StaffsHost} */
function __staffsHost() {
   const env = __staffsEnv();
   let realAgents;
   let realMesh;
   try {
      // @ts-expect-error —— agents/mesh 由 Fabric 在 guest 顶层声明，宿主类型系统看不到
      realAgents = agents;
   } catch {
      realAgents = undefined;
   }
   try {
      // @ts-expect-error —— 同上：guest 全局由 Fabric 注入
      realMesh = mesh;
   } catch {
      realMesh = undefined;
   }
   return { agents: env.agents || realAgents, mesh: env.mesh || realMesh };
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
   if (/\b429\b|too many requests|rate.?limit|quota|overload|capacity|resource[_ ]exhausted/.test(value)) {
      return "rateLimit";
   }
   if (
      /no credentials|not found|unknown model|unavailable|invalid model|missing api key|unauthorized|\b(401|403|404)\b/.test(
         value,
      )
   ) {
      return "unavailable";
   }
   if (/timed?[_ ]?out|timeout|deadline exceeded|etimedout/.test(value)) return "timeout";
   if (/abort|cancel/.test(value)) return "aborted";
   return "other";
}

/**
 * 类别 → 处置。cooldownMs 是「这个模型多久内别再当头号选择」的基准，
 * 连续失败会按 2 的幂放大（见 __staffsNextHealth）。
 * @param {string} kind
 * @returns {{ retrySame: boolean; advance: boolean; cooldownMs: number }}
 */
function __staffsFailurePlan(kind) {
   switch (kind) {
      case "admission":
         return { retrySame: true, advance: true, cooldownMs: 15000 };
      case "rateLimit":
         return { retrySame: true, advance: true, cooldownMs: 120000 };
      case "unavailable":
         return { retrySame: false, advance: true, cooldownMs: 600000 };
      case "timeout":
         return { retrySame: true, advance: true, cooldownMs: 60000 };
      default:
         return { retrySame: false, advance: false, cooldownMs: 0 };
   }
}

/**
 * 解析错误文本里的 Retry-After（秒数或 HTTP 日期），上限 120s。解析不到返回 0。
 * @param {unknown} text @param {number} now @returns {number}
 */
function __staffsRetryAfterMs(text, now) {
   const value = String(text || "");
   const seconds = value.match(/retry[-\s]?after\D{0,10}(\d+(?:\.\d+)?)/i);
   if (seconds) return Math.min(120000, Math.max(0, Math.round(Number(seconds[1]) * 1000)));
   const date = value.match(/retry[-\s]?after\D{0,10}([A-Z][a-z]{2},[^;,\n]+GMT)/i);
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
 * 从链上挑一个不在冷却里的模型；全都冷却时仍返回第一个冷确中的（宁可试，也不要直接失败）。
 * @param {string[]} chain @param {number} startIndex @param {Record<string, HealthEntry>} health @param {number} now
 * @returns {{ index: number; model: string; skipped: string[]; allCooling: boolean } | undefined}
 */
function __staffsSelectModel(chain, startIndex, health, now) {
   const skipped = [];
   let firstCooling = -1;
   for (let index = Math.max(0, startIndex); index < chain.length; index++) {
      const model = chain[index];
      const entry = health[model];
      if (entry && entry.cooldownUntil > now) {
         if (firstCooling < 0) firstCooling = index;
         skipped.push(model);
         continue;
      }
      return { index, model, skipped, allCooling: false };
   }
   if (firstCooling >= 0) {
      const model = chain[firstCooling];
      return { index: firstCooling, model, skipped, allCooling: true };
   }
   return undefined;
}

/**
 * 读健康表（mesh 的版本化 KV）。读不到 / mesh 不可用都返回空表：健康表是优化而非真相，
 * 记账失败绝不能挡住派发。
 * @param {any} mesh @returns {Promise<Record<string, HealthEntry>>}
 */
async function __staffsLoadHealth(mesh) {
   /** @type {Record<string, HealthEntry>} */
   const out = {};
   if (!mesh || typeof mesh.list !== "function") return out;
   try {
      const entries = await mesh.list({ prefix: __STAFFS_HEALTH_PREFIX, limit: 200 });
      for (const entry of Array.isArray(entries) ? entries : []) {
         const key = entry && typeof entry.key === "string" ? entry.key : "";
         if (!key.startsWith(__STAFFS_HEALTH_PREFIX)) continue;
         const value = entry.value;
         if (!value || typeof value !== "object") continue;
         out[key.slice(__STAFFS_HEALTH_PREFIX.length)] = {
            failures: Number(value.failures) || 0,
            cooldownUntil: Number(value.cooldownUntil) || 0,
            lastError: typeof value.lastError === "string" ? value.lastError : undefined,
            updatedAt: Number(value.updatedAt) || 0,
         };
      }
   } catch {
      return out;
   }
   return out;
}

/**
 * @param {any} mesh @param {string} model @param {HealthEntry} entry @returns {Promise<void>}
 */
async function __staffsSaveHealth(mesh, model, entry) {
   if (!mesh || typeof mesh.put !== "function") return;
   try {
      await mesh.put({ key: __STAFFS_HEALTH_PREFIX + model, value: entry });
   } catch {
      /* 同上：记账是优化 */
   }
}

/**
 * 更新健康条目：成功清零；失败累计并把冷却时间按连续失败次数放大（上限 2^4 倍）。
 * @param {HealthEntry | undefined} previous @param {boolean} ok @param {string} kind @param {unknown} errorText @param {number} now
 * @returns {HealthEntry}
 */
function __staffsNextHealth(previous, ok, kind, errorText, now) {
   if (ok) return { failures: 0, cooldownUntil: 0, updatedAt: now };
   const failures = (previous ? previous.failures : 0) + 1;
   const cooldown = __staffsFailurePlan(kind).cooldownMs;
   const growth = Math.min(4, Math.max(0, failures - 1));
   return {
      failures,
      cooldownUntil: now + cooldown * 2 ** growth,
      lastError: String(errorText || "").slice(0, 300),
      updatedAt: now,
   };
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
 * 带回退链的派发循环（票 05 的核心）。
 * @param {{
 *   host: StaffsHost;
 *   chain: string[];
 *   task: string;
 *   request: Record<string, unknown>;
 *   policy?: Partial<StaffsPolicy>;
 *   spawn?: boolean;
 * }} deps
 * @returns {Promise<{ ok: boolean; attempts: AttemptRecord[]; result?: any; handle?: any; error?: string; kind?: string }>}
 */
async function __staffsRun(deps) {
   const host = deps.host || {};
   const agents = host.agents;
   if (!agents || typeof agents.run !== "function") {
      throw new Error("Pi-Staffs 需要 Fabric 的 agents API：请在 fabric_exec 里派发");
   }
   const chain = Array.isArray(deps.chain) ? deps.chain : [];
   if (chain.length === 0) {
      throw new Error("Pi-Staffs 角色没有可用的模型链：检查 model / fallbacks 是否可解析");
   }
   const policy = deps.policy || {};
   const attemptsPerModel = Math.max(1, Math.floor(Number(policy.attemptsPerModel) || 2));
   const backoffBaseMs = Math.max(1, Number(policy.backoffBaseMs) || 1500);
   const backoffCapMs = Math.max(backoffBaseMs, Number(policy.backoffCapMs) || 30000);
   const health = await __staffsLoadHealth(host.mesh);
   /** @type {AttemptRecord[]} */
   const attempts = [];
   let lastError = "";
   let lastKind = "other";
   let cursor = 0;

   while (cursor < chain.length) {
      const choice = __staffsSelectModel(chain, cursor, health, __staffsNow());
      if (!choice) break;
      for (const skipped of choice.skipped) {
         attempts.push({
            model: skipped,
            attempt: 0,
            ok: false,
            kind: "cooldown",
            reason: "在冷却中，先跳过",
            ms: 0,
         });
      }

      for (let attempt = 1; attempt <= attemptsPerModel; attempt++) {
         const startedAt = __staffsNow();
         let ok = false;
         let text = "";
         let result;
         try {
            const request = { ...deps.request, task: deps.task, model: choice.model };
            result = deps.spawn === true ? await agents.spawn(request) : await agents.run(request);
            ok = !(result && typeof result.error === "string" && result.error.trim());
            if (!ok) text = String(result && result.error);
         } catch (error) {
            text = error instanceof Error ? error.message : String(error);
         }
         const kind = ok ? "ok" : __staffsClassify(text);
         attempts.push({
            model: choice.model,
            attempt,
            ok,
            kind,
            reason: ok ? "成功" : text.slice(0, 300),
            ms: __staffsNow() - startedAt,
         });
         health[choice.model] = __staffsNextHealth(
            health[choice.model],
            ok,
            kind,
            text,
            __staffsNow(),
         );
         await __staffsSaveHealth(host.mesh, choice.model, health[choice.model]);
         if (ok) {
            return deps.spawn === true
               ? { ok: true, attempts, handle: result }
               : { ok: true, attempts, result };
         }
         lastError = text;
         lastKind = kind;
         const plan = __staffsFailurePlan(kind);
         if (!plan.advance) return { ok: false, attempts, error: text, kind };
         if (!plan.retrySame || attempt >= attemptsPerModel) break;
         const retryAfterMs = __staffsRetryAfterMs(text, __staffsNow());
         const delay = Math.max(
            retryAfterMs,
            __staffsBackoffMs(attempt, backoffBaseMs, backoffCapMs, __staffsRandom()),
         );
         attempts.push({
            model: choice.model,
            attempt,
            ok: false,
            kind: "backoff",
            reason: `退避 ${delay}ms${retryAfterMs > 0 ? "（Retry-After）" : ""}`,
            ms: 0,
         });
         await __staffsSleep(delay);
      }
      cursor = choice.index + 1;
   }
   return {
      ok: false,
      attempts,
      error: lastError || "Pi-Staffs 模型链全部失败",
      kind: lastKind,
   };
}

/**
 * 预检（票 14 的快速失败）：用 agents.models() 判断引用是否存在，缺失时列出该 provider 的候选模型。
 * @param {StaffsHost} host @param {Record<string, string[]>} chains @param {string[]=} roles
 * @returns {Promise<{ ok: boolean; models: Array<{ model: string; available: boolean; candidates: string[] }>; missing: string[] }>}
 */
async function __staffsPreflight(host, chains, roles) {
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
   for (const name of Object.keys(chains)) {
      if (Array.isArray(roles) && roles.length > 0 && !roles.includes(name)) continue;
      for (const model of chains[name]) targets.push(model);
   }
   const unique = Array.from(new Set(targets));
   const models = unique.map((model) => {
      const slash = model.indexOf("/");
      const provider = slash > 0 ? model.slice(0, slash) : model;
      return {
         model,
         available: known.has(model),
         candidates: (byProvider.get(provider) || []).slice(0, 8),
      };
   });
   const missing = models.filter((entry) => !entry.available).map((entry) => entry.model);
   return { ok: missing.length === 0, models, missing };
}
