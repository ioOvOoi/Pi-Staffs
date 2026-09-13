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
   resolveModelRef,
   resolveRole,
   type StaffsConfig,
} from "./config.ts";

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
   const policy = {
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

   return `// ===== Pi-Staffs prelude（自动注入；别依赖下划线开头的内部变量名）=====
const __staffsPreset = ${JSON.stringify(preset)};
const __staffsRoles = ${JSON.stringify(roles)};
const __staffsModels = ${JSON.stringify(models)};
const __staffsDispatch = ${JSON.stringify(dispatch)};
const __staffsPolicyConfig = ${JSON.stringify(policy)};
${options.kernel ?? guestKernelSource()}
const __staffsResolveRole = (request) => {
   const input = request && typeof request === "object" ? request : {};
   const name = typeof input.role === "string" && input.role.trim() ? input.role.trim() : __staffsDispatch.primaryRole;
   const role = __staffsRoles[name];
   if (!role) throw new Error("Unknown Pi-Staffs role: " + String(name) + "（可用：" + Object.keys(__staffsRoles).join(", ") + "）");
   if (role.enabled === false) throw new Error("Pi-Staffs 角色 " + name + " 已停用（enabled: false）");
   const { role: __role, instructions, task, ...rest } = input;
   if (typeof task !== "string" || !task.trim()) throw new Error("Pi-Staffs 派发需要非空 task");
   return {
      name,
      role,
      request: { ...rest, thinking: role.thinking, tools: role.tools, ...(role.timeoutMs ? { timeoutMs: role.timeoutMs } : {}) },
      task: __staffsCombine(instructions !== undefined ? instructions : role.instructions, task),
   };
};
const __staffsDispatchRun = (request, spawn) => {
   const resolved = __staffsResolveRole(request);
   return __staffsRun({
      host: __staffsHost(),
      model: __staffsModels[resolved.name] || "",
      task: resolved.task,
      request: resolved.request,
      policy: __staffsPolicyConfig,
      spawn: spawn === true,
   });
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
   run: (request) => __staffsDispatchRun(request, false),
   spawn: (request) => __staffsDispatchRun(request, true),
};
// ===== Pi-Staffs prelude end =====`;
};
