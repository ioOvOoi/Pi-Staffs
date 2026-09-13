import {
   isToolCallEventType,
   type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
   activePresetName,
   fabricConfigPath,
   loadStaffsConfig,
   readAliases,
   resolveModelRef,
   resolveRole,
   writeStaffsConfig,
   type StaffsConfig,
} from "./config.ts";
import { buildStaffsPrelude, readRolePrompt } from "./prelude.ts";

export const PI_STAFFS_VERSION = "0.1.0";

/**
 * 派发指引（写进 system prompt）。为什么必须显式写：子 agent 只看到父会话传来的 task，
 * 不知道 staffs.* 存在就会退回「自己写代码」；role-router 的实测经验是这句指引不可省。
 */
const DISPATCH_GUIDANCE = [
   "Pi-Staffs 编排：在 fabric_exec 里用 staffs.run({ role, task }) 或 staffs.spawn({ role, task }) 派发子 agent（省略 role 用 dispatch.primaryRole）。",
   "另有 staffs.list() / staffs.describe(role) / staffs.preset() / staffs.preflight(roles)；切档位用 /staffs preset <名字>。",
   "不要在派发点传 model / thinking / tools——模型由当前档位（preset）决定，thinking 与 tools 由角色矩阵集中强制；返回值 attempts 记录了每次重试与退避。",
].join("\n");

/** 一行展示某个角色在当前档位下的实际模型（HOST 侧解释别名，guest 侧只看解析结果）。 */
const describeRole = (
   config: StaffsConfig,
   aliases: Record<string, string>,
   name: string,
): string => {
   const role = resolveRole(config, name);
   if (!role) return `${name}: （无效角色）`;
   const resolved = resolveModelRef(role.model, aliases);
   const shown = resolved ? resolved.ref : `无法解析：${String(role.model)}`;
   const disabled = role.enabled === false ? "（停用）" : "";
   return `${name}${disabled}: ${shown} · thinking ${role.thinking} · mode ${role.mode}`;
};

/**
 * Pi-Staffs 唯一入口。
 *
 * 三条事件分工（照抄 role-router 已验证的注入方式）：
 *  - session_start：加载/生成 ~/.pi/agent/pi-staffs.json，把问题一次性提示清楚；
 *  - tool_call：给 fabric_exec 代码前置注入 prelude（guest 侧才有 staffs.*）；
 *  - before_agent_start：把派发指引写进 system prompt。
 */
export default function piStaffs(pi: ExtensionAPI): void {
   let cache: { config: StaffsConfig; path: string } | undefined;

   /** 缓存一份配置，避免每次 fabric_exec 都读盘；/staffs 与 session_start 会刷新它。 */
   const snapshot = (): { config: StaffsConfig; path: string } => {
      cache ??= (({ config, path }) => ({ config, path }))(loadStaffsConfig());
      return cache;
   };

   pi.on("session_start", async (_event, ctx) => {
      const outcome = loadStaffsConfig();
      cache = { config: outcome.config, path: outcome.path };
      if (outcome.created) {
         ctx.ui.notify(
            `Pi-Staffs 已生成角色矩阵 ${outcome.path}（${Object.keys(outcome.config.roles).length} 个角色，档位 ${activePresetName(outcome.config) || "无"}）。用 /staffs 查看。`,
            "info",
         );
      }
      for (const issue of outcome.issues)
         ctx.ui.notify(`Pi-Staffs 配置：${issue}`, "warning");
   });

   pi.on("tool_call", (event) => {
      if (
         !isToolCallEventType("fabric_exec", event) ||
         typeof event.input.code !== "string"
      )
         return;
      const { config } = snapshot();
      event.input.code = `${buildStaffsPrelude({ config, promptFallback: readRolePrompt })}\n${event.input.code}`;
   });

   pi.on("before_agent_start", (event) => {
      if (process.env.PI_FABRIC_PARENT_RUN) return;
      return { systemPrompt: `${event.systemPrompt}\n\n${DISPATCH_GUIDANCE}` };
   });

   pi.registerCommand("staffs", {
      description: "Pi-Staffs：角色矩阵与模型档位（preset）",
      handler: async (args, ctx) => {
         const requested = String(args ?? "").trim();
         const outcome = loadStaffsConfig();
         cache = { config: outcome.config, path: outcome.path };
         const { config, path } = outcome;
         const available = Object.keys(config.presets ?? {});

         if (requested === "preset" || requested.startsWith("preset ")) {
            const name = requested.slice("preset".length).trim();
            if (!name) {
               ctx.ui.notify(
                  `Pi-Staffs 档位：${activePresetName(config) || "（无：各角色用基线模型）"}\n可用：${available.join(", ") || "（空）"}\n切换：/staffs preset <名字>`,
                  "info",
               );
               return;
            }
            if (!config.presets?.[name]) {
               ctx.ui.notify(
                  `Pi-Staffs 没有档位 ${name}；可用：${available.join(", ") || "（空）"}`,
                  "warning",
               );
               return;
            }
            const next: StaffsConfig = { ...config, preset: name };
            writeStaffsConfig(next, path);
            cache = { config: next, path };
            // 与 omo-slim 的差异：它必须 reload（agent 注册表在宿主里），我们的注入每轮读缓存，
            // 所以本会话后续派发即刻生效；正在跑的子 agent 不受影响（它们的角色在派发时已定型）。
            ctx.ui.notify(
               `Pi-Staffs 已切到档位 ${name}（本会话后续派发生效；正在运行的子 agent 不受影响）`,
               "info",
            );
            return;
         }

         const aliases = readAliases(fabricConfigPath());
         const lines = Object.keys(config.roles).map((name) =>
            describeRole(config, aliases, name),
         );
         ctx.ui.notify(
            `Pi-Staffs ${PI_STAFFS_VERSION} — ${path}\n档位：${activePresetName(config) || "（无）"}｜可用：${available.join(", ") || "（空）"}\n${lines.join("\n")}\n派发：fabric_exec 里 staffs.run({ role, task })；切档位：/staffs preset <名字>`,
            "info",
         );
         for (const issue of outcome.issues)
            ctx.ui.notify(`Pi-Staffs 配置：${issue}`, "warning");
      },
   });
}
