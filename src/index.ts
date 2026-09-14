import {
   isToolCallEventType,
   type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
   PANEL_MODES,
   activePresetName,
   fabricConfigPath,
   loadStaffsConfig,
   readAliases,
   resolveCouncilModels,
   resolveModelRef,
   resolveRole,
   writeStaffsConfig,
   type PanelMode,
   type StaffsConfig,
} from "./config.ts";
import { buildStaffsPrelude, readRolePrompt } from "./prelude.ts";
import { extractReceipts, recordReceipts } from "./attempts.ts";
import { buildTurnInjection, registerStaffsHooks } from "./hooks.ts";
import { formatDoctorReport, registerStaffsTools } from "./tools.ts";
import { listStaffsSkills, syncStaffsSkills } from "./skills.ts";
import {
   footerSummary,
   formatBoard,
   formatPanel,
   readState,
   type StaffsState,
} from "./state.ts";

export const PI_STAFFS_VERSION = "1.1.1";

/**
 * 派发指引（写进 system prompt）。为什么必须显式写：子 agent 只看到父会话传来的 task，
 * 不知道 staffs.* 存在就会退回「自己写代码」；role-router 的实测经验是这句指引不可省。
 */
const DISPATCH_GUIDANCE = [
   "Pi-Staffs 编排：在 fabric_exec 里用 staffs.run({ role, task }) 或 staffs.spawn({ role, task }) 派发子 agent（省略 role 用 dispatch.primaryRole）。",
   "多模型合议用 staffs.council({ task })（先 staffs.preflightCouncil() 预检）；切档位用 /staffs preset <名字>。",
   "团队协作：staffs_board 看看板、staffs_goal 记目标与验收标准、staffs_task 管 DAG、staffs_mail 传话、staffs_ticket 收发 tracker 票。",
   "不要在派发点传 model / thinking / tools——模型由当前档位（preset）决定，thinking 与 tools 由角色矩阵集中强制；返回值 attempts 记录了每次重试与退避。",
   "写操作保持单写者（D5）：读可以并行，写要串行或放进 staffs_worktree 隔离区。",
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
 *  - tool_call：把 prelude 挂到 fabric_exec 的 prelude 入参（guest 侧才有 staffs.*）；
 *  - before_agent_start：把派发指引写进 system prompt。
 */
export default function piStaffs(pi: ExtensionAPI): void {
   let cache: { config: StaffsConfig; path: string } | undefined;
   let announce:
      | ((message: string, level?: "info" | "warning" | "error") => void)
      | undefined;
   /**
    * 读看板状态。**每次重读**：工具（staffs_task / staffs_mail …）与 guest 回执都各自直接写同一个
    * 文件，缓存一份就会读到旧值；文件只有几 KB，重读的代价远小于「看板与现实不一致」。
    */
   const board = (): StaffsState => readState();

   /** 缓存一份配置，避免每次 fabric_exec 都读盘；/staffs 与 session_start 会刷新它。 */
   const snapshot = (): { config: StaffsConfig; path: string } => {
      cache ??= (({ config, path }) => ({ config, path }))(loadStaffsConfig());
      return cache;
   };

   /** 工具与钩子在这里接线：宿主侧能力（文件/网络/git/UI）都注册给模型直接调。 */
   registerStaffsTools(pi, {
      tracker: () => {
         const tracker = snapshot().config.tracker;
         return {
            kind: tracker.kind,
            repo: tracker.repo,
            directory: tracker.directory,
         };
      },
   });
   registerStaffsHooks(pi, {
      notify: (message, level) => announce?.(message, level),
   });

   pi.on("session_start", async (_event, ctx) => {
      announce = (message, level) => ctx.ui.notify(message, level ?? "info");
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
      // prelude 挂到入参而不是拼进 code（pi-fabric ≥ 0.93.0）：门禁与源映射都归宿主，模型的
      // 代码一个字都不动。过去拼字符串时，prelude 里任何类型错误都会以模型代码的行号报出来，
      // 并把整条 fabric_exec 通道一起拒掉（见本仓 67ae6d5 的实机故障）。
      event.input.prelude = buildStaffsPrelude({
         config,
         promptFallback: readRolePrompt,
      });
   });

   pi.on("before_agent_start", (event) => {
      if (process.env.PI_FABRIC_PARENT_RUN) return;
      // 看板与提醒只在有内容时注入：空标题也会改前缀、打掉 prompt cache（票 20）。
      const injection = buildTurnInjection(board());
      const suffix = injection
         ? DISPATCH_GUIDANCE + "\n\n" + injection
         : DISPATCH_GUIDANCE;
      return { systemPrompt: `${event.systemPrompt}\n\n${suffix}` };
   });

   /**
    * 派发回执采集：guest 用 marker 标注结果，宿主在这里认领并落盘。
    * 认不出就返回 undefined（不修改结果）——看板是助力，不该改动模型看到的内容。
    */
   pi.on("tool_result", (event) => {
      if (event.toolName !== "fabric_exec") return;
      const text = (event.content ?? [])
         .map((part) => (part.type === "text" ? String(part.text ?? "") : ""))
         .join("\n");
      if (!text.includes("pi-staffs/attempts/v1")) return;
      const receipts = extractReceipts(text);
      if (receipts.length) recordReceipts(receipts, { owner: "host" });
      return;
   });

   pi.on("session_shutdown", () => {
      announce = undefined;
   });

   pi.on("turn_end", (_event, ctx) => {
      // 观测层（票 15）：footer 只放「需要人管」的数字，widget 放整块看板；两种形态同源（state.ts），
      // 所以不会互相矛盾。面板零写入——只渲染状态文件，是观测层不是第二真相源（D13）。
      const state = board();
      const mode = snapshot().config.panel ?? "footer";
      if (mode === "off") {
         ctx.ui?.setStatus("pi-staffs", undefined);
         ctx.ui?.setWidget?.("pi-staffs", undefined);
         return;
      }
      ctx.ui?.setStatus("pi-staffs", footerSummary(state));
      if (mode === "widget") {
         const lines = formatPanel(state, { maxTasks: 8 });
         ctx.ui?.setWidget?.("pi-staffs", lines.length ? lines : undefined);
      }
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

         if (requested === "skills" || requested.startsWith("skills ")) {
            const skills = listStaffsSkills();
            if (requested.slice("skills".length).trim() === "sync") {
               const result = syncStaffsSkills();
               ctx.ui.notify(
                  `已同步 ${result.copied.length} 个技能到 ${result.target}：${result.copied.join(", ")}`,
                  "info",
               );
               return;
            }
            ctx.ui.notify(
               `Pi-Staffs 技能（随包自动发现，无需同步）：${skills.map((skill) => skill.name).join(", ") || "（无）"}\n同步到全局目录：/staffs skills sync`,
               "info",
            );
            return;
         }

         if (requested === "panel" || requested.startsWith("panel ")) {
            const mode = requested.slice("panel".length).trim();
            if (!mode) {
               ctx.ui.notify(
                  `Pi-Staffs 观测层：当前 ${config.panel}（footer 一行数字｜widget 常驻面板｜off 关闭）。面板只读，不写状态。`,
                  "info",
               );
               return;
            }
            if (!PANEL_MODES.has(mode)) {
               ctx.ui.notify(
                  `观测层只能选 footer / widget / off，收到：${mode}`,
                  "warning",
               );
               return;
            }
            const next: StaffsConfig = { ...config, panel: mode as PanelMode };
            writeStaffsConfig(next, path);
            cache = { config: next, path };
            ctx.ui.notify(
               `Pi-Staffs 观测层已切到 ${mode}（下一轮生效）`,
               "info",
            );
            return;
         }

         if (requested === "board") {
            const state = board();
            ctx.ui.notify(
               state.attempts.length || state.tasks.length
                  ? formatBoard(state, { maxTasks: 20 })
                  : "（团队空闲：没有进行中的派发，也没有未完成任务）",
               "info",
            );
            return;
         }

         if (requested === "doctor") {
            ctx.ui.notify(
               formatDoctorReport({
                  config,
                  aliases: readAliases(fabricConfigPath()),
                  state: board(),
                  path,
                  issues: outcome.issues,
               }),
               "info",
            );
            return;
         }

         const aliases = readAliases(fabricConfigPath());
         const lines = Object.keys(config.roles).map((name) =>
            describeRole(config, aliases, name),
         );
         const council = resolveCouncilModels(config, aliases);
         ctx.ui.notify(
            `Pi-Staffs ${PI_STAFFS_VERSION} — ${path}\n档位：${activePresetName(config) || "（无）"}｜可用：${available.join(", ") || "（空）"}\n${lines.join("\n")}\n合议：${council.join(", ") || "（未配置 council.members / roles.council.councilMembers）"}\n派发：fabric_exec 里 staffs.run({ role, task })；切档位：/staffs preset <名字>；看板：/staffs board；观测层：/staffs panel <footer|widget|off>；体检：/staffs doctor`,
            "info",
         );
         for (const issue of outcome.issues)
            ctx.ui.notify(`Pi-Staffs 配置：${issue}`, "warning");
      },
   });
}
