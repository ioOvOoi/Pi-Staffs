/**
 * AA 每日拉取与池快照写回（票 04）。
 *
 * 数据流：pi-jev auth.ts 的 resolveAaKey（凭据库>env）→ AA Data API v2 free 端点
 * （分页全量）→ 按 slug 匹配池条目 → 原子写回池文件 aa 快照列。
 *
 * 为什么写回池文件而不是 state：aa.refreshedAt 本来就是池条目的机写字段（票 01 预留），
 * 「当日已拉」直接读它做纯函数判定，不再开第二个状态源（单一真相源）。
 *
 * 失败全降级（规格：不影响会话启动）：无 key 静默跳过 / 网络失败返回 error 不崩 /
 * 未收录条目原样保留 manualTier 兜底。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { loadJevModule } from "./route.ts";
import {
   loadPool,
   savePool,
   type PoolEntry,
   type PoolFile,
} from "./pool.ts";

/** 每日拉取的网络超时：会话启动后台跑，久一点无妨，但不能挂死。 */
const FETCH_TIMEOUT_MS = 20000;

export type AaSnapshot = {
   intelligenceIndex?: number;
   inPrice?: number;
   outPrice?: number;
   throughput?: number;
   refreshedAt: string;
};

export type RefreshResult =
   | { skipped: true; reason: string; guidance?: string }
   | { error: string }
   | { updated: number; path: string };

export type RefreshDeps = {
   fetchImpl?: typeof fetch;
   env?: NodeJS.ProcessEnv;
   now?: () => Date;
   poolPath?: string;
   /** 桩注入点：smoke 用它替换 resolveAaKey 的真实加载（不触 pi-jev）。形状对齐 pi-jev auth.ts 的 AaKeyResult。 */
   resolveAaKeyImpl?: () => Promise<{
      key: string | null;
      source: string;
      guidance?: string;
   }>;
};

/**
 * AA 模型条目 → 池快照字段（API 字段名在此集中适配，换版只改这里）。
 * 字段路径已按官方文档核实（2026-09）：intelligence_index 在 evaluations 下、
 * 吞吐新版在 performance 下（旧版顶层，双路径兼容至旧端点 2026-11-04 停用）。
 * 防御式：字段缺/类型不对就留 undefined，绝不把垃圾写进池。
 */
export const mapAaItem = (
   item: unknown,
   refreshedAt: string,
): { slug: string; snapshot: AaSnapshot } | null => {
   if (!item || typeof item !== "object") return null;
   const raw = item as Record<string, unknown>;
   const slug = typeof raw.slug === "string" ? raw.slug : "";
   if (!slug.trim()) return null;
   const num = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) ? v : undefined;
   const sub = (name: string): Record<string, unknown> =>
      (raw[name] && typeof raw[name] === "object"
         ? (raw[name] as Record<string, unknown>)
         : {}) as Record<string, unknown>;
   const evaluations = sub("evaluations");
   const pricing = sub("pricing");
   const performance = sub("performance");
   return {
      slug,
      snapshot: {
         intelligenceIndex: num(evaluations.artificial_analysis_intelligence_index),
         inPrice: num(pricing.price_1m_input_tokens),
         outPrice: num(pricing.price_1m_output_tokens),
         throughput:
            num(performance.median_output_tokens_per_second) ??
            num(raw.median_output_tokens_per_second),
         refreshedAt,
      },
   };
};

/**
 * slug ↔ 池条目 id 匹配：比对 id 最后一段（provider 前缀后的裸名）与 slug，
 * 大小写不敏感、互为前缀也算命中（"glm-5.3" vs "glm-5.3-thinking"）。
 * 为什么宽松：池 id 人写自由（ollama-cloud/glm-5.3），AA slug 官方命名，
 * 严格相等会大面积匹配不上，快照永远空。
 */
export const entryIdMatches = (entryId: string, slug: string): boolean => {
   const bare = entryId.split("/").pop()?.toLowerCase() ?? "";
   const target = slug.toLowerCase();
   if (!bare || !target) return false;
   return bare === target || bare.startsWith(target) || target.startsWith(bare);
};

/**
 * 「当日已拉」纯函数：池里任一 aa 快照的 refreshedAt 是今天即视为已拉。
 * refreshedAt 存完整 ISO 时间戳，这里按日期前缀比（startsWith），不能全等。
 */
export const isRefreshedToday = (
   pool: PoolFile | null | undefined,
   today: string,
): boolean =>
   (pool?.entries ?? []).some((entry) =>
      (entry?.aa?.refreshedAt ?? "").startsWith(today),
   );

/**
 * 加载 pi-jev 的 resolveAaKey（凭据库>env>missing+指引）：复用 route.ts 的
 * 候选通道（env PI_JEV_ENTRY → 包名 → 本机 checkout），auth.ts 与 index.ts 同目录。
 */
const loadResolveAaKey = async (
   env: NodeJS.ProcessEnv = process.env,
): Promise<
   (() => Promise<{
      key: string | null;
      source: string;
      guidance?: string;
   }>)
   | null
> => {
   // 走 route.ts 的 loadJevModule（票 08）：候选表/循环 import 不再复制一份。
   const mod = await loadJevModule(env, ["resolveAaKey"]);
   return mod
      ? (mod.resolveAaKey as () => Promise<{
           key: string | null;
           source: string;
           guidance?: string;
         }>)
      : null;
};

/**
 * 分页拉全量模型列表；HTTP 非 2xx 抛错（调用方 catch 降级）。
 * 端点/认证/分页均已按官方文档核实（2026-09）：免费层走 /language/models/free，
 * 认证头是 x-api-key（非 Bearer），分页只有 page 参数，续页看 pagination.has_more。
 * （旧 /data/llms/models 将于 2026-11-04 停用，不采用。）
 */
const fetchAllModels = async (
   fetchImpl: typeof fetch,
   key: string,
): Promise<unknown[]> => {
   const out: unknown[] = [];
   for (let page = 1; ; page++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let response: Response;
      try {
         response = await fetchImpl(
            `https://artificialanalysis.ai/api/v2/language/models/free?page=${page}`,
            { headers: { "x-api-key": key }, signal: controller.signal },
         );
      } finally {
         clearTimeout(timer);
      }
      if (!response.ok)
         throw new Error(`AA HTTP ${response.status}（page=${page}）`);
      const body = (await response.json()) as {
         data?: unknown;
         pagination?: { has_more?: boolean };
      };
      const items = Array.isArray(body?.data) ? body.data : [];
      out.push(...items);
      if (!body?.pagination?.has_more) break;
   }
   return out;
};

/**
 * 主入口：无 key 降级 / 网络失败不崩 / 成功写回并报条数。
 * 已拉过今天则直接返回（幂等，session_start 每天最多真的打一次网络）。
 */
export const refreshPoolAa = async (
   deps: RefreshDeps = {},
): Promise<RefreshResult> => {
   const env = deps.env ?? process.env;
   const now = deps.now ?? (() => new Date());
   const today = now().toISOString().slice(0, 10);
   const poolPath =
      deps.poolPath ??
      env.PI_STAFFS_POOL?.trim() ??
      join(homedir(), ".pi", "agent", "model-pool.json");

   // 走 loadPool 门面：缺失回空池、坏 JSON 不抛（原先裸 parse 会炸掉刷新）。
   const pool = loadPool({ path: poolPath }).pool;
   if (isRefreshedToday(pool, today))
      return { updated: 0, path: poolPath } as RefreshResult;

   const resolveAaKey =
      deps.resolveAaKeyImpl ??
      (await loadResolveAaKey(env)) ??
      null;
   if (!resolveAaKey)
      return {
         skipped: true,
         reason: "pi-jev 不可加载，AA 自动拉取跳过（池靠 manualTier 兜底）",
      };
   const credential = await resolveAaKey();
   if (!credential.key)
      return { skipped: true, reason: "AA key 未设置", guidance: credential.guidance };

   try {
      const fetchImpl = deps.fetchImpl ?? fetch;
      const models = await fetchAllModels(fetchImpl, credential.key);
      const refreshedAt = now().toISOString();
      const bySlug = new Map<string, AaSnapshot>();
      for (const item of models) {
         const mapped = mapAaItem(item, refreshedAt);
         if (mapped) bySlug.set(mapped.slug, mapped.snapshot);
      }
      let updated = 0;
      const nextEntries: PoolEntry[] = pool.entries.map((entry) => {
         const slug = [...bySlug.keys()].find((s) => entryIdMatches(entry.id, s));
         if (!slug) return entry; // 未收录：原样保留（manualTier 兜底不动）
         updated += 1;
         return { ...entry, aa: bySlug.get(slug) };
      });
      savePool(poolPath, { ...pool, entries: nextEntries });
      return { updated, path: poolPath };
   } catch (error) {
      return {
         error: `AA 拉取失败（池未改动）：${error instanceof Error ? error.message : String(error)}`,
      };
   }
};
