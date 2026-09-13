/**
 * Pi-Staffs 冒烟测试：不启动 Pi，只把契约钉住。
 *
 * 为什么能这样测：扩展的全部逻辑要么在宿主（配置/校验/prelude 拼装），要么在 guest 内核
 * （src/guest/kernel.js，一段纯 JS）——后者用 new Function + 桩 agents/mesh 就能确定性执行，
 * 这正是「准入超时后换模型」这类韧性行为能在 CI 里被验证的原因。
 *
 * 环境隔离：PI_STAFFS_CONFIG / PI_STAFFS_FABRIC_CONFIG 指向临时目录，
 * 测试绝不碰用户真实的 ~/.pi/agent/pi-staffs.json。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(path.join(tmpdir(), "pi-staffs-smoke-"));
const configPath = path.join(sandbox, "pi-staffs.json");
const fabricPath = path.join(sandbox, "fabric.json");
writeFileSync(
   fabricPath,
   JSON.stringify({ models: { aliases: { fixer: "p/alias-target" } }, configVersion: 4 }),
);
process.env.PI_STAFFS_CONFIG = configPath;
process.env.PI_STAFFS_FABRIC_CONFIG = fabricPath;

delete process.env.PI_FABRIC_PARENT_RUN;

const load = (relative) => import(pathToFileURL(path.join(repo, relative)).href);
const assert = (condition, message) => {
   if (!condition) throw new Error(`断言失败：${message}`);
};

const checks = [];
const ok = (name) => checks.push(name);

/**
 * 把生成的 prelude 当 guest 代码执行，拿回它的 staffs 对象。
 *
 * 为什么允许动态执行：prelude 的目标运行环境是 fabric_exec 沙箱，宿主无法静态调用它；
 * 而「准入超时后换模型」这类韧性行为必须能验证，动态执行自己的生成物是唯一手段（无外部输入）。
 */
const evaluatePrelude = (prelude, agents, mesh) => {
   const factory = new Function("agents", "mesh", `${prelude}\nreturn staffs;`);
   return factory(agents, mesh);
};

// ---------- 1. 装载契约 ----------
const mod = await load("src/index.ts");
const commands = new Map();
const handlers = new Map();
mod.default({
   registerCommand: (name, options) => commands.set(name, options),
   on: (event, handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
   },
});
assert(commands.has("staffs"), "未注册 /staffs 命令");
assert(typeof commands.get("staffs").handler === "function", "/staffs 缺少 handler");
assert(handlers.has("tool_call"), "未注册 tool_call 注入");
assert(handlers.has("session_start"), "未注册 session_start");
assert(handlers.has("before_agent_start"), "未注册 before_agent_start");
ok("装载：注册了 /staffs + 三个事件钩子");

// ---------- 2. session_start 生成配置 ----------
let notices = [];
const ctx = { ui: { notify: (message, level) => notices.push(`${level}: ${message}`) } };
await handlers.get("session_start")[0]({}, ctx);
assert(existsSync(configPath), "session_start 未生成配置文件");
let bootstrapped;
try {
   bootstrapped = JSON.parse(readFileSync(configPath, "utf8"));
} catch (error) {
   throw new Error(`session_start 生成的配置不是合法 JSON：${error}`);
}
assert(Object.keys(bootstrapped.roles).length === 7, "默认角色不是七神祇");
assert(notices.some((line) => line.includes("角色矩阵")), "未提示已生成配置");
ok("session_start：生成七神祇配置并提示");

// ---------- 3. /staffs 命令 ----------
notices = [];
await commands.get("staffs").handler("", ctx);
assert(notices.some((line) => line.includes("orchestrator")), "/staffs 未列出角色");
assert(notices.some((line) => line.includes("xai/grok-4.3")), "/staffs 未列出回退链");
ok("/staffs：列出角色与回退链");

// ---------- 4. fabric_exec 注入 ----------
const toolCall = handlers.get("tool_call")[0];
const injected = { toolName: "fabric_exec", input: { code: "const answer = 42;" } };
toolCall(injected);
assert(injected.input.code.startsWith("// ===== Pi-Staffs prelude"), "未注入 prelude");
assert(injected.input.code.includes("const staffs = {"), "prelude 未定义 staffs");
assert(injected.input.code.trimEnd().endsWith("const answer = 42;"), "注入破坏了原代码");
const untouched = { toolName: "bash", input: { command: "ls" } };
toolCall(untouched);
assert(untouched.input.code === undefined, "污染了非 fabric_exec 调用");
ok("tool_call：只给 fabric_exec 前置注入 prelude");

// ---------- 5. 配置校验与开放形状 ----------
const { validateConfig, loadStaffsConfig, writeStaffsConfig, resolveModelRef, resolveChain, readAliases } =
   await load("src/config.ts");
const aliases = readAliases(fabricPath);
assert(aliases.fixer === "p/alias-target", "别名表读取错误");
assert(resolveModelRef("fixer", aliases)?.ref === "p/alias-target", "别名解析错误");
assert(resolveModelRef("ollama-cloud/glm-5.3", {})?.provider === "ollama-cloud", "直引解析错误");
assert(resolveModelRef("nope", {}) === undefined, "未知引用应解析失败");
assert(resolveModelRef("ollama-cloud/", {}) === undefined, "空 id 应解析失败");
ok("resolveModelRef：别名 / 直引 / 非法引用");

const messy = {
   configVersion: 1,
   dispatch: { primaryRole: "ghost" },
   roles: {
      fixer: {
         model: "p/a",
         thinking: "nope",
         tools: "read",
         mode: "subagent",
         fallbacks: ["p/b", "broken"],
         custom: { keep: true },
      },
   },
};
const validated = validateConfig(messy, {});
assert(validated.issues.some((issue) => issue.includes("thinking")), "未报 thinking 非法");
assert(validated.issues.some((issue) => issue.includes("tools")), "未报 tools 类型错");
assert(validated.issues.some((issue) => issue.includes("unknown") || issue.includes("broken")), "未报 fallback 无法解析");
assert(validated.issues.some((issue) => issue.includes("primaryRole")), "未报 primaryRole 指向不存在角色");
assert(validated.config.roles.fixer.custom.keep === true, "校验吃掉了开放形状字段");
assert(validated.config.dispatch.attemptsPerModel === 2, "未补齐 dispatch 默认值");
ok("validateConfig：逐字段报问题且保留开放形状");

const written = loadStaffsConfig({ path: path.join(sandbox, "round-trip.json"), aliasesPath: fabricPath });
written.config.roles.fixer.custom = { keep: true };
writeStaffsConfig(written.config, written.path);
const reloaded = loadStaffsConfig({ path: written.path, aliasesPath: fabricPath });
assert(reloaded.config.roles.fixer.custom.keep === true, "原子写丢失开放形状字段");
assert(resolveChain(reloaded.config, "fixer", {}).length === 4, "回退链长度不对");
writeFileSync(written.path, "{ broken json");
const brokenOutcome = loadStaffsConfig({ path: written.path, aliasesPath: fabricPath });
assert(brokenOutcome.issues.length === 1, "坏 JSON 未提示");
assert(readFileSync(written.path, "utf8") === "{ broken json", "坏 JSON 被覆盖了");
ok("load/save：原子写往返、坏 JSON 不覆盖");

// ---------- 6. guest 内核：回退链 / 退避 / 健康 ----------
const { buildStaffsPrelude, readRolePrompt } = await load("src/prelude.ts");
const kernelSource = readFileSync(path.join(repo, "src/guest/kernel.js"), "utf8");
const testConfig = validateConfig(
   {
      configVersion: 1,
      dispatch: { primaryRole: "fixer", attemptsPerModel: 2, backoffBaseMs: 1000, backoffCapMs: 5000 },
      roles: {
         fixer: {
            model: "p/a",
            thinking: "high",
            mode: "subagent",
            tools: ["read", "edit"],
            fallbacks: ["p/b", "q/c"],
         },
         solo: { model: "p/a", thinking: "low", mode: "subagent", tools: ["read"] },
         duo: { model: "p/a", thinking: "low", mode: "subagent", tools: ["read"], fallbacks: ["p/b"] },
         probe: {
            model: "p/zzz",
            thinking: "low",
            mode: "subagent",
            tools: ["read"],
            fallbacks: ["q/c"],
         },
      },
   },
   {},
).config;

const buildGuest = (options = {}) => {
   const prelude = buildStaffsPrelude({
      config: testConfig,
      aliases: {},
      kernel: kernelSource,
      promptFallback: () => undefined,
      ...options,
   });
   return (agents, mesh) => evaluatePrelude(prelude, agents, mesh);
};

let clock = 1_000_000;
const sleeps = [];
const makeMesh = (seed = {}) => {
   const store = new Map(Object.entries(seed));
   return {
      store,
      async list({ prefix } = {}) {
         return [...store.entries()]
            .filter(([key]) => !prefix || key.startsWith(prefix))
            .map(([key, value]) => ({ key, value, version: 1 }));
      },
      async put({ key, value }) {
         store.set(key, value);
         return { key, value, version: store.size };
      },
   };
};
const useEnv = (agentsStub, meshStub) => {
   globalThis.__staffsEnv = {
      agents: agentsStub,
      mesh: meshStub,
      now: () => clock,
      sleep: async (ms) => {
         sleeps.push(ms);
         clock += ms;
      },
      random: () => 0.5,
   };
};

// 6a. 准入超时 → 同模型重试 → 429 → 换 provider → 成功
sleeps.length = 0;
const calls = [];
const failingAgents = {
   async run(request) {
      calls.push(request);
      if (request.model === "p/a") throw new Error("RPC admission timed out; task was not sent");
      if (request.model === "p/b") throw new Error("429 Too Many Requests (retry-after: 2)");
      return { text: "done", error: undefined };
   },
   async spawn(request) {
      calls.push(request);
      return { id: "child-1", model: request.model, status: "running" };
   },
};
const mesh = makeMesh();
useEnv(failingAgents, mesh);
const staffs = buildGuest()(failingAgents, mesh);
const resilient = await staffs.run({ role: "fixer", task: "把 A 改成 B", model: "sneaky/x", cwd: "C:/tmp" });
assert(resilient.ok === true, "回退链未能成功");
assert(
   calls.map((call) => call.model).join(",") === "p/a,p/a,p/b,p/b,q/c",
   `换模型序列不对：${calls.map((call) => call.model).join(",")}`,
);
assert(calls.every((call) => call.thinking === "high"), "未强制角色的 thinking");
assert(calls.every((call) => call.tools.join(",") === "read,edit"), "未强制角色的 tools");
assert(calls.every((call) => call.cwd === "C:/tmp"), "未透传额外 Fabric 参数");
assert(calls[0].model === "p/a", "调用方传入的 model 竟然生效了（中心化强制失败）");
const kinds = resilient.attempts.map((attempt) => attempt.kind).join(",");
assert(
   kinds === "admission,backoff,admission,rateLimit,backoff,rateLimit,ok",
   `attempts 相位不对：${kinds}`,
);
// 每个模型内部的两次尝试之间退避一次；换模型（不同 provider）不再额外等待。
assert(sleeps.length === 2, `退避次数不对：${JSON.stringify(sleeps)}`);
assert(sleeps[0] >= 1000, `首次退避应不小于基准：${JSON.stringify(sleeps)}`);
assert(sleeps[1] >= 2000, `Retry-After 未被尊重：${JSON.stringify(sleeps)}`);
const healthTable = await staffs.health();
assert(healthTable["p/a"].failures === 2, "准入失败未记账");
assert(healthTable["p/b"].cooldownUntil > clock, "429 未进冷却");
// 成功也要落一条（failures 0）——它负责把之前进过冷却的模型清出来。
assert(healthTable["q/c"].failures === 0 && healthTable["q/c"].cooldownUntil === 0, "成功未清零健康条目");
ok("内核：准入超时重试 → 429 换模型 → 成功，且记账");

// 6b. 冷却中的头号模型被跳过
const coolingMesh = makeMesh({
   "pi-staffs:health:p/a": { failures: 3, cooldownUntil: clock + 60_000, updatedAt: clock },
});
useEnv(failingAgents, coolingMesh);
const skipStaffs = buildGuest()(failingAgents, coolingMesh);
const skipped = await skipStaffs.run({ role: "fixer", task: "t" });
assert(skipped.ok === true, "冷却跳过后应仍然出活");
assert(skipped.attempts[0].kind === "cooldown", "未记录冷却跳过");
assert(skipped.attempts[0].model === "p/a", "冷却跳过的模型不对");
ok("内核：冷却中的模型被跳过（且不直接失败）");

// 6c. 模型不可用 → 同模型不重试，直接换
sleeps.length = 0;
const unavailableCalls = [];
useEnv(
   {
      async run(request) {
         unavailableCalls.push(request.model);
         throw new Error("unknown model: p/a");
      },
   },
   makeMesh(),
);
const soloStaffs = evaluatePrelude(
   buildStaffsPrelude({ config: testConfig, aliases: {}, kernel: kernelSource, promptFallback: () => undefined }),
   globalThis.__staffsEnv.agents,
   globalThis.__staffsEnv.mesh,
);
const soloResult = await soloStaffs.run({ role: "solo", task: "t" });
assert(soloResult.ok === false, "不可用模型应失败");
assert(soloResult.kind === "unavailable", `类别不对：${soloResult.kind}`);
assert(unavailableCalls.length === 1, `不可用模型不该重试：${unavailableCalls.length}`);
assert(sleeps.length === 0, "不可用不该退避");
ok("内核：模型不可用 = 不重试不等待");

// 6d. 真任务失败 → 不重试也不换模型（保护备胎）
const hardCalls = [];
useEnv(
   {
      async run(request) {
         hardCalls.push(request.model);
         throw new Error("TypeError: cannot read properties of undefined");
      },
   },
   makeMesh(),
);
const hardStaffs = buildGuest()(globalThis.__staffsEnv.agents, globalThis.__staffsEnv.mesh);
const hardResult = await hardStaffs.run({ role: "duo", task: "t" });
assert(hardResult.ok === false, "真失败应失败");
assert(hardResult.kind === "other", `类别不对：${hardResult.kind}`);
assert(hardCalls.length === 1, `真失败竟然换了模型：${JSON.stringify(hardCalls)}`);
ok("内核：真任务失败不重试、不烧备胎");

// 6e. 未知角色 / 空 task / 停用角色
await assert_rejects(() => hardStaffs.run({ role: "ghost", task: "t" }), "Unknown Pi-Staffs role");
await assert_rejects(() => hardStaffs.run({ role: "fixer", task: "  " }), "非空 task");
await assert_rejects(() => hardStaffs.run({ model: "x/y" }), "需要非空 task");
ok("内核：未知角色 / 空 task 都会被拒绝");

async function assert_rejects(fn, needle) {
   let message = "";
   try {
      await fn();
   } catch (error) {
      message = error instanceof Error ? error.message : String(error);
   }
   assert(message.includes(needle), `预期错误含「${needle}」，实际：${message || "(未抛错)"}`);
}

// 6f. spawn 分支返回句柄
const spawned = await (async () => {
   useEnv(failingAgents, makeMesh());
   const instance = buildGuest()(globalThis.__staffsEnv.agents, globalThis.__staffsEnv.mesh);
   return instance.spawn({ role: "solo", task: "后台干活" });
})();
assert(spawned.ok === true && spawned.handle?.id === "child-1", "spawn 未回传句柄");
ok("内核：spawn 走 agents.spawn 并回传句柄");

// 6g. 角色提示注入（内置 prompts/<role>.md）
const prompt = readRolePrompt("fixer");
assert(typeof prompt === "string" && prompt.includes("规范"), "内置角色提示缺失");
const promptCalls = [];
useEnv(
   {
      async run(request) {
         promptCalls.push(request.task);
         return { text: "ok" };
      },
   },
   makeMesh(),
);
const promptStaffs = evaluatePrelude(
   buildStaffsPrelude({ config: testConfig, aliases: {}, kernel: kernelSource }),
   globalThis.__staffsEnv.agents,
   globalThis.__staffsEnv.mesh,
);
await promptStaffs.run({ role: "fixer", task: "把 A 改成 B" });
assert(promptCalls[0].includes("Task:\n把 A 改成 B"), `角色提示未与任务合并：${promptCalls[0]}`);
assert(promptCalls[0].includes("fixer"), "角色提示未注入（取的是 prompts/fixer.md）");
ok("prelude：角色提示与任务合并");

// 6h. 预检：坏引用快速失败并给出候选
const preflightAgents = {
   async models() {
      return [
         { provider: "p", id: "a" },
         { provider: "p", id: "b" },
         { provider: "p", id: "z" },
      ];
   },
};
useEnv(preflightAgents, makeMesh());
const preflightStaffs = evaluatePrelude(
   buildStaffsPrelude({ config: testConfig, aliases: {}, kernel: kernelSource, promptFallback: () => undefined }),
   preflightAgents,
   globalThis.__staffsEnv.mesh,
);
const preflight = await preflightStaffs.preflight(["probe"]);
assert(preflight.ok === false, "预检应发现坏引用");
assert(
   preflight.missing.includes("p/zzz") && preflight.missing.includes("q/c"),
   `缺失列表不对：${JSON.stringify(preflight.missing)}`,
);
const zz = preflight.models.find((entry) => entry.model === "p/zzz");
assert(zz.candidates.join(",") === "a,b,z", `同 provider 候选列表不对：${JSON.stringify(zz.candidates)}`);
const qc = preflight.models.find((entry) => entry.model === "q/c");
assert(Array.isArray(qc.candidates) && qc.candidates.length === 0, "未知 provider 不该编造候选");
ok("内核：预检快速失败并列出候选模型");

rmSync(sandbox, { recursive: true, force: true });
console.log(`smoke ok（${checks.length} 项）：`);
for (const name of checks) console.log(`  - ${name}`);
