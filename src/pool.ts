/**
 * 模型池 schema 与确定性匹配器（票 01）。
 *
 * 为什么独立成模块而不是塞进 config.ts：池文件是「人写档 + 机写快照」的独立真相源，
 * 票 04 会每日自动改写它，票 03 把路由日志写回它的 routingLog 段——它自己就是一个
 * 需要被读写/校验/落盘的数据类型，跟角色矩阵配置的生命周期完全不同。
 *
 * 匹配器被特意写成不吃环境、不碰网络的纯函数：三问 + 池进，{model, thinking} | null 出。
 * 派发路径上的回落决策（null → 用 preset）属于票 03，这里不越界。
 */
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { THINKING_LEVELS, readJson, type ThinkingLevel } from "./config.ts";

/** 池条目的人写字段 + 机写快照（AA 列由票 04 每日更新）。 */
export type PoolEntry = {
   /** 模型引用（provider/model 或 fabric 别名），匹配命中后由派发层直接使用。 */
   id: string;
   /** "cloud" 云端 / "ollama" 本地；匹配不看它，仅作审计与面板展示。 */
   platform: string;
   /** 人写：该模型支持的思考档；任务所需思考必须落在此集合（求交）。 */
   thinkingLevels: ThinkingLevel[];
   /** 人写：给面板和人工审计看的说明（本地模型无榜单数据时尤其重要）。 */
   description: string;
   /**
    * 人写能力档 1..5（本地模型的兜底信号，AA 不收录 ollama）。
    * 为什么存在：本地模型没有 AA 榜单列，没有它匹配器只能放弃——那池里就只剩下云端了
    * （用户故事 9：全池可用）。
    */
   manualTier?: number;
   /** 机写快照：Artificial Analysis 的智力指数与定价（票 04 每日刷新）。 */
   aa?: {
      intelligenceIndex?: number;
      inPrice?: number;
      outPrice?: number;
      throughput?: number;
      refreshedAt?: string;
   };
   /** 机写快照：SWE-bench 分数（无 API，票 04 只提示人工查榜更新）。 */
   sweBench?: number;
   sweBenchUpdatedAt?: string;
   /** 开放形状：未来机写列不破坏既有池文件。 */
   [key: string]: unknown;
};

/** 路由日志环（票 03 写）：面板跨包读这个文件做审计。这里是 schema 预留，写入归票 03。 */
export type RoutingLogEntry = {
   at: string;
   role: string;
   profile: string;
   selected: string;
   fallback: boolean;
};

export type PoolFile = {
   entries: PoolEntry[];
   routingLog: RoutingLogEntry[];
   /** schema 版本门（票 13）：未来字段语义变更时靠它判定迁移路径（savePool 统一写 1）。 */
   version?: number;
   [key: string]: unknown;
};

/** 任务三问（Jev 答，票 03 喂给匹配器）。字段都可缺省：领域缺省按通用，思考缺省取 medium。 */
export type TaskProfile = {
   /** 1..5，越大越难；对应参考列最低分区间（见 DIFFICULTY_THRESHOLDS）。 */
   difficulty?: number;
   domain?: "coding" | "general";
   thinking?: ThinkingLevel;
};

export type MatchResult = { model: string; thinking: ThinkingLevel };

/**
 * 难度 → 参考列最低分（编码看 sweBench、通用看 intelligenceIndex）。
 * 为什么是 [0,20,40,60,80]：每档差 20 分、封顶 80——顶配模型要留余量，否则 90+ 的旗舰
 * 永远只被难度 5 选中，中间档没有区分度。分数线是人工定死的常量，改它 = 改选型政策，
 * 故意不做成配置项（YAGNI）。
 */
export const DIFFICULTY_THRESHOLDS = [0, 20, 40, 60, 80];

export const defaultPoolFilePath = (env: NodeJS.ProcessEnv = process.env): string =>
   env.PI_STAFFS_POOL?.trim() || join(homedir(), ".pi", "agent", "model-pool.json");

/** 合法思考档集合，防御非法输入。 */
const isValidThinking = (value: unknown): value is ThinkingLevel =>
   typeof value === "string" && THINKING_LEVELS.has(value);

/**
 * 三问缺省值处理。为什么 thinking 缺省取 "medium"：匹配器必须输出一个确定档位，
 * 偏低（low）有偷懒风险，偏高（max）浪费；medium 是最不坏的中性选择，Jev 在线时
 * 不会走到这里。
 */
const normalizeProfile = (
   profile: TaskProfile | null | undefined,
): { difficulty: number; domain: "coding" | "general"; thinking: ThinkingLevel } => {
   const source = (profile && typeof profile === "object" ? profile : {}) as TaskProfile;
   const rawDifficulty =
      typeof source.difficulty === "number" && Number.isFinite(source.difficulty)
         ? Math.round(source.difficulty)
         : 3;
   const difficulty = Math.min(5, Math.max(1, rawDifficulty));
   const domain = source.domain === "coding" ? "coding" : "general";
   const thinking = isValidThinking(source.thinking) ? source.thinking : "medium";
   return { difficulty, domain, thinking };
};

/** 所需思考与条目 thinkingLevels 求交：缺省视为支持全部档（宽松读取，避免误伤手写池）。 */
const supportsThinking = (entry: PoolEntry, thinking: ThinkingLevel): boolean => {
   const levels = entry.thinkingLevels;
   if (!Array.isArray(levels) || levels.length === 0) return true;
   return levels.some((level) => level === thinking);
};

/** 正数价格才有意义；缺/非正都当「未知」，性价比记 0（排在所有已知价格后面）。 */
const priceOf = (value: unknown): number => {
   if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
      return Infinity;
   return value;
};

/**
 * 给条目打分：AA 参考列存在按领域选列；缺列（本地 ollama 等）走 manualTier 兜底。
 * 为什么本地质量 = manualTier × 20：把人写档 1..5 平移到 0..100 参考列同标尺，
 * 这样「难度定区间」对两类条目用同一把尺子，才能公平地同池竞争。
 */
const scoreEntry = (
   entry: PoolEntry,
   domain: "coding" | "general",
): { quality: number; price: number } | null => {
   const reference =
      domain === "coding" ? entry.sweBench : entry.aa?.intelligenceIndex;
   if (typeof reference === "number" && Number.isFinite(reference))
      return { quality: reference, price: priceOf(entry.aa?.inPrice) };
   const tier =
      typeof entry.manualTier === "number" && Number.isFinite(entry.manualTier)
         ? Math.min(5, Math.max(1, Math.round(entry.manualTier)))
         : 0;
   if (tier >= 1) return { quality: tier * 20, price: 0 };
   return null;
};

/**
 * 确定性匹配器（纯函数，不触网、不读全局单例）：
 * 难度定参考列最低分区间 → 区间内性价比最优（质量/价格，零成本本地默认最优先）。
 *
 * 为什么用「质量/价格」而不是「先最便宜」：只挑廉价会选到垫底模型（低质高性价比），
 * 只挑高分会让轻任务烧旗舰；除一下正好把「够用且便宜」顶上来，也自然兑现用户故事
 * 「价格列把轻活导向零成本本地模型」。
 */
export const matchPool = (
   profile: TaskProfile,
   pool: PoolFile | null | undefined,
): MatchResult | null => {
   const entries = pool?.entries;
   if (!Array.isArray(entries) || entries.length === 0) return null;
   const { difficulty, domain, thinking } = normalizeProfile(profile);
   const threshold = DIFFICULTY_THRESHOLDS[difficulty - 1];
   const candidates: {
      model: string;
      thinking: ThinkingLevel;
      ratio: number;
      quality: number;
   }[] = [];
   for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const id = entry.id;
      if (typeof id !== "string" || !id.trim()) continue;
      if (!supportsThinking(entry, thinking)) continue;
      const scored = scoreEntry(entry, domain);
      if (!scored || scored.quality < threshold) continue;
      candidates.push({
         model: id,
         thinking,
         // 零成本（本地）记正无穷：同池竞争里免费模型赢下达标轻任务。
         ratio: scored.price > 0 ? scored.quality / scored.price : Infinity,
         quality: scored.quality,
      });
   }
   if (candidates.length === 0) return null;
   candidates.sort(
      (a, b) =>
         b.ratio - a.ratio ||
         b.quality - a.quality ||
         (a.model < b.model ? -1 : 1),
   );
   const best = candidates[0];
   return { model: best.model, thinking: best.thinking };
};

/** 校验并归一池文件：坏条目只丢自己并报问题，合法条目与额外字段原样保留。 */
export const normalizePool = (
   raw: unknown,
): { pool: PoolFile; issues: string[] } => {
   const issues: string[] = [];
   const source = (raw && typeof raw === "object" ? raw : {}) as Record<
      string,
      unknown
   >;
   // schema 版本门（票 13）：明确不认识的版本按空池降级并警告，而不是让旧代码
   // 静默误读新文件——字段语义漂移最怕的就是「照读无告警」。
   const version = typeof source.version === "number" ? source.version : undefined;
   if (version !== undefined && version !== 1) {
      return {
         pool: { entries: [], routingLog: [] },
         issues: [
            `池文件 schema 版本 ${version} 不受支持（当前预期 1），已按空池降级（原文件未改动）。`,
         ],
      };
   }
   const entriesRaw = Array.isArray(source.entries) ? source.entries : [];
   const entries: PoolEntry[] = [];
   for (const item of entriesRaw) {
      if (!item || typeof item !== "object") {
         issues.push("池条目不是对象，已剔除");
         continue;
      }
      const entry = item as PoolEntry;
      if (typeof entry.id !== "string" || !entry.id.trim()) {
         issues.push("池条目缺 id（无法派发），已剔除");
         continue;
      }
      entries.push(entry);
   }
   const routingLog = Array.isArray(source.routingLog)
      ? (source.routingLog as RoutingLogEntry[])
      : [];
   const pool: PoolFile = { ...source, entries, routingLog };
   return { pool, issues };
};

/** 生成模板内容：缺失/损坏时给用户一份可直接编辑的起点，而不是一句空话。 */
export const buildPoolTemplate = (): PoolFile => ({
   version: 1,
   entries: [
      {
         id: "ollama-cloud/glm-5.3",
         platform: "cloud",
         thinkingLevels: ["low", "medium", "high", "max"],
         description: "旗舰云端模型：复杂推理与编码，AA 榜单数据由每日刷新自动维护",
         manualTier: 4,
         aa: {
            intelligenceIndex: 90,
            inPrice: 5,
            outPrice: 15,
            throughput: 40,
            refreshedAt: "",
         },
         sweBench: 75,
         sweBenchUpdatedAt: "",
      },
      {
         id: "ollama/deepseek-v4-flash:0731",
         platform: "ollama",
         thinkingLevels: ["low", "medium"],
         description: "本地轻量模型：快速侦查、零成本；AA 不收录，靠 manualTier 兜底",
         manualTier: 2,
      },
   ],
   routingLog: [],
});

export type PoolLoadOutcome = {
   pool: PoolFile;
   issues: string[];
   path: string;
};

/**
 * 加载池文件：缺失/坏 JSON 都回空池并给模板提示，绝不抛错、绝不覆盖用户文件
 * （覆盖是数据丢失，与 loadStaffsConfig 同一原则）。
 */
export const loadPool = (
   options: { path?: string; env?: NodeJS.ProcessEnv } = {},
): PoolLoadOutcome => {
   const path = options.path ?? defaultPoolFilePath(options.env);
   if (!existsSync(path)) {
      const hint =
         "可手动创建一份池文件（人写字段 + 机写快照 + routingLog 段），模板如下：\n" +
         JSON.stringify(buildPoolTemplate(), null, 2);
      return {
         pool: { entries: [], routingLog: [] },
         issues: [
            `模型池文件不存在：${path}（本次用空池，路由将回落 preset）。` + hint,
         ],
         path,
      };
   }
   const raw = readJson(path);
   if (raw === undefined) {
      const hint =
         "可对照模板修正（人写字段 + 机写快照 + routingLog 段）：\n" +
         JSON.stringify(buildPoolTemplate(), null, 2);
      return {
         pool: { entries: [], routingLog: [] },
         issues: [
            `模型池文件为非法 JSON（本次用空池，原文件未改动）：${path}。` + hint,
         ],
         path,
      };
   }
   const { pool, issues } = normalizePool(raw);
   return { pool, issues, path };
};

/** 路由日志环形上限：只留最近判断（面板审计滚动看，不无限膨胀池文件）。 */
export const ROUTING_LOG_CAP = 50;

const LOCK_TIMEOUT_MS = 5000;

/** busy 自旋：锁窗口毫秒级、Node 主线程无同步 sleep，最坏 ~500ms 可接受。 */
const spinWait = (ms: number): void => {
   const end = Date.now() + ms;
   while (Date.now() < end) {}
};

/**
 * 跨进程互斥（O_EXCL 锁文件，票 13）：函数内重读只缩小读-改-写窗口，
 * 真正「同时」的两次记账仍会互相覆盖——互斥才是防丢账的最后一块。
 * 死锁残留（持锁进程崩溃）靠时间戳超龄强制接管，不会永久卡死。
 */
const acquirePoolLock = (path: string): boolean => {
   const lockPath = `${path}.lock`;
   for (let i = 0; i < 50; i++) {
      try {
         closeSync(openSync(lockPath, "wx"));
         writeFileSync(lockPath, String(Date.now()), "utf-8");
         return true;
      } catch {
         try {
            const raw = readFileSync(lockPath, "utf-8");
            const ts = Number(raw);
            if (Number.isFinite(ts) && ts > 0 && Date.now() - ts > LOCK_TIMEOUT_MS) {
               unlinkSync(lockPath);
            }
         } catch {
            /* 锁刚被释放或内容暂不可读：下一轮重试 */
         }
         spinWait(10);
      }
   }
   return false;
};

const releasePoolLock = (path: string): void => {
   try {
      unlinkSync(`${path}.lock`);
   } catch {
      /* 已被超时接管方清理 */
   }
};

/**
 * 原子写池文件（tmp + rename，学 state.ts）；目录不存在先建。
 * 唯一落盘通道：session_start 的 AA 快照刷新与每次 tool_call 的日志落盘
 * 并发时，非原子全量重写会互相覆盖丢数据，所以调用方一律走这里。
 * 锁边界（票 13）：互斥只包 appendRoutingLog 的读-改-写（丢账高危路径）；
 * 本函数的全量写不加锁——调用方是低频单点（AA 每日刷新/模板重建），
 * 为它引入重入语义不值当。
 */
export const savePool = (path: string, pool: PoolFile): void => {
   // tmp 名唯一化（票 13）：固定 `${path}.tmp` 在两进程同时落盘时会互踩——
   // 一方 rename 拿到对方内容、另一方直接 ENOENT。pid+时间戳+随机段保证各自隔离。
   const tmp = `${path}.${process.pid}.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
   // version 统一在唯一落盘通道打上：不管调用方传的池带没带版本，文件总是当前 schema。
   writeFileSync(tmp, JSON.stringify({ ...pool, version: 1 }, null, 2) + "\n", "utf-8");
   renameSync(tmp, path);
};

/**
 * 原子追加路由日志（环形 cap）；entries 为空时不动文件。
 * 读-改-写收进函数内（票 13）：调用方持有的快照可能已过期（多窗口并发记账），
 * 基于旧快照写回会整段覆盖别人的账；在这里重新 loadPool 把窗口缩到最小，
 * 调用方对并发无感。
 */
export const appendRoutingLog = (
   path: string,
   entries: RoutingLogEntry[],
): void => {
   if (entries.length === 0) return;
   if (!acquirePoolLock(path)) {
      // 拿不到锁（对方持锁异常久）：放弃本条账也比基于过期状态覆盖强——
      // 少一条可容忍，整段覆盖不可逆。
      return;
   }
   try {
      const fresh = loadPool({ path });
      savePool(path, {
         ...fresh.pool,
         routingLog: [...fresh.pool.routingLog, ...entries].slice(-ROUTING_LOG_CAP),
      });
   } finally {
      releasePoolLock(path);
   }
};
