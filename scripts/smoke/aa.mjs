/**
 * Pi-Staffs 冒烟 · AA 每日拉取与池快照写回（票 04/14）
 * 由 scripts/smoke.mjs 薄壳按原单体顺序调用；段落文本与 ok() 台账名逐字节沿用原文件。
 */
import {
   assert, throws, rejects, ok, load, makeAgents, installEnv, evaluatePrelude,
   readConfigFile, hookLists, hooks, commands, tools, notifications, ctx, runCommand,
   checks, repo, sandbox, configPath, fabricPath, S, sleeps,
   existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
   createServer, tmpdir, path, fileURLToPath, pathToFileURL,
} from "./_shared.mjs";

export const run = async () => {
// 7) AA 每日拉取与池快照写回（票 04）：成功写回 / 当日幂等 / 无 key / 网络失败。
const aa = await load("src/aa-refresh.ts");
const aaPoolPath = path.join(sandbox, "model-pool.json");
const aaNow = () => new Date("2026-09-22T10:00:00Z");
const writePoolFixture = (entries) =>
   writeFileSync(aaPoolPath, JSON.stringify({ entries, routingLog: [] }));
const stubKey = async () => ({ key: "aa-key", source: "env" });
// 桩形状对齐官方 /api/v2/language/models/free 响应（librarian 2026-09 核实）
const aaItem = (slug, ii, inP, outP, tps) => ({
   slug,
   evaluations: { artificial_analysis_intelligence_index: ii },
   pricing: { price_1m_input_tokens: inP, price_1m_output_tokens: outP },
   performance: { median_output_tokens_per_second: tps },
});
const okFetch = async (url) => {
   okFetch.pages = okFetch.pages ?? [];
   okFetch.pages.push(String(url));
   return {
      ok: true,
      json: async () => ({
         data: [aaItem("glm-5.3", 91, 5, 15, 40), aaItem("other-model", 70, 2, 8, 30)],
         pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false },
      }),
   };
};

// 成功写回：slug 匹配池 id 尾段；未收录条目原样保留
writePoolFixture([
   { id: "ollama-cloud/glm-5.3", platform: "cloud", thinkingLevels: ["low"], description: "x", manualTier: 4 },
   { id: "ollama/deepseek-v4-flash:0731", platform: "ollama", thinkingLevels: ["low"], description: "y", manualTier: 2 },
]);
const okResult = await aa.refreshPoolAa({
   fetchImpl: okFetch,
   resolveAaKeyImpl: stubKey,
   now: aaNow,
   poolPath: aaPoolPath,
   env: {},
});
const okPool = JSON.parse(readFileSync(aaPoolPath, "utf-8"));
assert(okResult.updated === 1, `应只更新收录的 1 条：${JSON.stringify(okResult)}`);
assert(
   okPool.entries[0].aa?.intelligenceIndex === 91 && okPool.entries[0].aa?.inPrice === 5,
   "快照列应写回",
);
assert(
   okPool.entries[0].aa?.refreshedAt === "2026-09-22T10:00:00.000Z",
   "refreshedAt 应为 ISO 时间戳",
);
// 票 14：主源先打详情页网页，回落才打免费端点（桩无 text() → 网页解析 null → 全走回落）
assert(
   okFetch.pages.some((u) => u.includes("/models/")),
   `主源应打详情页网页：${JSON.stringify(okFetch.pages)}`,
);
assert(
   okFetch.pages.some((u) => u.includes("language/models/free") && u.includes("page=1")),
   `回落应打免费端点带 page 参数：${JSON.stringify(okFetch.pages)}`,
);
assert(okPool.entries[1].aa === undefined, "未收录条目应原样保留");

// 当日幂等：已拉过今天直接返回，不再触网、不再读 key
const idemResult = await aa.refreshPoolAa({
   fetchImpl: async () => {
      throw new Error("不应触网");
   },
   resolveAaKeyImpl: async () => {
      throw new Error("不应读 key");
   },
   now: aaNow,
   poolPath: aaPoolPath,
   env: {},
});
assert(idemResult.updated === 0, `当日已拉应幂等返回：${JSON.stringify(idemResult)}`);

// 无 key：跳过 + 指引
writePoolFixture([{ id: "x/y", platform: "cloud", thinkingLevels: ["low"], description: "" }]);
const noKey = await aa.refreshPoolAa({
   fetchImpl: okFetch,
   resolveAaKeyImpl: async () => ({ key: null, source: "missing", guidance: "去注册" }),
   now: aaNow,
   poolPath: aaPoolPath,
   env: {},
});
assert(
   noKey.skipped === true && noKey.guidance === "去注册",
   `无 key 应带指引跳过：${JSON.stringify(noKey)}`,
);

// 网络失败：报 error 不崩、池未改动
const failResult = await aa.refreshPoolAa({
   fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
   },
   resolveAaKeyImpl: stubKey,
   now: aaNow,
   poolPath: aaPoolPath,
   env: {},
});
assert(
   typeof failResult.error === "string" && failResult.error.includes("ECONNREFUSED"),
   `网络失败应报 error：${JSON.stringify(failResult)}`,
);
assert(
   JSON.parse(readFileSync(aaPoolPath, "utf-8")).entries[0].aa === undefined,
   "失败时池不得被改动",
);
ok("AA 刷新：成功写回/当日幂等/无 key 降级/网络失败不崩（四路径）");

// 7b) 票 14 网页主源：真实 flight 片段 fixture → 快照写回（无 key 全命中不 skip）、
//     网页 404 回落 API 补齐（混合分源各写各的）。
const webFlightHtml = readFileSync(path.join("scripts", "fixtures", "aa-web-flight.html"), "utf-8");
const webFetch = async (url) => {
   const u = String(url);
   if (u.includes("/models/deepseek-v4-1-flash"))
      return { ok: true, text: async () => webFlightHtml };
   if (u.includes("language/models/free"))
      return {
         ok: true,
         json: async () => ({
            data: [aaItem("glm-5.3", 91, 5, 15, 40)],
            pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false },
         }),
      };
   return { ok: false, status: 404, text: async () => "" };
};
// 全命中：deepseek-v4.1-flash（点形态裸名）→ 归一 deepseek-v4-1-flash → 详情页 fixture。
// resolveAaKeyImpl 给 null key 而非抛错：全命中时不应走到，走到了会被 skipped 断言抓住。
writePoolFixture([
   { id: "ollama-cloud/deepseek-v4.1-flash", platform: "cloud", thinkingLevels: ["low"], description: "w", manualTier: 4 },
]);
const webOnly = await aa.refreshPoolAa({
   fetchImpl: webFetch,
   resolveAaKeyImpl: async () => ({ key: null, source: "missing", guidance: "不应走到" }),
   now: aaNow,
   poolPath: aaPoolPath,
   env: {},
});
const webPool = JSON.parse(readFileSync(aaPoolPath, "utf-8"));
assert(
   webOnly.updated === 1 && !("skipped" in webOnly),
   `网页主源应命中写回：${JSON.stringify(webOnly)}`,
);
assert(
   webPool.entries[0].aa?.intelligenceIndex === 39.456167472527 &&
      webPool.entries[0].aa?.inPrice === 0.3 &&
      webPool.entries[0].aa?.outPrice === 1.2 &&
      webPool.entries[0].aa?.throughput === 232.315512118877,
   `网页快照四字段应对齐 fixture 实测值：${JSON.stringify(webPool.entries[0].aa)}`,
);
assert(
   webPool.entries[0].aa?.refreshedAt === "2026-09-22T10:00:00.000Z",
   "网页快照也应打 refreshedAt",
);
ok("AA 网页主源：flight 解析写回、无 key 全命中不 skip（票 14）");

// 混合分源：网页命中的走网页字段，网页 404 的回落 API 字段，互不污染
writePoolFixture([
   { id: "ollama-cloud/deepseek-v4.1-flash", platform: "cloud", thinkingLevels: ["low"], description: "w", manualTier: 4 },
   { id: "ollama-cloud/glm-5.3", platform: "cloud", thinkingLevels: ["low"], description: "x", manualTier: 4 },
]);
const hybrid = await aa.refreshPoolAa({
   fetchImpl: webFetch,
   resolveAaKeyImpl: stubKey,
   now: aaNow,
   poolPath: aaPoolPath,
   env: {},
});
assert(hybrid.updated === 2, `混合应两条都写回：${JSON.stringify(hybrid)}`);
const hybridPool = JSON.parse(readFileSync(aaPoolPath, "utf-8"));
assert(
   hybridPool.entries[0].aa?.throughput === 232.315512118877 &&
      hybridPool.entries[0].aa?.inPrice === 0.3,
   "deepseek 条目应来自网页源（fixture 实测值）",
);
assert(
   hybridPool.entries[1].aa?.intelligenceIndex === 91 && hybridPool.entries[1].aa?.throughput === 40,
   "glm 条目应来自 API 回落（桩值）",
);
ok("AA 网页主源：404 条目回落 API、混合分源互不污染（票 14）");


   // 池门面段要拿 aa.refreshPoolAa 测坏 JSON 刷新路径。
   S.aa = aa;
};
