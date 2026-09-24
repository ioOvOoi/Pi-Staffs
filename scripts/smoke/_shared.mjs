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
   readdirSync,
   rmSync,
   writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export // scripts/smoke/ 下：仓库根要上两级（单文件时代是 scripts/ 下一级）。
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const sandbox = mkdtempSync(path.join(tmpdir(), "pi-staffs-smoke-"));
export const configPath = path.join(sandbox, "pi-staffs.json");
export const fabricPath = path.join(sandbox, "fabric.json");
writeFileSync(
   fabricPath,
   JSON.stringify({ models: { aliases: { fixer: "p/alias-target" } } }),
);
process.env.PI_STAFFS_CONFIG = configPath;
process.env.PI_STAFFS_FABRIC_CONFIG = fabricPath;
delete process.env.PI_FABRIC_PARENT_RUN;
// 17b/24 节的本地私网 server 是被测对象，默认拒私网会误伤，smoke 内显式放行。
process.env.PI_STAFFS_ALLOW_PRIVATE_FETCH = "1";

export const load = (relative) =>
   import(pathToFileURL(path.join(repo, relative)).href);
export const assert = (condition, message) => {
   if (!condition) throw new Error(`断言失败：${message}`);
};
export const throws = (fn, pattern) => {
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
export const rejects = async (fn, pattern) => {
   try {
      await fn();
   } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      assert(pattern.test(text), `错误文本不匹配：${text}`);
      return;
   }
   throw new Error(`预期抛错但没有：${pattern}`);
};

export const checks = [];
export const ok = (name) => checks.push(name);

// ---------- 桩：宿主 API / 时钟 / 休眠 ----------
let clock = 1_000_000;
export const sleeps = [];

/** sequence 每项：字符串 = 抛出的错误文本；{ error } = 返回带 error 的结果；其余 = 成功。 */
export const makeAgents = (sequence = [], options = {}) => {
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
export const installEnv = (agents) => {
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
export const evaluatePrelude = (prelude) =>
   new Function(`${prelude}\nreturn staffs;`)();

export const readConfigFile = () => JSON.parse(readFileSync(configPath, "utf8"));

// 让领域模块一处拿齐：node 内置只在这里 re-export 一次。
export {
   existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
export { createServer } from "node:http";
export { tmpdir } from "node:os";
export { default as path } from "node:path";
export { fileURLToPath, pathToFileURL } from "node:url";

// 真实 Pi 允许同一事件挂多个处理器（我们自己的钩子与 prelude 注入都挂在 tool_call 上），
// 所以桩必须按列表保存并像 SDK 那样把返回值当补丁链式合并，否则「只留最后一个」会骗过测试。
export const hookLists = new Map();
export const hooks = {
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
export const commands = new Map();
export const tools = new Map();
export const notifications = [];
export const ctx = {
   hasUI: false,
   ui: { notify: (text, level) => notifications.push({ text, level }) },
};

/** 用「命令行可见的行为」验证 /staffs：写盘 + 通知。 */
export const runCommand = async (args) => {
   notifications.length = 0;
   await commands.get("staffs").handler(args, ctx);
   return notifications.map((entry) => entry.text).join("\n");
};

/** 跨领域模块的结果袋：core 段产出的 config/prelude 等在这里交接，避免全局变量。 */
export const S = {};
