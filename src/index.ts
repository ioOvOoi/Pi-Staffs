import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fabricConfigPath, loadStaffsConfig, readAliases, resolveChain, type StaffsConfig } from "./config.ts";
import { buildStaffsPrelude, readRolePrompt } from "./prelude.ts";

export const PI_STAFFS_VERSION = "0.1.0";

/**
 * 派发指引（写进 system prompt）。为什么必须显式写：子 agent 只看到父会话传来的 task，
 * 不知道 staffs.* 存在就会退回「自己写代码」；role-router 的实测经验是这句指引不可省。
 */
const DISPATCH_GUIDANCE = [
   "Pi-Staffs 编排：在 fabric_exec 里用 staffs.run({ role, task }) 或 staffs.spawn({ role, task }) 派发子 agent（省略 role 用 dispatch.primaryRole）。",
   "另有 staffs.list() / staffs.describe(role) / staffs.preflight(roles) / staffs.health()。",
   "不要在派发点传 model / thinking / tools——角色矩阵集中强制；返回值里 attempts 记录了每次换模型与退避的原因。",
].join("\n");

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
      if (!cache) {
         const outcome = loadStaffsConfig();
         cache = { config: outcome.config, path: outcome.path };
      }
      return cache;
   };

   const setCache = (outcome: { config: StaffsConfig; path: string }): void => {
      cache = { config: outcome.config, path: outcome.path };
   };

   pi.on("session_start", async (_event, ctx) => {
      const outcome = loadStaffsConfig();
      setCache(outcome);
      if (outcome.created) {
         ctx.ui.notify(
            `Pi-Staffs 已生成角色矩阵 ${outcome.path}（${Object.keys(outcome.config.roles).length} 个角色）。用 /staffs 查看。`,
            "info",
         );
      }
      for (const issue of outcome.issues) ctx.ui.notify(`Pi-Staffs 配置：${issue}`, "warning");
   });

   pi.on("tool_call", (event) => {
      if (!isToolCallEventType("fabric_exec", event) || typeof event.input.code !== "string") return;
      const { config } = snapshot();
      event.input.code = `${buildStaffsPrelude({ config, promptFallback: readRolePrompt })}\n${event.input.code}`;
   });

   pi.on("before_agent_start", (event) => {
      if (process.env.PI_FABRIC_PARENT_RUN) return;
      return { systemPrompt: `${event.systemPrompt}\n\n${DISPATCH_GUIDANCE}` };
   });

   pi.registerCommand("staffs", {
      description: "Pi-Staffs：角色矩阵、回退链与配置文件",
      handler: async (_args, ctx) => {
         const outcome = loadStaffsConfig();
         setCache(outcome);
         const aliases = readAliases(fabricConfigPath());
         const lines = Object.entries(outcome.config.roles).map(([name, role]) => {
            const chain = resolveChain(outcome.config, name, aliases);
            const shown = chain.length > 0 ? chain.join(" → ") : `无法解析：${role.model}`;
            const disabled = role.enabled === false ? "（停用）" : "";
            return `${name}${disabled}: ${shown} · thinking ${role.thinking} · mode ${role.mode}`;
         });
         ctx.ui.notify(
            `Pi-Staffs ${PI_STAFFS_VERSION} — ${outcome.path}\n${lines.join("\n")}\n派发：fabric_exec 里 staffs.run({ role, task })`,
            "info",
         );
         for (const issue of outcome.issues) ctx.ui.notify(`Pi-Staffs 配置：${issue}`, "warning");
      },
   });
}
