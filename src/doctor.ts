/**
 * doctor 体检报告（纯格式化，从 tools.ts 迁出）。
 * 为什么独立成模块：tools.ts 集中带安全语义的 git/fetch 守卫，纯展示格式化器
 * 混在里面会扩大安全评审面；独立后它也获得不经命令层的直接测试入口。
 */
import {
   activePresetName,
   fabricConfigPath,
   loadStaffsConfig,
   readAliases,
   resolveCouncilModels,
   resolveModelRef,
   resolveRole,
   type StaffsConfig,
} from "./config.ts";
import { readyTasks, readState, statePath, type StaffsState } from "./state.ts";

export type DoctorInput = {
   config: StaffsConfig;
   aliases: Record<string, string>;
   state: StaffsState;
   path?: string;
   issues?: string[];
};

/** 体检报告（票 14/19）：全部是本地判定，不发网络请求——预检模型可用性由 guest 侧 staffs.preflight 负责。 */
export const formatDoctorReport = (input: DoctorInput): string => {
   const { config, aliases, state } = input;
   const lines = [
      `配置：${input.path ?? "（内存）"}`,
      `档位：${activePresetName(config) || "（无，用角色基线模型）"}｜可用：${Object.keys(config.presets ?? {}).join(", ") || "（空）"}`,
   ];
   for (const name of Object.keys(config.roles)) {
      const role = resolveRole(config, name);
      if (!role) {
         lines.push(`✗ ${name}: 解析失败（加载期已跳过）`);
         continue;
      }
      const resolved = resolveModelRef(role.model, aliases);
      const permissions =
         (
            role as {
               permissions?: {
                  allow?: string[];
                  ask?: string[];
                  deny?: string[];
               };
            }
         ).permissions ?? {};
      lines.push(
         `${role.enabled === false ? "⏸" : "✓"} ${name}: ${resolved ? resolved.ref : "别名解析失败 → " + String(role.model)}` +
            ` · thinking ${role.thinking} · ${role.mode} · tools ${(role.tools ?? []).join(",") || "-"}` +
            ` · 权限 allow ${(permissions.allow ?? []).length}/ask ${(permissions.ask ?? []).length}/deny ${(permissions.deny ?? []).length}`,
      );
   }
   lines.push(
      `合议：${resolveCouncilModels(config, aliases).join(", ") || "（空：staffs.council 会直接拒绝，先配 council.members）"}`,
      `外部引擎：${
         Object.entries(config.acp ?? {})
            .map(([name, engine]) => name + "=" + engine.command)
            .join(", ") || "（空）"
      }`,
      `tracker：${config.tracker.kind}${config.tracker.directory ? " → " + config.tracker.directory : ""}${config.tracker.repo ? " → " + config.tracker.repo : ""}`,
      `看板：派发 ${state.attempts.length} 条｜任务 ${state.tasks.length}（就绪 ${readyTasks(state).length}）｜信箱未读 ${state.mailbox.filter((message) => !message.read).length} 条`,
   );
   for (const issue of input.issues ?? []) lines.push("⚠ 配置问题：" + issue);
   return lines.join("\n");
};

/** 采集体检输入（工具侧用）：集中在这里，宿主工具只剩注册壳。 */
export const collectDoctorInput = (stateFile?: string): DoctorInput => {
   const outcome = loadStaffsConfig();
   return {
      config: outcome.config,
      aliases: readAliases(fabricConfigPath()),
      state: readState(stateFile ?? statePath()),
      path: outcome.path,
      issues: outcome.issues,
   };
};

/** 一行体检：采集 + 格式化，返回报告与问题数（宿主工具注册的唯一入口）。 */
export const doctorReport = (
   stateFile?: string,
): { text: string; issues: number } => {
   const input = collectDoctorInput(stateFile);
   return { text: formatDoctorReport(input), issues: input.issues?.length ?? 0 };
};
