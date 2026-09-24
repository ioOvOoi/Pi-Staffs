/**
 * Pi-Staffs 冒烟 · 模型池：确定性匹配器（票 01）+ 池门面（票 07）
 * 由 scripts/smoke.mjs 薄壳按原单体顺序调用；段落文本与 ok() 台账名逐字节沿用原文件。
 */
import {
   assert, throws, rejects, ok, load, makeAgents, installEnv, evaluatePrelude,
   readConfigFile, hookLists, hooks, commands, tools, notifications, ctx, runCommand,
   checks, repo, sandbox, configPath, fabricPath, S, sleeps,
   existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
   createServer, tmpdir, path, fileURLToPath, pathToFileURL,
} from "./_shared.mjs";

// runPoolMatcher 的产物，runPoolFacade 复用（同原文件的单作用域语义）。
let poolMod;
let localPool;

export const runPoolMatcher = async () => {
// ---------- 27. 模型池 schema 与确定性匹配器（票 01）：纯函数，三问+池 → {model,thinking}|null ----------
poolMod = await load("src/pool.ts");
// AA 列完整路径：编码看 sweBench、通用看 intelligenceIndex，难度定最低分区间，区间内性价比最优。
const aaPool = poolMod.normalizePool({
   entries: [
      {
         id: "p/strong",
         platform: "cloud",
         thinkingLevels: ["low", "medium", "high", "max"],
         description: "旗舰",
         aa: { intelligenceIndex: 95, inPrice: 5, outPrice: 15, throughput: 40, refreshedAt: "2026-01-01" },
         sweBench: 90,
      },
      {
         id: "p/cheap-good",
         platform: "cloud",
         thinkingLevels: ["low", "medium", "high", "max"],
         description: "经济",
         aa: { intelligenceIndex: 85, inPrice: 1, outPrice: 3, throughput: 80, refreshedAt: "2026-01-01" },
         sweBench: 80,
      },
      {
         id: "p/weak-cheap",
         platform: "cloud",
         thinkingLevels: ["low"],
         description: "弱",
         aa: { intelligenceIndex: 40, inPrice: 0.1, outPrice: 0.3, throughput: 200, refreshedAt: "2026-01-01" },
         sweBench: 30,
      },
   ],
}).pool;
let routed = poolMod.matchPool({ difficulty: 5, domain: "coding", thinking: "max" }, aaPool);
assert(
   routed && routed.model === "p/cheap-good" && routed.thinking === "max",
   `难度 5 编码应在 sweBench≥80 区间内选性价比最优：${JSON.stringify(routed)}`,
);
routed = poolMod.matchPool({ difficulty: 1, domain: "general", thinking: "low" }, aaPool);
assert(
   routed && routed.model === "p/weak-cheap",
   `通用领域看 intelligenceIndex，轻任务应选最便宜的弱模型：${JSON.stringify(routed)}`,
);
routed = poolMod.matchPool({ difficulty: 2, domain: "coding", thinking: "high" }, aaPool);
assert(
   routed && routed.model === "p/cheap-good",
   `所需思考须落在 thinkingLevels 内（weak-cheap 只支持 low，应被排除）：${JSON.stringify(routed)}`,
);
routed = poolMod.matchPool({ difficulty: 4, thinking: "max" }, aaPool);
assert(
   routed && routed.model === "p/cheap-good",
   `缺省领域应按通用（intelligenceIndex）处理：${JSON.stringify(routed)}`,
);
assert(
   poolMod.matchPool({ difficulty: 2, thinking: 42 }, aaPool)?.thinking === "medium",
   "所需思考非法或缺省应取中性档 medium",
);
ok("匹配器：AA 列按领域选参考列 + 难度区间 + thinking 求交 + 性价比排序");

// AA 缺列路径：本地 ollama 无榜单，靠 manualTier + description 兜底。
localPool = poolMod.normalizePool({
   entries: [
      { id: "ollama/local-t2", platform: "ollama", thinkingLevels: ["low", "medium"], description: "本地轻量", manualTier: 2 },
      { id: "ollama/local-t4", platform: "ollama", thinkingLevels: ["low", "medium", "high"], description: "本地强", manualTier: 4 },
   ],
}).pool;
routed = poolMod.matchPool({ difficulty: 4, domain: "coding", thinking: "high" }, localPool);
assert(
   routed && routed.model === "ollama/local-t4" && routed.thinking === "high",
   `AA 缺列应回落到 manualTier（t4 能力 80 达标，t2 能力 40 不达标）：${JSON.stringify(routed)}`,
);
const t2Only = poolMod.normalizePool({ entries: [localPool.entries[0]] }).pool;
assert(
   poolMod.matchPool({ difficulty: 4, domain: "coding", thinking: "high" }, t2Only) === null,
   "池内全部能力低于难度区间应返回 null（触发回落）",
);
const mixedPool = poolMod.normalizePool({
   entries: [...aaPool.entries, localPool.entries[0]],
}).pool;
routed = poolMod.matchPool({ difficulty: 1, domain: "general", thinking: "low" }, mixedPool);
assert(
   routed && routed.model === "ollama/local-t2",
   `本地零成本与云端同池竞争，轻任务应收敛到本地：${JSON.stringify(routed)}`,
);
ok("匹配器：AA 缺列 manualTier 兜底，零成本本地赢下轻任务");

// 池空 / 全缺列 / 非法输入三路径 → null（票 03 拿它转回落）。
assert(poolMod.matchPool({ difficulty: 1, thinking: "low" }, { entries: [] }) === null, "池空应返回 null");
assert(poolMod.matchPool({ difficulty: 1, thinking: "low" }, {}) === null, "无 entries 段应返回 null");
assert(poolMod.matchPool({ difficulty: 1, thinking: "low" }, null) === null, "池为 null 应返回 null");
assert(
   poolMod.matchPool(
      { difficulty: 1, thinking: "low" },
      { entries: [{ id: "x", platform: "ollama", thinkingLevels: ["low"], description: "缺列也缺档" }] },
   ) === null,
   "全部条目缺 AA 列且缺 manualTier 应返回 null",
);
ok("匹配器：池空 / 全缺列 / 非法输入一律 null（回落信号）");

// 归一化：坏条目只丢自己，routingLog 段与开放形状原样保留。
const dirty = poolMod.normalizePool({
   entries: [{ id: "", platform: "cloud", thinkingLevels: ["low"] }],
   routingLog: "bad",
   custom: "keep",
});
assert(dirty.pool.entries.length === 0, "无 id 条目应剔除（无法派发）");
assert(dirty.issues.some((issue) => /id/.test(issue)), "剔除应如实报问题");
assert(Array.isArray(dirty.pool.routingLog) && dirty.pool.routingLog.length === 0, "routingLog 非数组应归一为空");
assert(dirty.pool.custom === "keep", "开放形状（额外字段）必须原样保留");
ok("归一化：坏条目剔除留证，routingLog 段预留，开放形状不丢");

// 加载：默认路径缺失/坏 JSON 都回空池 + 模板提示，不崩、不覆盖用户文件。
const poolPath = path.join(sandbox, "model-pool.json");
const missingPool = poolMod.loadPool({ path: poolPath });
assert(missingPool.pool.entries.length === 0, "缺池文件时应回空池");
assert(
   /模板/.test(missingPool.issues[0]) && /不存在/.test(missingPool.issues[0]),
   "缺池文件应给出生成模板的提示，而不是抛错",
);
writeFileSync(poolPath, "{ not json");
const brokenPool = poolMod.loadPool({ path: poolPath });
assert(brokenPool.pool.entries.length === 0, "坏 JSON 时应回空池");
assert(/非法 JSON/.test(brokenPool.issues[0]), "坏 JSON 应说明原因");
assert(readFileSync(poolPath, "utf8") === "{ not json", "坏池文件绝不覆盖用户文件");
writeFileSync(
   poolPath,
   JSON.stringify({
      entries: localPool.entries,
      routingLog: [{ at: "t", role: "fixer", profile: "3/coding/high", selected: "ollama/local-t4 high", fallback: false }],
   }),
);
const loadedPool = poolMod.loadPool({ path: poolPath });
assert(loadedPool.pool.entries.length === 2, "合法池文件应读回条目");
assert(loadedPool.pool.routingLog.length === 1, "routingLog 段应随池文件读回（票 03 写它）");
ok("池加载：缺失/坏 JSON 回空池 + 模板提示；合法文件连同 routingLog 段读回");


};

export const runPoolFacade = async () => {
   const { aa } = S;
// 7) 池门面（票 07）：savePool 原子写无残留、appendRoutingLog 空段不动文件 + cap 截断、
//    坏 JSON 走 loadPool 回空池后刷新静默 skip（原先裸 parse 直接炸）。
const facadePath = path.join(sandbox, "facade-pool.json");
const facadePool = poolMod.normalizePool({ entries: [localPool.entries[0]] }).pool;
poolMod.savePool(facadePath, facadePool);
assert(
   JSON.parse(readFileSync(facadePath, "utf-8")).entries.length === 1 &&
      JSON.parse(readFileSync(facadePath, "utf-8")).version === 1,
   "savePool 落盘内容正确且打上 version:1",
);
poolMod.appendRoutingLog(facadePath, []);
assert(
   !JSON.parse(readFileSync(facadePath, "utf-8")).routingLog?.length,
   "appendRoutingLog 空 entries 不应改动文件",
);
const filler = Array.from({ length: 55 }, (_, i) => ({
   at: new Date(i).toISOString(), role: "fixer", profile: `p${i}`,
   selected: "m/x", fallback: false,
}));
poolMod.appendRoutingLog(facadePath, filler);
const capped = JSON.parse(readFileSync(facadePath, "utf-8")).routingLog;
assert(capped.length === poolMod.ROUTING_LOG_CAP && capped[0].profile === "p5", "appendRoutingLog 应环形截断到上限");
writeFileSync(path.join(sandbox, "broken-pool.json"), "{oops", "utf-8");
// refreshPoolAa 的参数本身就是 deps 对象（平铺），再包一层 deps 会被整包忽略，
// poolPath 落到真池、env 落到 process.env——用例就变成依赖宿主真实状态的碰运器。
const brokenSkip = await aa.refreshPoolAa({
   poolPath: path.join(sandbox, "broken-pool.json"),
   // stub key=null：走 credential.key 缺失分支（skipped），同时隔绝凭据库真 key 与真实网络
   resolveAaKeyImpl: async () => ({ key: null, source: "missing", guidance: "AA key 未设置" }),
   env: {},
});
assert(
   brokenSkip.skipped === true && /不可加载|key|坏 JSON/.test(brokenSkip.reason ?? ""),
   `坏 JSON 池文件不应炸掉刷新（回空池走 skip）：${JSON.stringify(brokenSkip).slice(0, 120)}`,
);
assert(
   !readdirSync(sandbox).some((f) => f.endsWith(".tmp") || f.endsWith(".lock")),
   "落盘完成后不应残留 tmp/lock 文件",
);
ok("池门面：savePool 原子无残留+version / appendRoutingLog 空段跳过+cap 截断 / 坏 JSON 刷新不炸");

// 候选 1 门面收口守卫：默认池路径只允许 src/pool.ts 一处构造（含 trim 覆盖语义），
// 其余模块必须 import defaultPoolFilePath——重复实现会让 PI_STAFFS_POOL 覆盖在
// aa-refresh / 面板 / 路由之间出现分歧（已实际发生过 trim 分歧）。
const dupPathHits = [];
const walkSrc = (dir) => {
   for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walkSrc(p);
      else if (/\.(ts|js)$/.test(f.name)) {
         const t = readFileSync(p, "utf8");
         if (t.includes('"agent", "model-pool.json"') && !p.endsWith("pool.ts"))
            dupPathHits.push(path.relative(repo, p));
      }
   }
};
walkSrc(path.join(repo, "src"));
assert(dupPathHits.length === 0, `默认池路径只许 pool.ts 构造，违规文件：${dupPathHits}`);
ok("池路径门面收口：src 内无第二处默认池路径构造（候选 1）");
};
