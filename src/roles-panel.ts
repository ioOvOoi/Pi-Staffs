import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import {
   THINKING_LEVELS,
   activePresetName,
   defaultStaffsConfig,
   resolveModelRef,
   resolveRole,
   type StaffsConfig,
   type ThinkingLevel,
} from "./config.ts";

/** 面板对宿主的全部依赖（index.ts 注入）：配置读写、别名表、候选模型、提示。 */
export type RolesPanelIO = {
   load: () => { config: StaffsConfig; path: string };
   save: (next: StaffsConfig, path: string) => void;
   aliases: () => Record<string, string>;
   /** 候选模型，value 必须是 provider/model 直引（resolveModelRef 能直接解析）。 */
   models: () => SelectItem[];
   notify: (message: string, level?: "info" | "warning" | "error") => void;
};

export type RoleChange =
   | { kind: "model"; value: string }
   | { kind: "thinking"; value: ThinkingLevel }
   | { kind: "clear" };

/**
 * 纯函数：把一次面板调整写进配置。独立导出是为了冒烟能直接测逻辑、不碰 TUI。
 * 写回语义（所见即所得）：有档位 → 改档位覆盖（D23 只许 model/thinking）；
 * 无档位 → 直接改角色基线；clear 在两种模式下分别是「清除覆盖」与「恢复出厂默认」。
 * 为什么 thinking 覆盖要带上 model：validateConfig 要求覆盖条目的 model 可解析，
 * 缺 model 每次加载都会产生告警噪音。
 */
export const applyRoleChange = (
   config: StaffsConfig,
   roleName: string,
   change: RoleChange,
): { config: StaffsConfig; note: string } | { error: string } => {
   const role = config.roles[roleName];
   if (!role) return { error: `Pi-Staffs 没有角色：${roleName}` };
   const active = activePresetName(config);

   if (active) {
      const presets = { ...config.presets };
      const entries = { ...(presets[active] ?? {}) };
      const previous = entries[roleName];
      if (change.kind === "clear") {
         delete entries[roleName];
      } else if (change.kind === "model") {
         entries[roleName] = {
            ...(previous?.thinking ? { thinking: previous.thinking } : {}),
            model: change.value,
         };
      } else {
         entries[roleName] = {
            ...(previous?.model ? { model: previous.model } : { model: role.model }),
            thinking: change.value,
         };
      }
      presets[active] = entries;
      return {
         config: { ...config, presets },
         note:
            change.kind === "clear"
               ? `档位 ${active}：${roleName} 已清除覆盖，回到基线`
               : change.kind === "model"
                 ? `档位 ${active}：${roleName} 模型 → ${change.value}`
                 : `档位 ${active}：${roleName} 思考 → ${change.value}`,
      };
   }

   if (change.kind === "clear") {
      const fallback = defaultStaffsConfig().roles[roleName];
      if (!fallback) return { error: `${roleName} 没有出厂默认，无法恢复` };
      return {
         config: {
            ...config,
            roles: {
               ...config.roles,
               [roleName]: { ...role, model: fallback.model, thinking: fallback.thinking },
            },
         },
         note: `${roleName} 已恢复出厂默认（${fallback.model} · ${fallback.thinking}）`,
      };
   }
   if (change.kind === "model") {
      return {
         config: { ...config, roles: { ...config.roles, [roleName]: { ...role, model: change.value } } },
         note: `${roleName} 基线模型 → ${change.value}`,
      };
   }
   return {
      config: { ...config, roles: { ...config.roles, [roleName]: { ...role, thinking: change.value } } },
      note: `${roleName} 思考强度 → ${change.value}`,
   };
};

/** HOST 侧展示：角色当前生效模型（别名已解释成 provider/model 直引）。 */
const modelRefOf = (
   config: StaffsConfig,
   aliases: Record<string, string>,
   name: string,
): string => {
   const resolved = resolveRole(config, name);
   if (!resolved) return "?";
   return resolveModelRef(resolved.model, aliases)?.ref ?? resolved.model;
};

/** 复用官方 Pattern 1：SelectList 选择框，返回所选 value；esc / 关闭返回 null。 */
const pickOne = async (
   ctx: ExtensionCommandContext,
   title: string,
   items: SelectItem[],
   help?: string,
): Promise<string | null> =>
   ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
      const list = new SelectList(items, Math.min(items.length, 12), {
         selectedPrefix: (t: string) => theme.fg("accent", t),
         selectedText: (t: string) => theme.fg("accent", t),
         description: (t: string) => theme.fg("muted", t),
         scrollInfo: (t: string) => theme.fg("dim", t),
         noMatch: (t: string) => theme.fg("warning", t),
      });
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(null);
      container.addChild(list);
      container.addChild(new Text(theme.fg("dim", help ?? "↑↓ 选择 · enter 确认 · esc 返回"), 1, 0));
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      return {
         render: (width: number) => container.render(width),
         invalidate: () => container.invalidate(),
         handleInput: (data: string) => {
            list.handleInput(data);
            tui.requestRender();
         },
      };
   });

/**
 * /staffs roles 的交互主循环：角色列表 → 调整维度 → 取值，应用后回到角色列表。
 * 保存走 io.save（写盘 + 刷新 index 的缓存），下一轮派发即刻生效，无需 reload。
 */
export const openRolesPanel = async (
   ctx: ExtensionCommandContext,
   io: RolesPanelIO,
): Promise<void> => {
   if (ctx.mode !== "tui") {
      // RPC/print 没有交互面板：降级为只读摘要，保持命令在任何模式都不报错。
      const { config } = io.load();
      const aliases = io.aliases();
      const active = activePresetName(config);
      const lines = Object.keys(config.roles)
         .sort()
         .map((name) => {
            const resolved = resolveRole(config, name);
            return `· ${name} → ${modelRefOf(config, aliases, name)} · 思考 ${resolved?.thinking ?? "?"}`;
         });
      io.notify(
         `Pi-Staffs 角色（档位：${active || "无"}）\n${lines.join("\n")}\n交互面板仅 TUI 可用；非 TUI 可直接编辑 pi-staffs.json`,
         "info",
      );
      return;
   }

   for (;;) {
      const { config, path } = io.load();
      const active = activePresetName(config);
      const aliases = io.aliases();
      const names = Object.keys(config.roles).sort();
      if (names.length === 0) {
         io.notify("Pi-Staffs 的 roles 为空，没有角色可调", "warning");
         return;
      }
      const roleItems: SelectItem[] = names.map((name) => {
         const resolved = resolveRole(config, name);
         const overlay = active ? config.presets?.[active]?.[name] : undefined;
         return {
            value: name,
            label: name,
            description: `当前 ${modelRefOf(config, aliases, name)} · 思考 ${resolved?.thinking ?? "?"}${
               resolved?.enabled === false ? "（停用）" : ""
            }${overlay ? "（档位覆盖）" : ""}`,
         };
      });
      roleItems.push({ value: "__close__", label: "关闭面板", description: path });

      const role = await pickOne(ctx, `角色矩阵（档位：${active || "无"}）`, roleItems);
      if (!role || role === "__close__") return;
      if (!config.roles[role]) continue;

      const resolved = resolveRole(config, role);
      const currentRef = modelRefOf(config, aliases, role);
      const overlay = active ? config.presets?.[active]?.[role] : undefined;
      const actionItems: SelectItem[] = [
         { value: "model", label: "调整模型", description: `当前：${currentRef}` },
         { value: "thinking", label: "调整思考强度", description: `当前：${resolved?.thinking ?? "?"}` },
      ];
      if (overlay) {
         actionItems.push({ value: "clear", label: "清除档位覆盖", description: `${role} 回到基线` });
      } else if (!active) {
         actionItems.push({ value: "clear", label: "恢复出厂默认", description: "回到插件自带的模型与思考档" });
      }
      actionItems.push({ value: "__back__", label: "返回", description: "回到角色列表" });

      const action = await pickOne(ctx, `调整 ${role}`, actionItems);
      if (!action || action === "__back__") continue;

      if (action === "clear") {
         const result = applyRoleChange(config, role, { kind: "clear" });
         if ("error" in result) {
            io.notify(result.error, "warning");
         } else {
            io.save(result.config, path);
            io.notify(result.note, "info");
         }
         continue;
      }

      if (action === "model") {
         const seen = new Set<string>([currentRef]);
         const modelItems: SelectItem[] = [{ value: currentRef, label: `${currentRef}（当前生效）` }];
         for (const item of io.models()) {
            if (!seen.has(item.value)) {
               seen.add(item.value);
               modelItems.push(item);
            }
         }
         const chosen = await pickOne(ctx, `选择 ${role} 的模型`, modelItems);
         if (!chosen || chosen === currentRef) continue;
         const result = applyRoleChange(config, role, { kind: "model", value: chosen });
         if ("error" in result) {
            io.notify(result.error, "warning");
         } else {
            io.save(result.config, path);
            io.notify(result.note, "info");
         }
         continue;
      }

      const levelItems: SelectItem[] = [...THINKING_LEVELS].map((level) => ({
         value: level,
         label: level === resolved?.thinking ? `${level}（当前生效）` : level,
      }));
      const chosenLevel = await pickOne(ctx, `选择 ${role} 的思考强度`, levelItems);
      if (!chosenLevel || chosenLevel === resolved?.thinking) continue;
      const result = applyRoleChange(config, role, { kind: "thinking", value: chosenLevel as ThinkingLevel });
      if ("error" in result) {
         io.notify(result.error, "warning");
      } else {
         io.save(result.config, path);
         io.notify(result.note, "info");
      }
   }
};
