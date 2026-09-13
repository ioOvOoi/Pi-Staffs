/**
 * 生成注入到 fabric_exec 代码之前的 prelude。
 *
 * 为什么用「注入代码字符串」而不是注册一个 Fabric 工具：pi-fabric 只给了扩展
 * pi.on("tool_call") 这一个入口（role-router 0.4.1 的做法，票 02 逐行读过），
 * 注入的代码与用户的 fabric_exec 代码同一作用域，所以能直接拿到宿主声明的 agents/mesh。
 *
 * 注入的代码一律是 JS（不是 TS）：宿主冒烟测试把整段 prelude 丢进 new Function 执行，
 * 一旦掺入类型注解，测试就再也跑不起来——那是我们唯一能在不启动 Pi 的情况下验证韧性的手段。
 *
 * 档位（D23）在宿主侧就算完：guest 只拿到「角色 → 最终模型」的解析结果，不需要认识别名表。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
   activePresetName,
   readAliases,
   resolveCouncilModels,
   resolveModelRef,
   resolveRole,
   type CouncilConfig,
   type StaffsConfig,
} from "./config.ts";
import { checkRolePermissions, readPermissions } from "./permissions.ts";

const kernelPath = fileURLToPath(new URL("./guest/kernel.js", import.meta.url));
let cachedKernel: string | undefined;

/** guest 内核源码（懒读 + 缓存；注入是每轮 fabric_exec 都要做的热路径）。 */
export const guestKernelSource = (): string => {
   cachedKernel ??= readFileSync(kernelPath, "utf8");
   return cachedKernel;
};

export const promptsDirectory = (): string =>
   fileURLToPath(new URL("../prompts/", import.meta.url));

/** 内置角色提示（D21）：roles[name].instructions 非空则覆盖它。 */
export const readRolePrompt = (role: string): string | undefined => {
   const path = join(promptsDirectory(), `${role}.md`);
   if (!existsSync(path)) return undefined;
   const text = readFileSync(path, "utf8").trim();
   return text || undefined;
};

export type PreludeOptions = {
   config: StaffsConfig;
   aliases?: Record<string, string>;
   kernel?: string;
   promptFallback?: (role: string) => string | undefined;
};

/** 每个角色实际生效的提示：配置里的 instructions 优先，其次内置 prompts/<role>.md。 */
export const effectiveRoleInstructions = (
   config: StaffsConfig,
   promptFallback: (role: string) => string | undefined = readRolePrompt,
): Record<string, string | undefined> => {
   const out: Record<string, string | undefined> = {};
   for (const [name, role] of Object.entries(config.roles)) {
      const configured =
         typeof role.instructions === "string" ? role.instructions.trim() : "";
      out[name] = configured || promptFallback(name);
   }
   return out;
};

/** 合议 synth 的默认指令（票 07）：只做判断与分歧标注，不写代码（D5 单写者）。 */
export const COUNCIL_SYNTH_INSTRUCTIONS = [
   "你是合议的汇总者。下面给出多个模型对同一问题的独立回答。",
   "输出格式（严格）：1) 合成答案（可直接落地）2) 各模型立场一句话摘要 3) 明确分歧点（没有就写「无」）4) 置信度提示（高/中/低 + 为什么）。",
   "只做判断，不要写文件、不要执行命令。",
].join("\n");

export const buildStaffsPrelude = (options: PreludeOptions): string => {
   const { config } = options;
   const aliases = options.aliases ?? readAliases();
   const instructions = effectiveRoleInstructions(
      config,
      options.promptFallback ?? readRolePrompt,
   );
   const roles: Record<string, unknown> = {};
   const models: Record<string, string> = {};
   for (const [name, base] of Object.entries(config.roles)) {
      const resolvedRole = resolveRole(config, name) ?? base;
      const { instructions: _ignored, ...rest } = resolvedRole;
      const resolved = resolveModelRef(rest.model, aliases);
      // 解析不了就留空串：guest 派发时会抛出「检查 model / 档位 / 别名」的明确错误，
      // 而不是把别名原文塞给 agents.run 让它报一个我们看不懂的错。
      models[name] = resolved ? resolved.ref : "";
      roles[name] = {
         ...rest,
         model: resolved ? resolved.ref : rest.model,
         instructions: instructions[name],
      };
   }
   // undefined 的键会被 JSON.stringify 丢掉：guest 端据此区分「配了 maxRetries」与「只有旧字段」。
   const policy = {
      maxRetries: config.dispatch.maxRetries,
      initialRetryDelayMs: config.dispatch.initialRetryDelayMs,
      retryDelayMs: config.dispatch.retryDelayMs,
      attemptsPerModel: config.dispatch.attemptsPerModel ?? 2,
      backoffBaseMs: config.dispatch.backoffBaseMs ?? 1500,
      backoffCapMs: config.dispatch.backoffCapMs ?? 30000,
   };
   const dispatch = {
      primaryRole: config.dispatch.primaryRole ?? Object.keys(config.roles)[0],
      defaultImplementationRole: config.dispatch.defaultImplementationRole,
   };
   const preset = {
      name: activePresetName(config),
      available: Object.keys(config.presets ?? {}),
   };
   // 合议（票 07）：成员与 synth 在宿主解析成最终模型引用，guest 只跑不算。
   const councilConfig: CouncilConfig = config.council ?? {};
   const synthSource = councilConfig.synth ?? config.roles.council?.model;
   const council = {
      models: resolveCouncilModels(config, aliases),
      synthResolved: synthSource
         ? (resolveModelRef(String(synthSource), aliases)?.ref ?? "")
         : "",
      synthInstructions:
         councilConfig.synthInstructions || COUNCIL_SYNTH_INSTRUCTIONS,
      budgetTokens: councilConfig.budgetTokens ?? 200000,
   };
   // 权限矩阵（票 19）：宿主算好判定，guest 在派发点硬拒——越权请求不该走到 agents.run。
   const permissions: Record<string, unknown> = {};
   for (const [name, base] of Object.entries(config.roles)) {
      const role = resolveRole(config, name) ?? base;
      const verdict = checkRolePermissions(name, role);
      permissions[name] = {
         ...readPermissions(role),
         allowed: verdict.allowed,
         reason: verdict.reason,
      };
   }

   return `// ===== Pi-Staffs prelude（自动注入；别依赖下划线开头的内部变量名）=====
const __staffsPreset = ${JSON.stringify(preset)};
const __staffsRoles = ${JSON.stringify(roles)};
const __staffsModels = ${JSON.stringify(models)};
const __staffsDispatch = ${JSON.stringify(dispatch)};
const __staffsPolicyConfig = ${JSON.stringify(policy)};
const __staffsCouncilConfig = ${JSON.stringify(council)};
const __staffsPermissions = ${JSON.stringify(permissions)};
${options.kernel ?? guestKernelSource()}
const __staffsCovers = (list, tool) => Array.isArray(list) && (list.indexOf(tool) >= 0 || list.indexOf("*") >= 0);
const __staffsResolveRole = (request) => {
   const input = request && typeof request === "object" ? request : {};
   const name = typeof input.role === "string" && input.role.trim() ? input.role.trim() : __staffsDispatch.primaryRole;
   const role = __staffsRoles[name];
   if (!role) throw new Error("Unknown Pi-Staffs role: " + String(name) + "（可用：" + Object.keys(__staffsRoles).join(", ") + "）");
   if (role.enabled === false) throw new Error("Pi-Staffs 角色 " + name + " 已停用（enabled: false）");
   const perms = __staffsPermissions[name] || {};
   if (perms.allowed === false)
      throw new Error("Pi-Staffs 拒绝派发角色 " + name + "：" + (perms.reason || "权限矩阵未放行"));
   const { role: __role, instructions, task, ...rest } = input;
   if (typeof task !== "string" || !task.trim()) throw new Error("Pi-Staffs 派发需要非空 task");
   const requested = Array.isArray(rest.tools) ? rest.tools : [];
   const declared = Array.isArray(role.tools) ? role.tools : [];
   const banned = requested.filter((tool) => __staffsCovers(perms.deny, tool));
   const outside = requested.filter(
      (tool) =>
         !__staffsCovers(declared, tool) &&
         !__staffsCovers(perms.allow, tool) &&
         !banned.includes(tool),
   );
   if (banned.length) throw new Error("Pi-Staffs 角色 " + name + " 被禁止使用工具：" + banned.join(", "));
   if (outside.length)
      throw new Error("Pi-Staffs 角色 " + name + " 的 tools 白名单不含：" + outside.join(", "));
   return {
      name,
      role,
      request: { ...rest, thinking: role.thinking, tools: role.tools, ...(role.timeoutMs ? { timeoutMs: role.timeoutMs } : {}) },
      task: __staffsCombine(instructions !== undefined ? instructions : role.instructions, task),
   };
};
const __staffsDispatchRun = (request, spawn) => {
   // 校验同步做（坏角色/越权工具立刻抛），只有真正的派发是异步的：
   // 调用点因此能用 try/catch 区分「参数错」与「上游拒绝」，冒烟测试也钉住了这个语义。
   const resolved = __staffsResolveRole(request);
   return __staffsRun({
      host: __staffsHost(),
      model: __staffsModels[resolved.name] || "",
      task: resolved.task,
      request: resolved.request,
      policy: __staffsPolicyConfig,
      spawn: spawn === true,
      // 补上角色与稳定 id：宿主据此把尝试落到看板（票 09/12），模型也能引用单条尝试。
   }).then((receipt) => ({
      ...receipt,
      role: resolved.name,
      attempts: (receipt.attempts || []).map((attempt) => ({
         ...attempt,
         role: resolved.name,
         id: resolved.name + ":" + attempt.model + ":" + attempt.at + ":" + attempt.attempt,
      })),
   }));
};
const staffs = {
   list: () => Object.keys(__staffsRoles),
   preset: () => ({ active: __staffsPreset.name, available: __staffsPreset.available.slice() }),
   describe: (role) => {
      const found = __staffsRoles[role];
      if (!found) throw new Error("Unknown Pi-Staffs role: " + String(role) + "（可用：" + Object.keys(__staffsRoles).join(", ") + "）");
      return { name: role, ...found, model: __staffsModels[role] || found.model };
   },
   preflight: (roles) => __staffsPreflight(__staffsHost(), __staffsModels, roles),
   preflightCouncil: () => {
      const map = {};
      (__staffsCouncilConfig.models || []).forEach((ref, index) => {
         map["council-" + index] = ref;
      });
      if (__staffsCouncilConfig.synthResolved) map["council-synth"] = __staffsCouncilConfig.synthResolved;
      return __staffsPreflight(__staffsHost(), map);
   },
   run: (request) => __staffsDispatchRun(request, false),
   spawn: (request) => __staffsDispatchRun(request, true),
   // 合议（票 07）：模型清单与 synth 指令都由宿主解析好，guest 只负责并发跑与记账。
   council: (request) => {
      const input = request && typeof request === "object" ? request : {};
      const { task, ...rest } = input;
      if (typeof task !== "string" || !task.trim())
         throw new Error("Pi-Staffs council 需要非空 task");
      const configured = Array.isArray(__staffsCouncilConfig.models) ? __staffsCouncilConfig.models : [];
      const models = (Array.isArray(rest.models) && rest.models.length ? rest.models : configured)
         .map((name) => __staffsModels[name] || name)
         .filter((name, index, all) => typeof name === "string" && name.trim() && all.indexOf(name) === index);
      return __staffsCouncil({
         host: __staffsHost(),
         models,
         synthModel: rest.synth ? (__staffsModels[rest.synth] || rest.synth) : __staffsCouncilConfig.synthResolved,
         synthInstructions: rest.instructions || __staffsCouncilConfig.synthInstructions,
         budgetTokens: rest.budgetTokens || __staffsCouncilConfig.budgetTokens,
         task: __staffsCombine(undefined, task),
         request: rest,
         policy: __staffsPolicyConfig,
      });
   },
   // 任务句柄族（票 16）走 Fabric 的 agents API：steer 改指令、stop 取消、resume 续跑。
   task: (op, ...args) => __staffsTaskCall(__staffsHost(), op, args),
   // 第三个参数是派发闭包：内核只负责「要不要复活」的判定，怎么拉起由 prelude 决定。
   revive: (request) =>
      __staffsRevive(__staffsHost(), request, (input, spawn) =>
         __staffsDispatchRun(input, spawn === true),
      ),
};
// ===== Pi-Staffs prelude end =====`;
};
