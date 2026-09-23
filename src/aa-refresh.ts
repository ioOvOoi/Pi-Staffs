/**
 * AA 每日拉取与池快照写回（票 04）。
 *
 * 数据流（票 14 起双源）：主源 = AA 模型详情页网页（无鉴权，字段全：智力/单价/中位
 * 吞吐）→ 按条目归一裸名逐条抓取；回落 = pi-jev auth.ts 的 resolveAaKey（凭据库>env）
 * → AA Data API v2 free 端点（分页全量，字段裁剪版）补网页未命中条目 →
 * 按 slug 归一匹配池条目 → 原子写回池文件 aa 快照列。
 *
 * 为什么写回池文件而不是 state：aa.refreshedAt 本来就是池条目的机写字段（票 01 预留），
 * 「当日已拉」直接读它做纯函数判定，不再开第二个状态源（单一真相源）。
 *
 * 失败全降级（规格：不影响会话启动）：无 key 静默跳过 / 网络失败返回 error 不崩 /
 * 未收录条目原样保留 manualTier 兜底。
 */
import { loadJevModule } from "./route.ts";
import {
   defaultPoolFilePath,
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
   | { updated: number; path: string; guidance?: string };

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
 * slug 归一：小写 + 点转横线。AA 详情页 slug 是横线形态（deepseek-v4-1-flash），
 * 池条目裸名是点形态（deepseek-v4.1-flash），free API 的 slug 与裸名同形（带点）。
 * 网页/API 两条路径的匹配统一走归一键；互吸防护不变（glm-5-3-flash ≠ glm-5-3）。
 */
export const normSlug = (slug: string): string => slug.toLowerCase().replaceAll(".", "-");

/**
 * slug ↔ 池条目 id 匹配：双侧归一后严格相等。
 * 为什么收紧（原为互为前缀也算命中）：宽松匹配让 glm-5.3-flash 吸走 glm-5.3
 * 的快照（前缀互吸），flash 拿到主模型的智力/价格参与路由排序，造成误派。
 * 宁缺毋滥：匹配不上就不写快照，条目走 manualTier 兜底。
 */
export const entryIdMatches = (entryId: string, slug: string): boolean => {
   const bare = entryId.split("/").pop() ?? "";
   if (!bare.trim() || !slug.trim()) return false;
   return normSlug(bare) === normSlug(slug);
};

/** AA 详情页地址：网页主源入口（无鉴权）。 */
const AA_WEB_MODELS_URL = "https://artificialanalysis.ai/models/";

/**
 * RSC flight 文本重建：push 段外层 JSON.parse 取第二元素（flight 文本），坏段跳过。
 * 实测详情页 155 段全可 parse（2026-09）；单段损坏不致命，缺的只是那部分数据。
 */
const extractFlightText = (html: string): string => {
   const parts: string[] = [];
   for (const m of html.matchAll(/self\.__next_f\.push\((\[.*?\])\)<\/script>/gs)) {
      try {
         const arr = JSON.parse(m[1]) as unknown[];
         if (typeof arr[1] === "string") parts.push(arr[1]);
      } catch {
         // 异形段跳过：flight 是 React 内部序列化，无跨站契约，防御式处理
      }
   }
   return parts.join("");
};

/**
 * 详情页 flight 文本 → 池快照（票 14 网页主源核心）。
 * 主对象以 {"id":"<uuid>","slug":"<slug>"} 锚定，9000 字符窗口内抽字段
 * （实测主对象字段集中在前 6KB，窗口冗余防字段后移变体对象混入——窗口内首个
 * intelligenceIndex 即主对象的）。
 * 字段名（2026-09 详情页 flight 实测，与 free API 命名不同）：
 *   intelligenceIndex / price1mInputTokens / price1mOutputTokens /
 *   timescaleData.medianOutputSpeed。
 * 防御：锚不到 / 改版 / 字段全缺 → null（宁缺毋滥，回落 free API）。
 */
export const parseAaWebSnapshot = (
   flightText: string,
   slug: string,
   refreshedAt: string,
): AaSnapshot | null => {
   const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
   const anchor = new RegExp('\{"id":"[0-9a-f-]{36}","slug":"' + esc + '"');
   const start = flightText.search(anchor);
   if (start < 0) return null;
   const win = flightText.slice(start, start + 9000);
   const pick = (re: RegExp): number | undefined => {
      const m = win.match(re);
      const n = m ? Number(m[1]) : NaN;
      return Number.isFinite(n) ? n : undefined;
   };
   const snapshot: AaSnapshot = {
      intelligenceIndex: pick(/"intelligenceIndex":(-?[\d.]+)/),
      inPrice: pick(/"price1mInputTokens":([\d.]+)/),
      outPrice: pick(/"price1mOutputTokens":([\d.]+)/),
      throughput: pick(/"timescaleData":\{"medianOutputSpeed":([\d.]+)/),
      refreshedAt,
   };
   if (snapshot.intelligenceIndex === undefined) return null;
   return snapshot;
};

/**
 * 抓单条详情页 → 快照。任何失败（网络/超时/404/改版）都归 null：
 * 单条网页失败不致命，调用方对 null 条目走 free API 回落。
 */
const fetchAaWebSnapshot = async (
   fetchImpl: typeof fetch,
   slug: string,
   refreshedAt: string,
): Promise<AaSnapshot | null> => {
   const controller = new AbortController();
   const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
   try {
      const response = await fetchImpl(AA_WEB_MODELS_URL + slug, { signal: controller.signal });
      if (!response.ok) return null;
      return parseAaWebSnapshot(extractFlightText(await response.text()), slug, refreshedAt);
   } catch {
      return null;
   } finally {
      clearTimeout(timer);
   }
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
   const poolPath = deps.poolPath ?? defaultPoolFilePath(env);

   // 走 loadPool 门面：缺失回空池、坏 JSON 不抛（原先裸 parse 会炸掉刷新）。
   const pool = loadPool({ path: poolPath }).pool;
   if (isRefreshedToday(pool, today))
      return { updated: 0, path: poolPath } as RefreshResult;
   // 空池（含坏 JSON 回空池）无可刷新条目：skip 且不写盘，避免把坏文件覆盖成空池。
   if (pool.entries.length === 0)
      return { skipped: true, reason: "池为空或坏 JSON（回空池），AA 刷新跳过" };

   // 主源：网页（无鉴权）。每条目按归一裸名抓自己的详情页——抓到即天然精确命中，
   // 抓不到（未收录/404/改版）才落回落。并发跑，最坏耗时=单条超时而非条数×超时。
   const fetchImpl = deps.fetchImpl ?? fetch;
   const refreshedAt = now().toISOString();
   const byNorm = new Map<string, AaSnapshot>();
   await Promise.all(
      pool.entries.map(async (entry) => {
         const norm = normSlug(entry.id.split("/").pop() ?? "");
         if (!norm) return;
         const snapshot = await fetchAaWebSnapshot(fetchImpl, norm, refreshedAt);
         if (snapshot) byNorm.set(norm, snapshot);
      }),
   );

   // 回落：网页未命中条目走 free API 补。key 缺失时按命中程度分级：
   // 全命中照常返回 / 部分命中写回部分并带指引 / 零命中维持原 skip+指引语义。
   const missing = pool.entries.some((entry) => {
      const norm = normSlug(entry.id.split("/").pop() ?? "");
      return norm.length > 0 && !byNorm.has(norm);
   });
   if (missing) {
      const resolveAaKey = deps.resolveAaKeyImpl ?? (await loadResolveAaKey(env)) ?? null;
      if (!resolveAaKey) {
         if (byNorm.size > 0)
            return {
               updated: byNorm.size,
               path: poolPath,
               guidance: "pi-jev 不可加载，仅网页源命中；API 回落跳过",
            };
         return {
            skipped: true,
            reason: "pi-jev 不可加载，AA 自动拉取跳过（池靠 manualTier 兜底）",
         };
      }
      const credential = await resolveAaKey();
      if (!credential.key) {
         if (byNorm.size > 0)
            return { updated: byNorm.size, path: poolPath, guidance: credential.guidance };
         return { skipped: true, reason: "AA key 未设置", guidance: credential.guidance };
      }
      try {
         const models = await fetchAllModels(fetchImpl, credential.key);
         for (const item of models) {
            const mapped = mapAaItem(item, refreshedAt);
            if (!mapped) continue;
            const norm = normSlug(mapped.slug);
            if (norm && !byNorm.has(norm)) byNorm.set(norm, mapped.snapshot);
         }
      } catch (error) {
         // API 回落失败：网页已命中的照常写回；全空才报 error（网络失败语义保留）。
         if (byNorm.size === 0)
            return {
               error: `AA 拉取失败（池未改动）：${error instanceof Error ? error.message : String(error)}`,
            };
      }
   }

   let updated = 0;
   const nextEntries: PoolEntry[] = pool.entries.map((entry) => {
      const norm = normSlug(entry.id.split("/").pop() ?? "");
      const snapshot = norm ? byNorm.get(norm) : undefined;
      if (!snapshot) return entry; // 未收录：原样保留（manualTier 兜底不动）
      updated += 1;
      return { ...entry, aa: snapshot };
   });
   savePool(poolPath, { ...pool, entries: nextEntries });
   return { updated, path: poolPath };
};
