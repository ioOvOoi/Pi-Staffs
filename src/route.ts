/**
 * 宿主侧路由层（票 03）：会派发的 fabric_exec，先让 Jev 按角色答三问
 * （难度/领域/思考档），再用 pool.ts 的确定性匹配器从模型池选出 (model, thinking)，
 * 覆盖档位解析结果注入 prelude。
 *
 * 为什么挂在 prelude 构建（tool_call）而不是派发瞬间：guest 是隔离沙箱没有网络，
 * Jev 调用只能在宿主侧；每次 fabric_exec 都重建 prelude，路由结果天然按调用刷新。
 * 同一次调用内同角色多次派发共用一个路由结果——粒度是「每次调用 × 角色」
 * （ponytail：逐派发需要 guest↔宿主新桥，选型真失真了再升级）。
 *
 * 失败全部回落（规格：派发永不阻塞）：pi-jev 缺席 / key 缺失 / Jev 低置信 /
 * 池空 / 超时 → 该角色不进路由表，档位矩阵原样生效。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveModelRef, type StaffsConfig } from "./config.ts";
import {
   appendRoutingLog,
   loadPool,
   matchPool,
   type PoolFile,
   type RoutingLogEntry,
   type TaskProfile,
} from "./pool.ts";

export { ROUTING_LOG_CAP } from "./pool.ts";
/** Jev 整体硬超时：超过全线回落。派发自身的重试地板是 15s，路由久等无意义。 */
export const ROUTE_TIMEOUT_MS = 3000;
/** 喂给 Jev 的任务上下文上限：三问只要粗粒度判断，截断省 token 与时延。 */
const CONTEXT_CHARS = 800;

export type RouteDecision = { model: string; thinking?: string };
export type RouteMap = Record<string, RouteDecision>;

/** 三问答案里路由用得到的字段（开放形状，多出来的不认识也不崩）。 */
type JevAnswer = {
   score?: number;
   noul?: number;
   choice?: string;
   _lowConfidence?: boolean;
};

export type JevRunner = (args: {
   state: unknown;
   questions: Record<string, Record<string, unknown>>;
}) => Promise<{ answers?: Record<string, unknown>; error?: string }>;

export type RouteDeps = {
   /** 桩注入点：smoke 用假 runner；undefined 才走真实加载（pi-jev 缺席 → null）。 */
   runner?: JevRunner | null;
   poolPath?: string;
   env?: NodeJS.ProcessEnv;
   now?: () => number;
   /** 桩注入点：smoke 用它截获日志，不落盘。 */
   writeLog?: (pool: PoolFile, entries: RoutingLogEntry[]) => void;
};

/**
 * pi-jev 的入口候选：显式 env → 包名（将来装成依赖就能解析）→ 本机 checkout。
 * 为什么不写死唯一路径：两包松耦合（规格），任一缺席只降级不崩。
 */
const jevEntryCandidates = (env: NodeJS.ProcessEnv = process.env): string[] =>
   [
      env.PI_JEV_ENTRY?.trim(),
      "pi-jev",
      join(homedir(), ".pi", "selfex", "Pi-Jev", "src", "index.ts"),
   ].filter((value): value is string => !!value);

/** 加载 pi-jev 的 runner 工厂；任何一步失败都返回 null（路由整体回落）。 */
const loadJevRunner = async (
   env?: NodeJS.ProcessEnv,
): Promise<JevRunner | null> => {
   for (const spec of jevEntryCandidates(env)) {
      try {
         const url =
            spec.includes("/") || spec.includes("\\")
               ? pathToFileURL(spec).href
               : spec;
         const mod = (await import(url)) as {
            makeRunner?: unknown;
            loadConfig?: unknown;
            resolveKey?: unknown;
         };
         if (
            typeof mod.makeRunner !== "function" ||
            typeof mod.loadConfig !== "function" ||
            typeof mod.resolveKey !== "function"
         )
            continue;
         const cfg = await (mod.loadConfig as () => Promise<unknown>)();
         return (await (
            mod.makeRunner as (c: unknown, r: unknown) => Promise<JevRunner>
         )(cfg, mod.resolveKey)) as JevRunner;
      } catch {
         // 缺席/加载失败：试下一个候选，最终回落 preset
      }
   }
   return null;
};

/** 硬超时包装：到点返回 null，调用方据此全线回落。 */
const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T | null> => {
   let timer: ReturnType<typeof setTimeout> | undefined;
   const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
   });
   try {
      return await Promise.race([p, timeout]);
   } finally {
      clearTimeout(timer);
   }
};

/** 三问 → 任务画像；低置信/无效判答返回 null（该角色回落）。 */
const profileOf = (
   answers: Record<string, unknown>,
   role: string,
): TaskProfile | null => {
   const pick = (key: string): JevAnswer | undefined => {
      const value = answers[`${role}#${key}`];
      return value && typeof value === "object"
         ? (value as JevAnswer)
         : undefined;
   };
   const difficulty = pick("difficulty");
   const domain = pick("domain");
   const thinking = pick("thinking");
   if (
      difficulty?._lowConfidence ||
      domain?._lowConfidence ||
      thinking?._lowConfidence
   )
      return null;
   // 越界/缺省值交给 matchPool 的 normalizeProfile 兜底，这里只防明显非法。
   return {
      difficulty:
         typeof difficulty?.score === "number" && Number.isFinite(difficulty.score)
            ? difficulty.score
            : undefined,
      domain:
         typeof domain?.noul === "number"
            ? domain.noul >= 0.5
               ? "coding"
               : "general"
            : undefined,
      thinking:
         typeof thinking?.choice === "string"
            ? (thinking.choice as TaskProfile["thinking"])
            : undefined,
   };
};

/** 三问的统一问法：按角色前缀批量发，一次 Jev 往返出全部角色的画像。 */
const buildQuestions = (
   roles: readonly string[],
): Record<string, Record<string, unknown>> => {
   const questions: Record<string, Record<string, unknown>> = {};
   for (const name of roles) {
      questions[`${name}#difficulty`] = {
         type: "score",
         question: `角色 ${name} 在给定任务上下文中的工作难度（1=琐碎 5=极难）`,
         levels: [
            "1 琐碎：改名/查引用级别",
            "2 轻松：单点小改",
            "3 常规：多文件常规实现",
            "4 费劲：疑难调试/跨模块",
            "5 极难：架构决策/硬核问题",
         ],
      };
      questions[`${name}#domain`] = {
         type: "noul",
         question: `角色 ${name} 的任务是编码/代码实现类吗？`,
         trueMeans: "coding",
         falseMeans: "general",
      };
      questions[`${name}#thinking`] = {
         type: "choice",
         question: `角色 ${name} 的任务需要多深的思考档？`,
         options: {
            low: "照章办事，几乎不用推理",
            medium: "常规推理",
            high: "需要仔细权衡与排查",
            max: "极限推理（架构决策/硬核 bug）",
         },
      };
   }
   return questions;
};

/** 路由日志落盘（环形截断）；写失败静默吞掉——回落也绝不阻塞派发。 */
const persistLog = (
   outcome: { pool: PoolFile; path: string },
   entries: RoutingLogEntry[],
   deps: RouteDeps,
): void => {
   if (entries.length === 0) return;
   if (deps.writeLog) {
      deps.writeLog(outcome.pool, entries);
      return;
   }
   try {
      appendRoutingLog(outcome.path, outcome.pool, entries);
   } catch {
      // 日志写失败不影响派发
   }
};

/**
 * 路由主入口：角色 → (model, thinking)。任何失败路径都是「该角色缺席」
 * 而不是抛错——prelude 注入处无需再防御。
 */
export const resolveRouteMap = async (
   config: StaffsConfig,
   aliases: Record<string, string>,
   options: { taskContext?: string; deps?: RouteDeps } = {},
): Promise<RouteMap> => {
   const deps = options.deps ?? {};
   const now = deps.now ?? Date.now;
   const roles = Object.entries(config.roles)
      .filter(([, role]) => role.enabled !== false)
      .map(([name]) => name);
   if (roles.length === 0) return {};

   const runner = deps.runner !== undefined ? deps.runner : await loadJevRunner(deps.env);
   if (!runner) return {};

   const state = {
      roles,
      taskContext: String(options.taskContext ?? "").slice(0, CONTEXT_CHARS),
   };
   const reply = await withTimeout(
      runner({ state, questions: buildQuestions(roles) }),
      deps.env?.PI_STAFFS_ROUTE_TIMEOUT
         ? Number(deps.env.PI_STAFFS_ROUTE_TIMEOUT) || ROUTE_TIMEOUT_MS
         : ROUTE_TIMEOUT_MS,
   );
   const answers =
      reply && !reply.error && reply.answers ? reply.answers : undefined;
   if (!answers) return {};

   const outcome = loadPool({ path: deps.poolPath, env: deps.env });
   const at = new Date(now()).toISOString();
   const map: RouteMap = {};
   const entries: RoutingLogEntry[] = [];
   for (const name of roles) {
      const profile = profileOf(answers, name);
      if (!profile) {
         entries.push({
            at,
            role: name,
            profile: "Jev 低置信/无效判答",
            selected: "(回落 preset)",
            fallback: true,
         });
         continue;
      }
      const label = `难度${profile.difficulty ?? 3}/${profile.domain ?? "general"}/${profile.thinking ?? "medium"}`;
      const match = matchPool(profile, outcome.pool);
      const ref = match ? resolveModelRef(match.model, aliases)?.ref : undefined;
      if (!match || !ref) {
         entries.push({
            at,
            role: name,
            profile: `${label}${match ? "（别名无法解析）" : "（池无达标条目）"}`,
            selected: "(回落 preset)",
            fallback: true,
         });
         continue;
      }
      map[name] = { model: ref, thinking: match.thinking };
      entries.push({
         at,
         role: name,
         profile: label,
         selected: `${ref} ${match.thinking}`,
         fallback: false,
      });
   }
   persistLog(outcome, entries, deps);
   return map;
};
