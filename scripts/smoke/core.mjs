/**
 * Pi-Staffs 冒烟 · host 装载 / 配置 / guest 内核 / 预检
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
// ---------- 1. 装载契约 ----------
const mod = await load("src/index.ts");mod.default({
   on: (name, handler) =>
      hookLists.set(name, [...(hookLists.get(name) ?? []), handler]),
   registerTool: (tool) => tools.set(tool.name, tool),
   registerCommand: (name, options) => commands.set(name, options),
});
assert(typeof mod.default === "function", "默认导出应该是扩展入口函数");
assert(hooks.has("session_start"), "应注册 session_start");
assert(hooks.has("tool_call"), "应注册 tool_call");
assert(hooks.has("before_agent_start"), "应注册 before_agent_start");
assert(commands.has("staffs"), "应注册 /staffs 命令");
ok("装载：注册了 /staffs + 三个事件钩子");

// ---------- 2. session_start 生成默认配置 ----------
await hooks.get("session_start")({}, ctx);
assert(existsSync(configPath), "session_start 应生成配置文件");
const created = readConfigFile();
assert(
   created.preset === "baseline",
   `默认档位应为 baseline：${created.preset}`,
);
const roleNames = Object.keys(created.roles);
assert(roleNames.length === 7, `默认应有 7 个角色：${roleNames.join(",")}`);
for (const name of roleNames) {
   assert(
      created.presets?.baseline?.[name]?.model === created.roles[name].model,
      `baseline 档位应覆盖角色 ${name}，且与基线同模型`,
   );
   assert(
      created.roles[name].fallbacks === undefined,
      `角色 ${name} 不该再有 fallbacks（D24）`,
   );
}
ok("session_start：生成七神祇配置 + baseline 档位（无 fallbacks）");

// ---------- 3. tool_call 只给 fabric_exec 挂 prelude ----------
const fabricEvent = {
   toolName: "fabric_exec",
   input: { code: "const x = 1;" },
};
await hooks.get("tool_call")(fabricEvent);
assert(
   fabricEvent.input.prelude.includes("const __staffsModels"),
   "prelude 应带角色→模型表",
);
assert(
   fabricEvent.input.prelude.includes("const __staffsPreset"),
   "prelude 应带档位信息",
);
assert(
   fabricEvent.input.code === "const x = 1;",
   "模型代码不该被改动（prelude 走入参）",
);
assert(
   !fabricEvent.input.prelude.includes("__staffsLoadHealth"),
   "健康表已删除（D24）",
);
const bashEvent = { toolName: "bash", input: { command: "ls" } };
await hooks.get("tool_call")(bashEvent);
assert(bashEvent.input.command === "ls", "非 fabric_exec 不该被动过");
const weirdEvent = { toolName: "fabric_exec", input: { code: 42 } };
await hooks.get("tool_call")(weirdEvent);
assert(weirdEvent.input.code === 42, "code 不是字符串时不该注入");
assert(weirdEvent.input.prelude === undefined, "code 不是字符串时不挂 prelude");
ok("tool_call：只给 fabric_exec 挂 prelude（模型代码不动）");

// ---------- 4. before_agent_start ----------
const guidancePatch = await hooks.get("before_agent_start")({
   systemPrompt: "S",
});
assert(
   guidancePatch.systemPrompt.includes("Pi-Staffs 编排"),
   "应把派发指引写进 system prompt",
);
process.env.PI_FABRIC_PARENT_RUN = "1";
assert(
   (await hooks.get("before_agent_start")({ systemPrompt: "S" })) === undefined,
   "子 agent 会话不该再注入指引",
);
delete process.env.PI_FABRIC_PARENT_RUN;
assert(
   process.env.PI_FABRIC_PARENT_RUN === undefined,
   "PI_FABRIC_PARENT_RUN 必须还原，否则后续断言都跑在子会话语境里",
);
ok("before_agent_start：只给顶层会话注入派发指引");

// ---------- 5. 配置模块：解析 / 校验 / 读写 ----------
const config = await load("src/config.ts");
const aliases = { short: "p/aliased-a" };
assert(
   config.resolveModelRef("short", aliases).ref === "p/aliased-a",
   "别名应解析",
);
assert(config.resolveModelRef("p/a", aliases).provider === "p", "直引应解析");
assert(config.resolveModelRef("a", {}) === undefined, "未定义别名应解析失败");
assert(config.resolveModelRef(3, aliases) === undefined, "非字符串应解析失败");
assert(
   config.resolveModelRef("p/", aliases) === undefined,
   "缺模型 id 应解析失败",
);
ok("resolveModelRef：别名 / 直引 / 非法引用");

const rawInvalid = {
   preset: "nope",
   presets: { nope2: {} },
   roles: {
      BadName: {
         model: "p/a",
         thinking: "low",
         tools: ["read"],
         mode: "subagent",
      },
      ok: {
         model: "ghost",
         thinking: "nope",
         tools: "read",
         mode: "nope",
         enabled: "yes",
         customField: "保留我",
      },
   },
};
const invalid = config.validateConfig(rawInvalid, aliases);
const mentions = (needle) =>
   invalid.issues.some((issue) => issue.includes(needle));
assert(mentions("BadName"), "非法角色名应报问题");
assert(mentions("thinking 非法"), "thinking 非法应报问题");
assert(mentions("tools 必须是字符串数组"), "tools 非数组应报问题");
assert(mentions("mode 非法"), "mode 非法应报问题");
assert(mentions("enabled 必须是布尔"), "enabled 非布尔应报问题");
assert(mentions("model 无法解析"), "model 不可解析应报问题");
assert(mentions("preset 指向不存在的档位"), "preset 指向空档位应报问题");
assert(
   invalid.config.roles.ok.customField === "保留我",
   "开放形状必须原样保留（一次 save 不能吃掉别人的字段）",
);
ok("validateConfig：逐字段报问题且保留开放形状");

const rawGood = {
   configVersion: 1,
   preset: "heavy",
   presets: {
      baseline: {},
      heavy: {
         fixer: { model: "alias-fixer", thinking: "max" },
         ghost: { model: "p/ghost" },
      },
   },
   dispatch: {
      primaryRole: "orchestrator",
      defaultImplementationRole: "fixer",
      attemptsPerModel: 2,
      backoffBaseMs: 1500,
      backoffCapMs: 30000,
   },
   roles: {
      orchestrator: {
         model: "p/a",
         thinking: "low",
         mode: "primary",
         tools: ["*"],
         enabled: true,
         purpose: "队长",
      },
      fixer: {
         model: "p/alias-target",
         thinking: "low",
         mode: "subagent",
         tools: ["read", "edit"],
         enabled: true,
         instructions: "自定义：只改这一处",
      },
      trio: {
         model: "p/zzz",
         thinking: "low",
         mode: "subagent",
         tools: ["read"],
      },
      alien: {
         model: "zz/none",
         thinking: "low",
         mode: "subagent",
         tools: ["read"],
      },
   },
};
const good = config.validateConfig(rawGood, { "alias-fixer": "q/heavy-fixer" });
assert(
   good.issues.some((issue) => issue.includes("引用了不存在的角色：ghost")),
   "档位引用未知角色应报问题",
);
assert(good.config.preset === "heavy", "preset 名应保留");
assert(
   good.config.presets.heavy.ghost !== undefined,
   "报问题的档位条目也要保留（不丢用户数据）",
);
assert(
   config.activePresetName(good.config) === "heavy",
   "activePresetName 应返回当前档位",
);
assert(
   config.resolveRole(good.config, "fixer").model === "alias-fixer",
   "档位应覆盖角色模型",
);
assert(
   config.resolveRole(good.config, "fixer").thinking === "max",
   "档位应覆盖思考档",
);
assert(
   config.resolveRole(good.config, "fixer").tools.join(",") === "read,edit",
   "档位不该改角色行为（tools 仍来自角色）",
);
assert(
   config.resolveRole(good.config, "trio").model === "p/zzz",
   "档位没写的角色应继续用基线模型",
);
assert(
   config.activePresetName({ ...good.config, preset: "missing" }) === "",
   "档位不存在时应视为无档位",
);
ok("档位解析：preset 覆盖 model/thinking，未覆盖的角色与行为不变");

writeFileSync(configPath, JSON.stringify(good.config, null, 2));
const reloaded = config.loadStaffsConfig();
assert(reloaded.created === false, "已存在的配置不该被当成新建");
assert(
   reloaded.config.roles.fixer.instructions === "自定义：只改这一处",
   "往返应保留 instructions",
);
assert(
   reloaded.config.roles.fixer.model === "p/alias-target",
   "往返应保留原始 model 引用（存别名而不是解析结果）",
);
writeFileSync(configPath, "{ not json");
const broken = config.loadStaffsConfig();
assert(broken.issues.length > 0, "坏 JSON 应报问题");
assert(
   readFileSync(configPath, "utf8") === "{ not json",
   "坏 JSON 时绝不覆盖用户文件",
);
assert(
   Object.keys(broken.config.roles).length === 7,
   "坏 JSON 时兜底用内置七神祇",
);
ok("load/save：往返保留字段，坏 JSON 不覆盖原文件");
writeFileSync(configPath, JSON.stringify(good.config, null, 2));
const listText = await runCommand("");
assert(listText.includes("档位：heavy"), "/staffs 应显示当前档位");
assert(
   listText.includes("baseline") && listText.includes("heavy"),
   "/staffs 应列出可用档位",
);
assert(listText.includes("fixer"), "/staffs 应列出角色");
const presetHelp = await runCommand("preset");
assert(presetHelp.includes("切换：/staffs preset"), "/staffs preset 应给用法");
const switched = await runCommand("preset baseline");
assert(switched.includes("已切到档位 baseline"), "切换应成功并通知");
assert(readConfigFile().preset === "baseline", "切换应写回配置文件");
const rejected = await runCommand("preset nope");
assert(rejected.includes("没有档位 nope"), "不存在的档位应被拒绝");
assert(readConfigFile().preset === "baseline", "拒绝时不该改配置");
ok("/staffs：列出角色与档位、切档位写盘、拒绝不存在的档位");

// ---------- 5b. applyPresetChange：纯函数切档位（冒烟直接测逻辑、不碰 TUI） ----------
const rolesPanelMod = await load("src/roles-panel.ts");
const presetOk = rolesPanelMod.applyPresetChange(good.config, "baseline");
assert("config" in presetOk, "切到存在的档位应返回成功");
assert(
   presetOk.config.preset === "baseline",
   "成功结果应把 preset 字段改成目标档位",
);
assert(
   presetOk.config.presets === good.config.presets,
   "切档位只改指针，不该复制或改动任意档位条目",
);
const presetMissing = rolesPanelMod.applyPresetChange(good.config, "nope");
assert(
   "error" in presetMissing && presetMissing.error.includes("没有档位"),
   "不存在的档位应拒绝并说明原因",
);
const emptyPresets = rolesPanelMod.applyPresetChange(
   { ...good.config, presets: {} },
   "baseline",
);
assert("error" in emptyPresets, "presets 为空的配置应拒绝切换");
ok("applyPresetChange：切档位写 preset 字段、拒不存在档位与空档位表");

// ---------- 5c. /staffs 参数补全：子命令 → 二级参数（纯函数，不碰 TUI） ----------
const { buildStaffsArgumentCompletions } = await load('src/index.ts');
const presetNames = Object.keys(good.config.presets);
const allCmds = buildStaffsArgumentCompletions('', presetNames);
assert(allCmds.length === 7 && allCmds.every((item) => item.value), '空输入应给出全部子命令');
assert(allCmds.some((item) => item.value === 'jev'), '补全应含 jev 子命令');
const fuzzyCmds = buildStaffsArgumentCompletions('p', presetNames);
assert(fuzzyCmds.some((item) => item.value === 'preset') && fuzzyCmds.some((item) => item.value === 'panel'), '首字母应模糊命中 preset/panel');
assert(!fuzzyCmds.some((item) => item.value === 'doctor'), '过滤后不该带出不匹配子命令');
const presetArgs = buildStaffsArgumentCompletions('preset ', presetNames);
assert(presetArgs.length === presetNames.length && presetArgs.every((item) => presetNames.includes(item.value)), 'preset 参数段应给出全部档位名');
const presetHit = buildStaffsArgumentCompletions('preset baseline', presetNames);
assert(presetHit.length === 1 && presetHit[0].value === 'baseline', '档位名输入应模糊到已存在档位');
const panelF = buildStaffsArgumentCompletions('panel f', presetNames);
assert(panelF.some((item) => item.value === 'footer') && !panelF.some((item) => item.value === 'widget'), 'panel 参数应模糊到 footer');
assert(buildStaffsArgumentCompletions('roles ', presetNames).length === 0, '无参数子命令（roles）不应产出建议');
assert(buildStaffsArgumentCompletions('preset none-x', presetNames).length === 0, '不存在的档位名不应产出建议');
ok('buildStaffsArgumentCompletions：子命令与二级参数补全、自行模糊过滤');


// ---------- 6. guest 内核（桩 agents + 桩时钟） ----------
const { buildStaffsPrelude } = await load("src/prelude.ts");
const prelude = buildStaffsPrelude({
   config: good.config,
   aliases: { "alias-fixer": "q/heavy-fixer" },
   promptFallback: (role) => `ROLE-PROMPT:${role}`,
});

const heavyAgents = makeAgents(["x"]);
installEnv(heavyAgents);
const heavyStaffs = evaluatePrelude(prelude);
assert(
   heavyStaffs.preset().active === "heavy" &&
      heavyStaffs.preset().available.join(",") === "baseline,heavy",
   "staffs.preset() 应报出当前档位与可用档位",
);
assert(heavyStaffs.list().includes("trio"), "staffs.list() 应列出角色");
assert(
   heavyStaffs.describe("fixer").model === "q/heavy-fixer",
   "describe 应给当前档位下的最终模型",
);
assert(
   heavyStaffs.describe("fixer").thinking === "max",
   "describe 应给档位覆盖后的思考档",
);
ok("prelude：档位在宿主侧解析（别名 → provider/model），guest 只看结果");

const successAgents = makeAgents([]);
installEnv(successAgents);
const agentsForRun = evaluatePrelude(prelude);
const success = await agentsForRun.run({ role: "fixer", task: "改个 bug" });
assert(success.ok === true, "正常派发应成功");
assert(
   successAgents.calls[0].model === "q/heavy-fixer",
   `档位模型应生效：${successAgents.calls[0].model}`,
);
assert(successAgents.calls[0].thinking === "max", "思考档应被角色矩阵强制");
assert(
   successAgents.calls[0].tools.join(",") === "read,edit",
   "工具白名单应被角色矩阵强制",
);
assert(
   successAgents.calls[0].task === "自定义：只改这一处\n\nTask:\n改个 bug",
   `角色提示应合并进 task：${successAgents.calls[0].task}`,
);
assert(success.attempts.length === 1, "一次成功只该有一条 attempt 记录");
assert(success.model === "q/heavy-fixer", "返回值应给出实际使用的模型");
ok("内核：档位模型 + 角色 thinking/tools + 提示合并，一次成功");

const admissionAgents = makeAgents([
   "RPC admission timed out; task was not sent",
   undefined,
]);
installEnv(admissionAgents);
const admissionStaffs = evaluatePrelude(prelude);
const admitted = await admissionStaffs.run({ role: "orchestrator", task: "T" });
assert(admitted.ok === true, "准入超时后重试同一模型应能成功");
assert(admissionAgents.calls.length === 2, "应重试一次");
assert(
   admissionAgents.calls[0].model === admissionAgents.calls[1].model,
   "重试必须是同一模型（D24：不再换备用）",
);
assert(
   sleeps.length === 1 && sleeps[0] === 15000,
   `准入退避应取 15s 下限：${sleeps[0]}`,
);
assert(
   admitted.attempts[0].kind === "admission" &&
      admitted.attempts[1].kind === "backoff",
   "attempt 记录应含类别与退避",
);
ok("内核：准入超时 → 同一模型退避 15s 重试 → 成功");

const rateAgents = makeAgents([
   "429 Too Many Requests; Retry-After: 3",
   undefined,
]);
installEnv(rateAgents);
const rateStaffs = evaluatePrelude(prelude);
const rated = await rateStaffs.run({ role: "orchestrator", task: "T" });
assert(rated.ok === true, "限流后重试应成功");
assert(sleeps[0] === 3000, `Retry-After 应优先：${sleeps[0]}`);
assert(rateAgents.calls.length === 2, "限流应重试同一模型");
ok("内核：429 → 尊重 Retry-After 重试同一模型");

const deadAgents = makeAgents(["Unknown model: p/nope"]);
installEnv(deadAgents);
const deadStaffs = evaluatePrelude(prelude);
const dead = await deadStaffs.run({ role: "orchestrator", task: "T" });
assert(
   dead.ok === false && dead.kind === "unavailable",
   "模型不可用应快速失败",
);
assert(deadAgents.calls.length === 1, "不可用不该重试");
assert(sleeps.length === 0, "不可用不该等");
ok("内核：模型不可用 = 不重试不等待");

const failAgents = makeAgents(["test failed: expected 1 got 2"]);
installEnv(failAgents);
const failStaffs = evaluatePrelude(prelude);
const failed = await failStaffs.run({ role: "fixer", task: "T" });
assert(failed.ok === false && failed.kind === "other", "真任务失败应归 other");
assert(failAgents.calls.length === 1, "真任务失败绝不重试");
ok("内核：真任务失败不重试");

const stubbornAgents = makeAgents([
   "RPC admission timed out; task was not sent",
]);
installEnv(stubbornAgents);
const stubbornStaffs = evaluatePrelude(prelude);
const stubborn = await stubbornStaffs.run({ role: "orchestrator", task: "T" });
assert(
   stubborn.ok === false && stubborn.kind === "admission",
   "连续准入失败应如实上报",
);
assert(stubbornAgents.calls.length === 2, "应按 attemptsPerModel=2 停止");
assert(sleeps.length === 1, "只该退避一次");
ok("内核：连续准入失败按 attemptsPerModel 上限停止");

const spawnAgents = makeAgents([]);
installEnv(spawnAgents);
const spawnStaffs = evaluatePrelude(prelude);
const spawned = await spawnStaffs.spawn({ role: "trio", task: "T" });
assert(spawned.ok === true && spawned.handle !== undefined, "spawn 应回传句柄");
assert(spawnAgents.calls[0].__spawn === true, "spawn 应走 agents.spawn");
assert(spawnAgents.calls[0].model === "p/zzz", "spawn 也应用档位解析后的模型");
ok("内核：spawn 走 agents.spawn 并回传句柄");

throws(
   () => spawnStaffs.run({ role: "ghost", task: "T" }),
   /Unknown Pi-Staffs role/,
);
throws(() => spawnStaffs.run({ role: "fixer", task: "   " }), /非空 task/);
const disabled = config.validateConfig(
   {
      roles: {
         sleepy: {
            model: "p/a",
            thinking: "low",
            mode: "subagent",
            tools: ["read"],
            enabled: false,
         },
      },
   },
   {},
);
installEnv(makeAgents([]));
const disabledStaffs = evaluatePrelude(
   buildStaffsPrelude({
      config: disabled.config,
      aliases: {},
      promptFallback: () => undefined,
   }),
);
throws(() => disabledStaffs.run({ role: "sleepy", task: "T" }), /已停用/);
throws(
   () => disabledStaffs.run({ role: "nobody", task: "T" }),
   /Unknown Pi-Staffs role/,
);
ok("内核：未知角色 / 空 task / 已停用角色都会被拒绝");

// ---------- 7. 预检 ----------
const preflightAgents = makeAgents([], {
   models: [
      { provider: "p", id: "a" },
      { provider: "p", id: "b" },
      { provider: "q", id: "heavy-fixer" },
   ],
});
installEnv(preflightAgents);
const preflightStaffs = evaluatePrelude(prelude);
const preflight = await preflightStaffs.preflight(["trio", "alien", "fixer"]);
assert(preflight.ok === false, "预检应发现坏引用");
assert(
   preflight.missing.join(",") === "p/zzz,zz/none",
   `缺失列表不对：${preflight.missing.join(",")}`,
);
const trioEntry = preflight.models.find((entry) => entry.model === "p/zzz");
assert(
   trioEntry.candidates.join(",") === "a,b",
   `候选列表不对：${trioEntry.candidates.join(",")}`,
);
const alienEntry = preflight.models.find((entry) => entry.model === "zz/none");
assert(alienEntry.candidates.length === 0, "未知 provider 不该编造候选");
const fixerEntry = preflight.models.find(
   (entry) => entry.model === "q/heavy-fixer",
);
assert(fixerEntry.available === true, "档位模型应在可用列表里被判为可用");
ok("预检：快速失败并列出候选模型（含档位覆盖后的模型）");

   // 交接给后续领域模块（通过 S 袋，代替原先的单文件作用域）。
   Object.assign(S, { config, aliases, good, buildStaffsPrelude, prelude });
};
