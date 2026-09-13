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
   mkdtempSync,
   readFileSync,
   rmSync,
   writeFileSync,
} from "node:fs";
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
      if (item && typeof item === "object") return { error: item.error, task: request.task };
      return { text: "done", task: request.task, turns: 1 };
   };
   return {
      calls,
      run: async (request) => record(request),
      spawn: async (request) => {
         calls.push({ ...request, __spawn: true });
         return { handle: { id: "agent-1", status: "running" } };
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
const hooks = new Map();
const commands = new Map();
const notifications = [];
const ctx = { ui: { notify: (text, level) => notifications.push({ text, level }) } };
mod.default({
   on: (name, handler) => hooks.set(name, handler),
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
assert(created.preset === "baseline", `默认档位应为 baseline：${created.preset}`);
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

// ---------- 3. tool_call 只给 fabric_exec 注入 ----------
const fabricEvent = { toolName: "fabric_exec", input: { code: "const x = 1;" } };
await hooks.get("tool_call")(fabricEvent);
assert(fabricEvent.input.code.includes("const __staffsModels"), "注入串应带角色→模型表");
assert(fabricEvent.input.code.includes("const __staffsPreset"), "注入串应带档位信息");
assert(
   fabricEvent.input.code.endsWith("const x = 1;"),
   "注入应只前置，不吞掉原代码",
);
assert(!fabricEvent.input.code.includes("__staffsLoadHealth"), "健康表已删除（D24）");
const bashEvent = { toolName: "bash", input: { command: "ls" } };
await hooks.get("tool_call")(bashEvent);
assert(bashEvent.input.command === "ls", "非 fabric_exec 不该被动过");
const weirdEvent = { toolName: "fabric_exec", input: { code: 42 } };
await hooks.get("tool_call")(weirdEvent);
assert(weirdEvent.input.code === 42, "code 不是字符串时不该注入");
ok("tool_call：只给 fabric_exec 前置注入 prelude");

// ---------- 4. before_agent_start ----------
assert(
   hooks.get("before_agent_start")({ systemPrompt: "S" }).systemPrompt.includes(
      "Pi-Staffs 编排",
   ),
   "应把派发指引写进 system prompt",
);
process.env.PI_FABRIC_PARENT_RUN = "1";
assert(
   hooks.get("before_agent_start")({ systemPrompt: "S" }) === undefined,
   "子 agent 会话不该再注入指引",
);
ok("before_agent_start：只给顶层会话注入派发指引");

// ---------- 5. 配置模块：解析 / 校验 / 读写 ----------
const config = await load("src/config.ts");
const aliases = { short: "p/aliased-a" };
assert(config.resolveModelRef("short", aliases).ref === "p/aliased-a", "别名应解析");
assert(config.resolveModelRef("p/a", aliases).provider === "p", "直引应解析");
assert(config.resolveModelRef("a", {}) === undefined, "未定义别名应解析失败");
assert(config.resolveModelRef(3, aliases) === undefined, "非字符串应解析失败");
assert(config.resolveModelRef("p/", aliases) === undefined, "缺模型 id 应解析失败");
ok("resolveModelRef：别名 / 直引 / 非法引用");

const rawInvalid = {
   preset: "nope",
   presets: { nope2: {} },
   roles: {
      BadName: { model: "p/a", thinking: "low", tools: ["read"], mode: "subagent" },
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
      trio: { model: "p/zzz", thinking: "low", mode: "subagent", tools: ["read"] },
      alien: { model: "zz/none", thinking: "low", mode: "subagent", tools: ["read"] },
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
assert(reloaded.config.roles.fixer.instructions === "自定义：只改这一处", "往返应保留 instructions");
assert(
   reloaded.config.roles.fixer.model === "p/alias-target",
   "往返应保留原始 model 引用（存别名而不是解析结果）",
);
writeFileSync(configPath, "{ not json");
const broken = config.loadStaffsConfig();
assert(broken.issues.length > 0, "坏 JSON 应报问题");
assert(readFileSync(configPath, "utf8") === "{ not json", "坏 JSON 时绝不覆盖用户文件");
assert(Object.keys(broken.config.roles).length === 7, "坏 JSON 时兜底用内置七神祇");
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
assert(listText.includes("baseline") && listText.includes("heavy"), "/staffs 应列出可用档位");
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
   heavyStaffs.preset().active === "heavy" && heavyStaffs.preset().available.join(",") === "baseline,heavy",
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
assert(sleeps.length === 1 && sleeps[0] === 15000, `准入退避应取 15s 下限：${sleeps[0]}`);
assert(
   admitted.attempts[0].kind === "admission" && admitted.attempts[1].kind === "backoff",
   "attempt 记录应含类别与退避",
);
ok("内核：准入超时 → 同一模型退避 15s 重试 → 成功");

const rateAgents = makeAgents(["429 Too Many Requests; Retry-After: 3", undefined]);
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
assert(dead.ok === false && dead.kind === "unavailable", "模型不可用应快速失败");
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

const stubbornAgents = makeAgents(["RPC admission timed out; task was not sent"]);
installEnv(stubbornAgents);
const stubbornStaffs = evaluatePrelude(prelude);
const stubborn = await stubbornStaffs.run({ role: "orchestrator", task: "T" });
assert(stubborn.ok === false && stubborn.kind === "admission", "连续准入失败应如实上报");
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

throws(() => spawnStaffs.run({ role: "ghost", task: "T" }), /Unknown Pi-Staffs role/);
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
   buildStaffsPrelude({ config: disabled.config, aliases: {}, promptFallback: () => undefined }),
);
throws(() => disabledStaffs.run({ role: "sleepy", task: "T" }), /已停用/);
throws(() => disabledStaffs.run({ role: "nobody", task: "T" }), /Unknown Pi-Staffs role/);
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
assert(trioEntry.candidates.join(",") === "a,b", `候选列表不对：${trioEntry.candidates.join(",")}`);
const alienEntry = preflight.models.find((entry) => entry.model === "zz/none");
assert(alienEntry.candidates.length === 0, "未知 provider 不该编造候选");
const fixerEntry = preflight.models.find((entry) => entry.model === "q/heavy-fixer");
assert(fixerEntry.available === true, "档位模型应在可用列表里被判为可用");
ok("预检：快速失败并列出候选模型（含档位覆盖后的模型）");

rmSync(sandbox, { recursive: true, force: true });

console.log(`smoke ok（${checks.length} 项）：`);
for (const name of checks) console.log(`  - ${name}`);
