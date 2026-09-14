/**
 * Pi-Staffs 冒烟测试：不启动 Pi，只把契约钉住。
 *
 * 为什么能这样测：扩展的全部逻辑要么在宿主（配置/校验/prelude 拼装），要么在 guest 内核
 * （src/guest/kernel.js，一段纯 JS）——后者用 new Function + 桩 agents 就能确定性执行，
 * 这正是「准入超时后重试同一模型」这类行为能在 CI 里被验证的原因。
 *
 * 环境隔离：PI_STAFFS_CONFIG / PI_STAFFS_FABRIC_CONFIG 指向临时目录，
 * 测试绝不碰用户真实的 ~/.pi/agent/pi-staffs.json。
 */
import {
   existsSync,
   mkdirSync,
   mkdtempSync,
   readFileSync,
   rmSync,
   writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(path.join(tmpdir(), "pi-staffs-smoke-"));
const configPath = path.join(sandbox, "pi-staffs.json");
const fabricPath = path.join(sandbox, "fabric.json");
writeFileSync(
   fabricPath,
   JSON.stringify({ models: { aliases: { fixer: "p/alias-target" } } }),
);
process.env.PI_STAFFS_CONFIG = configPath;
process.env.PI_STAFFS_FABRIC_CONFIG = fabricPath;
delete process.env.PI_FABRIC_PARENT_RUN;

const load = (relative) =>
   import(pathToFileURL(path.join(repo, relative)).href);
const assert = (condition, message) => {
   if (!condition) throw new Error(`断言失败：${message}`);
};
const throws = (fn, pattern) => {
   try {
      fn();
   } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      assert(pattern.test(text), `错误文本不匹配：${text}`);
      return;
   }
   throw new Error(`预期抛错但没有：${pattern}`);
};

/** 异步版 throws：execute 是 async，抛错会变成 rejected promise。 */
const rejects = async (fn, pattern) => {
   try {
      await fn();
   } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      assert(pattern.test(text), `错误文本不匹配：${text}`);
      return;
   }
   throw new Error(`预期抛错但没有：${pattern}`);
};

const checks = [];
const ok = (name) => checks.push(name);

// ---------- 桩：宿主 API / 时钟 / 休眠 ----------
let clock = 1_000_000;
const sleeps = [];

/** sequence 每项：字符串 = 抛出的错误文本；{ error } = 返回带 error 的结果；其余 = 成功。 */
const makeAgents = (sequence = [], options = {}) => {
   const calls = [];
   let index = 0;
   const next = () => {
      const item = sequence[Math.min(index, Math.max(0, sequence.length - 1))];
      index += 1;
      return item;
   };
   const record = (request) => {
      calls.push(request);
      const item = next();
      if (typeof item === "string") throw new Error(item);
      if (item && typeof item === "object")
         return { error: item.error, task: request.task };
      return { text: "done", task: request.task, turns: 1 };
   };
   return {
      calls,
      run: async (request) => record(request),
      // agents.spawn 真实返回的是句柄记录本身（含 id/status/name），不再套一层 { handle }。
      spawn: async (request) => {
         calls.push({ ...request, __spawn: true });
         return { id: "agent-1", name: "agent-1", status: "running", ok: true };
      },
      models: async () => options.models ?? [],
   };
};

/** 装桩环境；内核通过 globalThis.__staffsEnv 取宿主 API 与时钟，测试才能确定性。 */
const installEnv = (agents) => {
   sleeps.length = 0;
   clock = 1_000_000;
   globalThis.__staffsEnv = {
      agents,
      now: () => clock,
      sleep: async (ms) => {
         sleeps.push(ms);
         clock += ms;
      },
      random: () => 0.5,
   };
};

/**
 * 把生成的 prelude 当 guest 代码执行，拿回它的 staffs 对象。
 *
 * 为什么允许动态执行：prelude 的目标运行环境是 fabric_exec 沙箱，宿主无法静态调用它；
 * 而这正是「任务失败不重试」「准入超时重试同一模型」能被断言的前提。执行的是我们自己生成的字符串。
 * 故意不传 agents 参数：走 __staffsEnv.agents，与真实注入路径一致。
 */
const evaluatePrelude = (prelude) =>
   new Function(`${prelude}\nreturn staffs;`)();

const readConfigFile = () => JSON.parse(readFileSync(configPath, "utf8"));

// ---------- 1. 装载契约 ----------
const mod = await load("src/index.ts");
// 真实 Pi 允许同一事件挂多个处理器（我们自己的钩子与 prelude 注入都挂在 tool_call 上），
// 所以桩必须按列表保存并像 SDK 那样把返回值当补丁链式合并，否则「只留最后一个」会骗过测试。
const hookLists = new Map();
const hooks = {
   has: (name) => hookLists.has(name),
   get:
      (name) =>
      async (event, context = ctx) => {
         let patch;
         for (const handler of hookLists.get(name) ?? []) {
            const result = await handler(event, context);
            if (result && typeof result === "object")
               patch = { ...patch, ...result };
         }
         return patch;
      },
};
const commands = new Map();
const tools = new Map();
const notifications = [];
const ctx = {
   hasUI: false,
   ui: { notify: (text, level) => notifications.push({ text, level }) },
};
mod.default({
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

/** 用「命令行可见的行为」验证 /staffs：写盘 + 通知。 */
const runCommand = async (args) => {
   notifications.length = 0;
   await commands.get("staffs").handler(args, ctx);
   return notifications.map((entry) => entry.text).join("\n");
};
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

// ---------- 9. 复审（票 08）：纯逻辑 + 宿主工具 ----------
const review = await load("src/review.ts");
const parsed = review.parseFindings(
   [
      "结论如下：",
      "- [blocker] src/a.ts:12 — 越权写文件",
      "- [P1] src/b.ts — 缺少超时",
      "- 普通列表项，不该算发现",
      "no findings",
   ].join("\n"),
);
assert(parsed.length === 2, `应解析出 2 条发现，实际 ${parsed.length}`);
assert(
   parsed[0].file === "src/a.ts" && parsed[0].line === 12,
   "应解析文件与行号",
);
assert(parsed[1].severity === "major", "P1 应映射为 major");
assert(
   parsed[1].file === "src/b.ts" && parsed[1].line === undefined,
   "无行号时不该编造行号",
);
const deduped = review.dedupeFindings([...parsed, ...parsed]);
assert(
   deduped.fresh.length === 2 && deduped.duplicates.length === 2,
   "重复发现应按指纹去重",
);
const nit = { severity: "nit", message: "风格", raw: "- [nit] 风格" };
const round1 = review.planReviewRound({ round: 0, findings: [...parsed, nit] });
assert(round1.action === "fix" && round1.findings.length === 2, "nit 默认不修");
assert(round1.findings[0].severity === "blocker", "应按严重度排序");
const round2 = review.planReviewRound({
   round: 1,
   findings: round1.findings,
   maxRounds: 2,
});
assert(round2.action === "fix", "未到上限应继续修");
const round3 = review.planReviewRound({
   round: 2,
   findings: round1.findings,
   maxRounds: 2,
});
assert(
   round3.action === "stop" && /上限/.test(round3.reason),
   "到上限应停下交回队长",
);
assert(
   review.planReviewRound({ round: 0, findings: [] }).action === "stop",
   "无发现即停",
);
const brief = review.buildReviewBrief({
   task: "T",
   diff: "diff --git a/x b/x",
   acceptance: ["通过冒烟"],
   base: "HEAD",
});
assert(brief.includes("相对 HEAD"), "brief 应写清基线");
assert(
   brief.includes("通过冒烟") && brief.includes(review.FINDINGS_FORMAT),
   "brief 应含验收标准与输出格式",
);
assert(
   review
      .buildReviewBrief({ task: "T", diff: "x".repeat(50), maxChars: 10 })
      .includes("已截断"),
   "超长 diff 应截断并标注",
);
ok("复审：findings 解析 / 去重 / 轮次策略 / brief 截断");

const reviewTool = tools.get("staffs_review");
assert(reviewTool, "应注册 staffs_review");
const briefReply = await reviewTool.execute("id", {
   task: "T",
   diff: "diff --git a/x b/x",
   acceptance: ["A"],
});
assert(briefReply.content[0].text.includes("```diff"), "应回可派发的 brief");
assert(briefReply.content[0].text.includes("oracle"), "应指明交给 oracle 角色");
const fixReply = await reviewTool.execute("id", {
   task: "T",
   findingsText: "- [major] src/a.ts:3 — 少了守卫",
});
assert(
   fixReply.content[0].text.includes("只修下面这些复审发现"),
   "应把发现转成待修任务",
);
assert(fixReply.details.action === "fix", "有待修条目时 action=fix");
const cleanReply = await reviewTool.execute("id", {
   task: "T",
   findingsText: "no findings",
});
assert(cleanReply.content[0].text.includes("没有待修条目"), "无发现应直接停");
ok("复审工具：brief / 待修任务 / 无发现即停");

// ---------- 10. 外部引擎白名单 + 体检 + 子命令（票 14/16/19） ----------
const withAcp = config.validateConfig(
   {
      roles: {
         orchestrator: {
            model: "p/a",
            thinking: "high",
            mode: "primary",
            tools: ["*"],
         },
      },
      acp: {
         mine: { command: "my-cli", args: ["-p", "{prompt}"] },
         broken: 42,
         noCommand: { args: [] },
      },
   },
   aliases,
);
assert(withAcp.config.acp.codex.command === "codex", "默认引擎应保留");
assert(withAcp.config.acp.mine.command === "my-cli", "自定义引擎应合并进来");
assert(!withAcp.config.acp.broken, "非法引擎条目应被丢弃");
assert(
   withAcp.issues.some((issue) => issue.includes("acp.broken")) &&
      withAcp.issues.some((issue) => issue.includes("acp.noCommand")),
   "非法引擎应逐个报告",
);
const { formatDoctorReport } = await load("src/tools.ts");
const doctorText = formatDoctorReport({
   config: withAcp.config,
   aliases,
   state: {
      stateVersion: 1,
      updatedAt: 0,
      attempts: [],
      tasks: [],
      mailbox: [],
   },
   path: "mem",
});
assert(
   doctorText.includes("orchestrator") && doctorText.includes("p/a"),
   "体检应列出角色与实际模型",
);
assert(
   doctorText.includes("外部引擎") && doctorText.includes("mine=my-cli"),
   "体检应列出外部引擎",
);
assert(doctorText.includes("看板："), "体检应含看板计数");
ok("体检：角色模型 / 引擎白名单 / 看板计数");

assert(
   ["staffs_doctor", "staffs_astgrep", "staffs_acp"].every((name) =>
      tools.has(name),
   ),
   "应注册体检 / 结构化搜索 / 外部引擎工具",
);
const doctorReply = await tools.get("staffs_doctor").execute("id", {});
assert(
   doctorReply.content[0].text.includes("配置："),
   "staffs_doctor 应回体检报告",
);
const unknownEngine = await tools.get("staffs_acp").execute("id", {
   engine: "nope",
   prompt: "hi",
});
assert(unknownEngine.details.ok === false, "白名单外的引擎必须被拒绝");
ok("工具：staffs_doctor 可用，staffs_acp 拒绝白名单外引擎");

assert((await runCommand("board")).length > 0, "/staffs board 应有输出");
const cmdDoctor = await runCommand("doctor");
assert(
   cmdDoctor.includes("档位：") && cmdDoctor.includes("合议："),
   "/staffs doctor 应回体检",
);
ok("/staffs：board 与 doctor 子命令");

const statuses = [];
await hooks.get("turn_end")(
   {},
   {
      hasUI: true,
      ui: {
         notify: () => {},
         setStatus: (key, value) => statuses.push([key, value]),
      },
   },
);
assert(
   statuses.length === 1 && statuses[0][0] === "pi-staffs",
   `turn_end 应写 footer 状态行，实际 ${JSON.stringify(statuses)}`,
);
ok("TUI：turn_end 更新 footer 状态行（空闲时清空）");

// ---------- 11. D26 旋钮：maxRetries 覆盖 attemptsPerModel（票 21） ----------
const knobConfig = config.validateConfig(
   { ...good.config, dispatch: { ...good.config.dispatch, maxRetries: 1 } },
   aliases,
).config;
const knobPrelude = buildStaffsPrelude({
   config: knobConfig,
   aliases: { "alias-fixer": "q/heavy-fixer" },
   promptFallback: (role) => `ROLE-PROMPT:${role}`,
});
const knobAgents = makeAgents(["RPC admission timed out; task was not sent"]);
installEnv(knobAgents);
const knobStaffs = evaluatePrelude(knobPrelude);
const knobRole = Object.keys(knobConfig.roles)[0];
const knobRun = await knobStaffs.run({ role: knobRole, task: "T" });
assert(
   knobRun.ok === false && knobRun.kind === "admission",
   "maxRetries=1 仍应如实上报准入失败",
);
assert(
   knobAgents.calls.length === 2,
   `maxRetries=1 应为 2 次尝试，实际 ${knobAgents.calls.length}`,
);
ok("韧性：maxRetries 覆盖 attemptsPerModel（总尝试 = 1 + maxRetries）");

// ---------- 12. 技能（票 10/23） ----------
const skillsMod = await load("src/skills.ts");
const skillList = skillsMod.listStaffsSkills();
assert(skillList.length === 9, `应有 9 个随包技能，实际 ${skillList.length}`);
assert(
   skillList.every((skill) => skill.name && skill.description.length > 10),
   "每个技能都要有 name 与可用的 description",
);
for (const name of [
   "clonedeps",
   "codemap",
   "deepwork",
   "loop-engineering",
   "pi-staffs",
   "reflect",
   "simplify",
   "verification-planning",
   "worktrees",
])
   assert(
      skillList.some((skill) => skill.name === name),
      `缺少技能 ${name}`,
   );
const skillText = await runCommand("skills");
assert(skillText.includes("deepwork"), "/staffs skills 应列出技能");
const syncTarget = path.join(sandbox, "skills");
const synced = skillsMod.syncStaffsSkills(syncTarget);
assert(
   synced.copied.length === 9 &&
      existsSync(path.join(syncTarget, "deepwork", "SKILL.md")),
   "同步应把全部 SKILL.md 复制到目标目录",
);
ok("技能：9 个随包技能可列出、可同步");

// ---------- 13. 状态机：DAG / 信箱 / 落盘（票 12/13） ----------
const stateMod = await load("src/state.ts");
const team = stateMod.emptyState(1_000);
stateMod.addTask(team, { id: "t-1", title: "造工具", role: "fixer" }, 1_000);
stateMod.addTask(team, { id: "t-2", title: "接工具", deps: ["t-1"] }, 1_000);
assert(
   stateMod
      .readyTasks(team)
      .map((t) => t.id)
      .join(",") === "t-1",
   "有依赖的任务不该进就绪集",
);
stateMod.claimTask(team, "t-1", "att-1", 1_000);
assert(stateMod.readyTasks(team).length === 0, "进行中的任务不该再进就绪集");
stateMod.finishTask(team, "t-1", "done", 1_000);
assert(
   stateMod
      .readyTasks(team)
      .map((t) => t.id)
      .join(",") === "t-2",
   "前置完成后下游才就绪",
);
assert(stateMod.formatBoard(team).includes("t-2"), "看板应列出任务");
stateMod.sendMail(
   team,
   { from: "fixer", to: "orchestrator", text: "干完了" },
   1_000,
);
assert(
   stateMod.takeMail(team, "orchestrator").length === 1,
   "信箱应能取到消息",
);
assert(
   stateMod.takeMail(team, "orchestrator").length === 0,
   "已读消息不该重放",
);
const stateFile = path.join(sandbox, "state.json");
stateMod.writeState(team, stateFile);
assert(stateMod.readState(stateFile).tasks.length === 2, "状态应能落盘再读回");
ok("状态机：依赖门控 / 句柄认领 / 信箱已读 / 落盘回读");

// ---------- 14. tracker 导入幂等（票 12） ----------
const trackerMod = await load("src/tracker.ts");
const issuesDir = path.join(sandbox, "issues");
mkdirSync(issuesDir, { recursive: true });
writeFileSync(
   path.join(issuesDir, "07-a.md"),
   "---\ntitle: 甲\ndeps: [06-x]\n---\n正文\n",
);
writeFileSync(
   path.join(issuesDir, "08-b.md"),
   "---\ntitle: 乙\nstatus: done\n---\n做完的\n",
);
const imported = stateMod.emptyState(1_000);
const markdownTracker = trackerMod.localMarkdownTracker(issuesDir);
const firstImport = await trackerMod.importCandidates(
   imported,
   markdownTracker,
   1_000,
);
const secondImport = await trackerMod.importCandidates(
   imported,
   markdownTracker,
   1_000,
);
assert(firstImport.map((t) => t.id).join(",") === "07-a", "只应导入未关闭的票");
assert(secondImport.length === 0, "重复导入必须幂等");
ok("tracker：local-markdown 导入未关闭票且幂等");

// ---------- 15. 合议（票 07/17） ----------
const councilAliases = {
   "alias-fixer": "q/heavy-fixer",
   "alias-oracle": "q/oracle",
};
const councilCfg = config.validateConfig(
   {
      council: {
         members: ["alias-fixer", "alias-oracle"],
         synth: "alias-fixer",
      },
   },
   councilAliases,
).config;
const councilStaffs = evaluatePrelude(
   buildStaffsPrelude({
      config: councilCfg,
      aliases: councilAliases,
      promptFallback: (role) => `ROLE-PROMPT:${role}`,
   }),
);
const councilAgents = makeAgents([]);
installEnv(councilAgents);
const council = await councilStaffs.council({ task: "选个方案" });
assert(
   council.ok === true && council.members.length === 2,
   `合议应并行跑满成员：${JSON.stringify(council.members)}`,
);
assert(
   council.members.map((member) => member.model).join(",") ===
      "q/heavy-fixer,q/oracle",
   "成员模型应由宿主解析成最终引用",
);
assert(council.synthesis?.answer === "done", "有 synth 时应给出合成答案");
const synthCall = councilAgents.calls[councilAgents.calls.length - 1];
assert(
   synthCall.task.includes("## q/heavy-fixer") &&
      synthCall.task.includes("## q/oracle"),
   "合成输入应带上各成员答案",
);
try {
   await councilStaffs.council({ task: "x", models: ["q/only"] });
   throw new Error("预期合议报错");
} catch (error) {
   assert(
      /至少需要 2 个模型/.test(String(error.message)),
      `成员不足应报错：${error.message}`,
   );
}
ok("合议：成员并行 + 合成答案 + 成员不足时报错");

// ---------- 16. reviver（票 16） ----------
const reviveAgents = makeAgents([]);
reviveAgents.status = async () => ({ state: "failed", task: "旧任务" });
installEnv(reviveAgents);
const reviveStaffs = evaluatePrelude(prelude);
const revived = await reviveStaffs.revive({ id: "agent-9", role: "fixer" });
assert(
   revived.revived === true && revived.handle.id === "agent-1",
   `死句柄应按原角色重新拉起：${JSON.stringify(revived)}`,
);
assert(
   reviveAgents.calls.some((call) => call.__spawn === true),
   "revive 必须走 spawn 通道，不能阻塞宿主",
);
reviveAgents.status = async () => ({ state: "running" });
const alive = await reviveStaffs.revive({ id: "agent-9" });
assert(alive.revived === false, "活着的句柄不该被重开");
ok("reviver：死句柄重拉同角色，活句柄不打扰");

// ---------- 17. worktree 注入 + 缓存安全（票 18/20） ----------
const { injectAgentsBlock, installDeps, worktreeTarget } = await load("src/tools.ts");
const worktree = path.join(sandbox, "worktree");
mkdirSync(worktree, { recursive: true });
writeFileSync(path.join(worktree, "AGENTS.md"), "# 人类写的规约\n");
injectAgentsBlock(worktree, "车道：只改 src/\n");
injectAgentsBlock(worktree, "车道：只改 src/\n");
const agentsMd = readFileSync(path.join(worktree, "AGENTS.md"), "utf8");
assert(agentsMd.includes("# 人类写的规约"), "注入不该冲掉人类已有的内容");
assert(
   agentsMd.split("<!-- pi-staffs:begin -->").length === 2,
   "重复注入应替换同一块，而不是叠加",
);
assert(
   (await installDeps(worktree)).includes("无 package.json"),
   "没有 package.json 时应跳过依赖安装",
);
const target = worktreeTarget(worktree, "feature-x");
assert(
   target.branch === "staffs/feature-x" &&
      target.directory ===
         path.join(worktree, ".staffs", "worktrees", "feature-x"),
   "worktree 名应落到 .staffs/worktrees 下，分支带 staffs/ 前缀",
);
for (const bad of ["../escape", "a/../../b", "/abs/x", "C:/abs/x", "bad name", "  "]) {
   throws(
      () => worktreeTarget(worktree, bad),
      /不得越出|需要 name|只允许/,
   );
}
await rejects(
   () => tools.get("staffs_worktree").execute("id", { op: "remove", name: "../../etc" }),
   /不得越出|只允许|需要 name/,
);
const hooksMod = await load("src/hooks.ts");
assert(
   buildStaffsPrelude({
      config: good.config,
      aliases: { "alias-fixer": "q/heavy-fixer" },
      promptFallback: (role) => `ROLE-PROMPT:${role}`,
   }) === prelude,
   "同样输入必须产出逐字节相同的 prelude（前缀缓存安全）",
);
assert(
   hooksMod.buildTurnInjection(stateMod.emptyState(1_000), 1_000) === "",
   "空状态不该注入任何文本（缓存前缀稳定）",
);
ok("worktree：注入块幂等；越界名被拒；缓存：prelude 稳定、空状态零注入");

// ---------- 17b. webfetch：协议白名单 + 响应字节封顶 ----------
const server = createServer((_request, response) => {
   response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
   response.end("<p>" + "x".repeat(2_000_000) + "</p>");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
const webfetch = tools.get("staffs_webfetch");
const fetched = await webfetch.execute("id", {
   url: `http://127.0.0.1:${port}/`,
   maxChars: 1_000,
});
assert(
   fetched.content[0].text.length <= 1_100,
   "正文必须按 maxChars 截断后才进上下文",
);
assert(
   fetched.details.length > 1_000,
   "服务端确实发了 2MB：截断应发生在输出侧，而不是读不到内容",
);
await rejects(
   () => webfetch.execute("id", { url: "file:///etc/passwd" }),
   /只支持 http\/https/,
);
await rejects(
   () => webfetch.execute("id", { url: "不是 URL" }),
   /需要合法的绝对 URL/,
);
server.close();
ok("webfetch：非 http(s) 直接拒收；2MB 响应按字节封顶");

// ---------- 18. 观测层（票 15）：footer 相位判定 / 面板行 / 开关 ----------
const obsNow = 2_000_000;
const mkAttempt = (patch = {}) => ({
   id: "a1",
   role: "fixer",
   model: "p/m",
   phase: "running",
   startedAt: obsNow,
   heartbeatAt: obsNow,
   owner: "host",
   notes: [],
   ...patch,
});
const obsState = {
   ...stateMod.emptyState(obsNow),
   attempts: [
      mkAttempt(),
      mkAttempt({ id: "a2", phase: "settled", terminal: "stalled" }),
      mkAttempt({ id: "a3", phase: "awaiting", heartbeatAt: obsNow - 200_000 }),
   ],
   mailbox: [
      {
         id: "m1",
         from: "orchestrator",
         to: "fixer",
         text: "x",
         at: obsNow,
         read: false,
      },
      {
         id: "m2",
         from: "orchestrator",
         to: "*",
         text: "y",
         at: obsNow,
         read: true,
      },
   ],
};
assert(
   stateMod.footerSummary(obsState) === "staffs · 跑 2 · 停 1 · 信 1",
   `footer 要按相位统计（含 awaiting 的「跑」与直接寄出的未读信），实际 ${stateMod.footerSummary(obsState)}`,
);
assert(
   stateMod.footerSummary(stateMod.emptyState(obsNow)) === undefined,
   "空状态必须清掉状态行（返回 undefined）",
);
const panelLines = stateMod.formatPanel(obsState, { now: obsNow });
assert(
   panelLines.some((line) => line.includes("[running]")),
   "面板要显示 attempt 相位",
);
assert(
   panelLines.some((line) => line.includes("疑似卡住")),
   "面板要与看门狗同阈值标出 stale",
);
assert(
   stateMod.formatPanel(stateMod.emptyState(obsNow), { now: obsNow }).length ===
      0,
   "空态面板应为空数组（空面板不占屏幕）",
);
ok("观测层：footer 按相位统计、面板带相位与 stale 标记");

// ---------- 19. 面试稿 frontmatter 往返 + ast-grep 参数（票 16/17） ----------
const { formatInterview, parseInterview, astGrepArgs } =
   await load("src/tools.ts");
const interviewDoc = {
   topic: "派发韧性",
   createdAt: "2026-01-01T00:00:00.000Z",
   status: "in-progress",
   items: [
      { question: "准入失败怎么办", answer: "同模型退避重试" },
      { question: "限次用尽呢", answer: "（未回答）" },
   ],
};
const roundtrip = parseInterview(formatInterview(interviewDoc));
assert(
   roundtrip &&
      roundtrip.topic === interviewDoc.topic &&
      roundtrip.status === "in-progress",
   "面试稿要能被 parser 读回（含 frontmatter 与状态）",
);
assert(
   roundtrip.items.length === 2 &&
      roundtrip.items[0].answer === "同模型退避重试",
   `Q&A 历史要按序读回，实际 ${JSON.stringify(roundtrip.items)}`,
);
assert(
   parseInterview("# 别的 markdown\n") === undefined,
   "没有 frontmatter 的稿子应当作新稿处理",
);
const replaceArgs = astGrepArgs({
   pattern: "foo($A)",
   lang: "ts",
   rewrite: "bar($A)",
   path: "src",
});
assert(
   replaceArgs.includes("--rewrite") && replaceArgs.includes("--update-all"),
   "给了 rewrite 才带替换参数",
);
assert(
   !astGrepArgs({ pattern: "foo" }).includes("--update-all"),
   "只搜不换绝不能改盘",
);
ok("面试稿：frontmatter 往返可读回；ast-grep：只搜不换不动盘");

// ---------- 20. 观测层开关 + 包清单 + 钩子不抹状态（发版回归钉） ----------
assert(config.defaultStaffsConfig().panel === "footer", "默认观测层是 footer");
assert(
   config.validateConfig({ ...good.config, panel: "nope" }, aliases).config
      .panel === "footer",
   "非法观测层形态退回 footer",
);
assert(
   config.validateConfig({ ...good.config, panel: "widget" }, aliases).config
      .panel === "widget",
   "合法观测层形态要保留",
);
const manifest = JSON.parse(
   readFileSync(path.join(repo, "package.json"), "utf8"),
);
assert(
   manifest.pi.skills?.includes("./skills") &&
      manifest.pi.prompts?.includes("./prompts"),
   "有 pi manifest 时不再自动发现：skills/prompts 必须显式声明",
);
assert(
   manifest.files.includes("skills/") && manifest.files.includes("prompts/"),
   "files 必须带上 skills/prompts，否则发出去的包会丢技能与角色提示词",
);
assert(
   manifest.peerDependencies?.typebox === "*",
   "typebox 由 pi 提供，必须声明为 peer",
);
ok("清单：skills/prompts 显式声明且随包发布；观测层非法值有兜底");

// 钩子不许把注册期的陈旧快照写回去：那会抹掉工具刚写的任务（最难查的一类数据丢失）。
const hookHandlers = new Map();
const hookPath = path.join(sandbox, "hook-state.json");
hooksMod.registerStaffsHooks(
   { on: (name, handler) => hookHandlers.set(name, handler) },
   { statePath: hookPath },
);
stateMod.writeState(
   {
      ...stateMod.emptyState(obsNow),
      tasks: [
         {
            id: "t1",
            title: "别把我抹掉",
            deps: [],
            status: "running",
            updatedAt: obsNow,
         },
      ],
   },
   hookPath,
);
await hookHandlers.get("turn_end")();
const afterTurn = stateMod.readState(hookPath, obsNow);
assert(
   afterTurn.tasks.length === 1 && afterTurn.tasks[0].id === "t1",
   `turn_end 不得抹掉工具刚写的任务，实际 ${JSON.stringify(afterTurn.tasks)}`,
);
ok("钩子：turn_end 重读状态后再落盘（不抹工具刚写的数据）");

// ---------- 21. 安全边界（评审第一批）：通配 deny / 路径锁 / ref 校验 / 票 id / Windows npm ----------
const sec21Perms = await load("src/permissions.ts");
const sec21Wild = sec21Perms.checkRolePermissions("wild", {
   instructions: "x",
   model: "p/x",
   thinking: "off",
   tools: ["*"],
   permissions: { deny: ["bash"] },
});
assert(
   !sec21Wild.allowed && sec21Wild.reason.includes("*"),
   "tools 含 * 且配了 deny 必须预检失败，而不是静默放行",
);
const sec21Tools = await load("src/tools.ts");
assert(
   (() => {
      try {
         sec21Tools.resolveInside("/repo", "../evil.md");
         return false;
      } catch {
         return true;
      }
   })(),
   "resolveInside 必须拒绝越出项目目录的相对路径",
);
assert(
   sec21Tools.resolveInside("/repo", "a/b.md") === path.resolve("/repo", "a/b.md"),
   "resolveInside 放行项目内路径",
);
assert(
   (() => {
      try {
         sec21Tools.assertSafeGitRef("--output=x");
         return false;
      } catch {
         return true;
      }
   })(),
   "git base 以 - 开头必须拒绝",
);
assert(
   sec21Tools.assertSafeGitRef("HEAD~2") === "HEAD~2",
   "正常 ref 放行",
);
const sec21Tracker = await load("src/tracker.ts");
const sec21Local = sec21Tracker.localMarkdownTracker(
   path.join(sandbox, "tracker"),
);
let sec21Rejected = false;
try {
   await sec21Local.writeState("../evil", "done", "");
} catch {
   sec21Rejected = true;
}
assert(sec21Rejected, "票 id 含路径分隔必须拒绝（目录穿越）");
assert(
   (await sec21Local.fetchIssue("T-1")) === undefined,
   "合法 id 不存在时返回 undefined 而不是抛错",
);
// installDeps 端到端：空依赖项目必须真装上（win32 同时验证 cmd.exe 垫片）。
const sec21Deps = path.join(sandbox, "deps");
mkdirSync(sec21Deps, { recursive: true });
writeFileSync(
   path.join(sec21Deps, "package.json"),
   JSON.stringify({ name: "smoke-deps", version: "0.0.0" }),
);
const sec21Install = await sec21Tools.installDeps(sec21Deps);
assert(
   sec21Install.startsWith("依赖已安装"),
   "installDeps 必须真装上（win32 走 cmd.exe 垫片），实际：" + sec21Install,
);
ok("安全边界：通配 deny 报错；interview/astgrep 路径锁；git ref 校验；票 id 白名单；npm 安装可用");

rmSync(sandbox, { recursive: true, force: true });

console.log(`smoke ok（${checks.length} 项）：`);
for (const name of checks) console.log(`  - ${name}`);
