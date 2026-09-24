/**
 * Pi-Staffs 冒烟 · 宿主路由（票 03）/ jev 面板（票 05）/ 负缓存 + 加载器 + routing.js 出模（票 08/10/13）
 * 由 scripts/smoke.mjs 薄壳按原单体顺序调用；段落文本与 ok() 台账名逐字节沿用原文件。
 */
import {
   assert, throws, rejects, ok, load, makeAgents, installEnv, evaluatePrelude,
   readConfigFile, hookLists, hooks, commands, tools, notifications, ctx, runCommand,
   checks, repo, sandbox, configPath, fabricPath, S, sleeps,
   existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
   createServer, tmpdir, path, fileURLToPath, pathToFileURL,
} from "./_shared.mjs";

// runRoute 的产物，runRouteTail（负缓存/票08/票10）复用。
let routeMod;
let routeConfig;
let routePoolPath;

export const runRoute = async () => {
   const { good, buildStaffsPrelude } = S;
// ===== 票 03：宿主侧路由层（Jev × 模型池）=====
routeMod = await load("src/route.ts");
routeConfig = { roles: { fixer: { enabled: true }, explorer: { enabled: true } } };
routePoolPath = path.join(sandbox, "route-model-pool.json");
writeFileSync(
   routePoolPath,
   JSON.stringify({
      entries: [
         { id: "p/weak", platform: "cloud", thinkingLevels: ["low", "medium"], description: "弱模型", manualTier: 1 },
         { id: "p/strong", platform: "cloud", thinkingLevels: ["high", "max"], description: "强模型", manualTier: 5 },
      ],
   }),
);

// 1) pi-jev 缺席（入口指向不存在的文件）→ 空表，档位矩阵原样生效。
// 负缓存（票 13）是模块级状态，跨段会串：每段调用前统一重置。
routeMod.resetRouteCooldown();
const noJev = await routeMod.resolveRouteMap(routeConfig, {}, {
   deps: { env: { PI_JEV_ENTRY: path.join(sandbox, "no-such-jev-entry.ts") }, poolPath: routePoolPath, now: () => 0 },
});
assert(Object.keys(noJev).length === 0, "pi-jev 缺席时应返回空路由表");
ok("路由：pi-jev 缺席整体回落，不崩、不阻塞");

// 2) 桩 runner 全命中：难度 4 + coding + high → 应选 p/strong/high（p/weak 达标线不够）。
const stubRunner = async ({ questions }) => ({
   answers: Object.fromEntries(
      Object.keys(questions).map((id) => {
         const q = questions[id];
         if (q.type === "score") return [id, { score: 4, confidence: 0.9 }];
         if (q.type === "noul") return [id, { noul: 0.9, confidence: 0.9 }];
         return [id, { choice: "high", confidence: 0.9 }];
      }),
   ),
});
const captured = [];
routeMod.resetRouteCooldown();
const routedMap = await routeMod.resolveRouteMap(routeConfig, {}, {
   deps: { runner: stubRunner, poolPath: routePoolPath, now: () => 0, writeLog: (entries) => captured.push(...entries) },
});
assert(routedMap.fixer?.model === "p/strong", "难度4+coding 应命中 p/strong");
assert(routedMap.fixer?.thinking === "high", "choice=high 应覆盖 thinking");
assert(routedMap.explorer?.model === "p/strong", "同画像角色共用同一次路由结果");
ok("路由：三问画像 → 池匹配 (model, thinking) 覆盖档位");

// 3) Jev 低置信 → 该角色回落（不进路由表），日志如实记 fallback。
const lowConfRunner = async ({ questions }) => ({
   answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { score: 4, _lowConfidence: true }])),
});
const fallbackLog = [];
routeMod.resetRouteCooldown();
const lowConf = await routeMod.resolveRouteMap(routeConfig, {}, {
   deps: { runner: lowConfRunner, poolPath: routePoolPath, now: () => 0, writeLog: (entries) => fallbackLog.push(...entries) },
});
assert(Object.keys(lowConf).length === 0, "低置信判答应整体回落");
assert(
   fallbackLog.length === 2 && fallbackLog.every((e) => e.fallback === true && /低置信/.test(e.profile)),
   "低置信应逐角色记 fallback 日志",
);
ok("路由：Jev 低置信逐角色回落并留证");

// 3b) 判答整体失败（error/throw）也要逐角色留账，理由可读（票12）。
const failLog = [];
routeMod.resetRouteCooldown();
const failRoute = await routeMod.resolveRouteMap(routeConfig, {}, {
   deps: { runner: async () => ({ error: "jev-down" }), poolPath: routePoolPath, now: () => 0, writeLog: (entries) => failLog.push(...entries) },
});
assert(Object.keys(failRoute).length === 0, "判答失败应整体回落");
assert(
   failLog.length === 2 && failLog.every((e) => e.fallback === true && /判答失败（jev-down）/.test(e.profile)),
   "error 应逐角色记账且带 reason code",
);
const throwLog = [];
routeMod.resetRouteCooldown();
const throwRoute = await routeMod.resolveRouteMap(routeConfig, {}, {
   deps: { runner: async () => { throw new Error("boom"); }, poolPath: routePoolPath, now: () => 0, writeLog: (entries) => throwLog.push(...entries) },
});
assert(Object.keys(throwRoute).length === 0, "runner throw 应整体回落");
assert(
   throwLog.length === 2 && throwLog.every((e) => e.fallback === true && /判答失败（throw:boom）/.test(e.profile)),
   "throw 应逐角色记账且带 message",
);
ok("路由：判答失败/throw 逐角色留账，理由可读");

// 4) 路由日志字段完整 + 环形截断上限常量存在。
assert(
   captured.every((e) => typeof e.at === "string" && typeof e.role === "string" && typeof e.selected === "string"),
   "路由日志必须含 at/role/selected",
);
assert(captured.some((e) => e.selected === "p/strong high"), "命中日志应记录最终选型");
assert(routeMod.ROUTE_LOG_CAP === undefined || routeMod.ROUTING_LOG_CAP > 0, "环形上限常量应导出");
ok("路由：日志可截获审计，字段完整");

// 5) Jev 卡死 → 硬超时回落（PI_STAFFS_ROUTE_TIMEOUT 压到 50ms）。
const t0 = Date.now();
routeMod.resetRouteCooldown();
const hung = await routeMod.resolveRouteMap(routeConfig, {}, {
   deps: { runner: () => new Promise(() => {}), env: { PI_STAFFS_ROUTE_TIMEOUT: "50" }, poolPath: routePoolPath, now: () => 0 },
});
assert(Object.keys(hung).length === 0, "Jev 卡死应超时回落为空表");
assert(Date.now() - t0 < 5000, "超时必须真的生效（50ms 档）");
ok("路由：Jev 卡死按 PI_STAFFS_ROUTE_TIMEOUT 硬超时回落");


// 6) guest 注入行为 + 逃生门（票 03 第 2/3 条）：路由覆盖 (model, thinking)；route:false 回矩阵。
const preludeRouted = buildStaffsPrelude({
   config: good.config,
   aliases: { "alias-fixer": "q/heavy-fixer" },
   routes: { fixer: { model: "p/routed", thinking: "high" } },
});
const routedAgents = makeAgents([]);
installEnv(routedAgents);
const routedStaffs = evaluatePrelude(preludeRouted);
const routedReceipt = await routedStaffs.run({ role: "fixer", task: "路由命中" });
assert(routedAgents.calls[0].model === "p/routed", `路由应覆盖矩阵模型：${routedAgents.calls[0].model}`);
assert(routedAgents.calls[0].thinking === "high", "路由 thinking 应覆盖矩阵");
assert(routedReceipt.route?.model === "p/routed" && routedReceipt.route?.thinking === "high", "回执应带 route 决策（null=回落）");

const matrixAgents = makeAgents([]);
installEnv(matrixAgents);
const escapeStaffs = evaluatePrelude(preludeRouted);
const escapeReceipt = await escapeStaffs.run({ role: "fixer", task: "逃生门", route: false });
assert(matrixAgents.calls[0].model === "q/heavy-fixer", `route:false 应回档位矩阵：${matrixAgents.calls[0].model}`);
assert(matrixAgents.calls[0].thinking === "max", "route:false 应回矩阵 thinking");
assert(escapeReceipt.route === null, "逃生门回执 route 应为 null");
ok("路由：guest 注入覆盖 (model, thinking)，route:false 逃生门回矩阵，回执带 route 决策");

};

export const runJevPanel = async () => {
// ---------- 8. /staffs jev：路由日志面板（票 05） ----------
const jevMod = await load("src/jev-panel.ts");
const demoLog = [
   { at: "2026-01-02T03:04:05.000Z", role: "fixer", profile: "难度3/coding/high", selected: "ollama-cloud/glm-5.3 high", fallback: false },
   { at: "2026-01-02T03:05:05.000Z", role: "oracle", profile: "Jev 低置信/无效判答", selected: "(回落 preset)", fallback: true },
];
const logLines = jevMod.formatRoutingLogSection(demoLog);
assert(logLines.length === 2, "路由日志段应逐条渲染");
assert(
   logLines[0].includes("✓ 命中") && logLines[0].includes("2026-01-02 03:04:05"),
   "命中行应带 ✓ 标记与时间",
);
assert(
   logLines[0].includes("fixer") && logLines[0].includes("难度3/coding/high"),
   "命中行应带角色与三问摘要",
);
assert(logLines[0].includes("ollama-cloud/glm-5.3 high"), "命中行应带选定模型");
assert(logLines[1].includes("⚠ 回落"), "回落应有可视区分");
assert(jevMod.formatRoutingLogSection([])[0] === "暂无路由记录", "空日志应显示暂无路由记录");
assert(jevMod.formatRoutingLogSection(undefined)[0] === "暂无路由记录", "缺段应显示暂无路由记录");
assert(
   jevMod.formatRoutingLogSection([
      null,
      { role: "x", profile: 1 },
      { role: "", at: 5 },
      { role: "y", fallback: "yes" },
   ]).length === 2,
   "损坏条目只丢弃缺 role 的，坏 fallback 按非回落处理",
);
assert(
   jevMod.formatRoutingLogSection([{ role: "x", profile: 1 }])[0].includes("（无摘要）"),
   "坏字段用兜底文案，面板不崩",
);
const many = Array.from({ length: 25 }, (_, i) => ({
   at: `2026-01-02T00:00:0${i % 10}.000Z`,
   role: `r${i}`,
   profile: "p",
   selected: "s",
   fallback: false,
}));
assert(
   jevMod.formatRoutingLogSection(many).length === jevMod.JEVPANEL_LIMIT,
   "面板只摊最近判断（上限截断）",
);
ok("jev-panel：渲染路由日志段（时间/角色/三问摘要/选定模型/fallback 区分/空态/坏条目/上限）");

// 命令层：/staffs jev 读共享池文件渲染；池缺 → 该段暂无路由记录，面板其余部分不受影响。
const jevPoolPath = path.join(sandbox, "jev-panel-pool.json");
writeFileSync(
   jevPoolPath,
   JSON.stringify(
      { entries: [{ id: "ollama/x", platform: "ollama", thinkingLevels: ["low"], description: "d" }], routingLog: demoLog },
      null,
      2,
   ),
);
process.env.PI_STAFFS_POOL = jevPoolPath;
const jevText = await runCommand("jev");
assert(jevText.includes("【路由日志】最近判断"), "面板应带路由日志段");
assert(jevText.includes("⚠ 回落") && jevText.includes("✓ 命中"), "命令输出应保留 fallback 区分");
assert(jevText.includes("池条目 1 ｜ 路由记录 2 条"), "面板摘要（其余部分）应照常渲染");
process.env.PI_STAFFS_POOL = path.join(sandbox, "no-such-jev-pool.json");
const jevEmptyText = await runCommand("jev");
assert(jevEmptyText.includes("暂无路由记录"), "池缺时该段应显示暂无路由记录");
assert(jevEmptyText.includes("池条目 0"), "池缺时面板其余部分不受影响");
assert(jevEmptyText.includes("no-such-jev-pool.json"), "面板应标出实际读取的池路径");
delete process.env.PI_STAFFS_POOL;
ok("/staffs jev：命令层读池文件渲染路由日志；池缺优雅降级不崩");

};

export const runRouteTail = async () => {

// 7b) 路由负缓存（票 13）：判答失败进入冷却，冷却内直接回落不再发起判答；
//     env 可覆盖 TTL；resetRouteCooldown 重置。用真实 Date.now，两次调用间隔必然远小于 TTL。
{
   let calls = 0;
   const failRunner = async () => {
      calls += 1;
      throw new Error("cd");
   };
   const mkDeps = (env) => ({ runner: failRunner, poolPath: routePoolPath, env, writeLog: () => {} });
   await routeMod.resolveRouteMap(routeConfig, {}, { deps: mkDeps({ PI_STAFFS_ROUTE_COOLDOWN_MS: "5000" }) });
   await routeMod.resolveRouteMap(routeConfig, {}, { deps: mkDeps({ PI_STAFFS_ROUTE_COOLDOWN_MS: "5000" }) });
   assert(calls === 1, `冷却内第二次调用不应重复判答（实际 ${calls} 次）`);
   await routeMod.resolveRouteMap(routeConfig, {}, { deps: mkDeps(undefined) });
   assert(calls === 1, "env 冷却只对该 env 生效，默认路径不应被波及");
   routeMod.resetRouteCooldown();
   await routeMod.resolveRouteMap(routeConfig, {}, { deps: mkDeps({ PI_STAFFS_ROUTE_COOLDOWN_MS: "5000" }) });
   assert(calls === 2, "reset 后应重新发起判答");
   ok("路由负缓存：失败进冷却/冷却内早退/env 可覆盖/reset 清除");
}


// 8) 加载器合一（票 08）：fixture 命中返回模块、形状不满足跳过候选回 null。
const jevFixture = path.join(sandbox, "jev-fixture.mjs");
writeFileSync(
   jevFixture,
   "export const resolveAaKey = async () => ({ key: null });\n" +
   "export const notFn = 1;\n",
   "utf-8",
);
const hit = await routeMod.loadJevModule({ PI_JEV_ENTRY: jevFixture }, ["resolveAaKey"]);
assert(hit && typeof hit.resolveAaKey === "function", "loadJevModule 形状命中应返回模块");
const shapeMiss = await routeMod.loadJevModule(
   { PI_JEV_ENTRY: jevFixture },
   ["resolveAaKey", "notFn"],
);
assert(shapeMiss === null, "loadJevModule 形状不满足（非 function 字段）应跳过并回 null");
ok("票08：pi-jev 动态加载器合一，形状断言/缺席回 null");


// 9) 路由内核出模（票 10）：routing.js 可独立 import（语法错误早炸），
//    注入桩执行 __staffsResolveRole，路由/逃生门/未知角色语义不回归。
await import(pathToFileURL(path.join(repo, "src", "guest", "routing.js")).href);
const routingSrc = readFileSync(path.join(repo, "src", "guest", "routing.js"), "utf8");
const makeResolve = () =>
   new Function(
      "deps",
      routingSrc + "\nreturn __staffsMakeResolver(deps);",
   )(
      {
            roles: { fixer: { instructions: "I", thinking: "high", tools: ["pi_bash"] } },
            permissions: {},
            routes: { fixer: { model: "m/routed", thinking: "low" } },
            dispatch: { primaryRole: "fixer" },
            combine: (i, t) => (i ?? "") + "::" + t,
      },
   );
const routedHit = makeResolve()({ task: "T" });
assert(
   routedHit.routed?.model === "m/routed" && routedHit.request.thinking === "low",
   "出模后路由命中仍覆盖 (model, thinking)",
);
const escape = makeResolve()({ task: "T", route: false });
assert(
   escape.routed === undefined && escape.request.thinking === "high",
   "出模后 route:false 逃生门仍回档位矩阵",
);
let threw = false;
try { makeResolve()({ role: "nope", task: "T" }); } catch { threw = true; }
assert(threw, "出模后未知角色仍抛错");
ok("票10：路由内核出模 routing.js，独立加载+注入执行语义不回归");

};
