/**
 * 角色权限矩阵（票 19）：在 `tools` 白名单之外给角色一张 allow / ask / deny 表，
 * 并在**预检期**就把违规拦掉（D26 的同一哲学：配错要早发现，别等运行到一半才炸）。
 *
 * 为什么不直接依赖 @gotgenes/pi-permission-system：它管的是「会话内工具调用弹窗」，
 * 无法表达「fixer 这个角色不得写文件」这种**按角色**的静态约束；我们保留它做 UI 提示，
 * 但判定权必须在本插件（预检要在派发之前发生，那时还没有工具调用）。
 *
 * 档位（D23）不得放宽权限：预检只看角色，不读 preset——preset 只覆盖 model/thinking。
 */
import type { RoleRoute } from "./config.ts";

export type RolePermissions = {
   /** 显式放行；缺省时以角色 tools 白名单为准。 */
   allow?: string[];
   /** 需要用户确认（宿主弹窗由 permission-system 负责，这里只标记）。 */
   ask?: string[];
   /** 硬拒；即使出现在 tools 白名单里也不放行。 */
   deny?: string[];
};

export type PermissionVerdict = {
   role: string;
   allowed: boolean;
   denied: string[];
   needsAsk: string[];
   reason?: string;
};

/** 读角色上的权限表；形状非法时当成「没有权限表」（宽松读取，严格预检）。 */
export const readPermissions = (role: RoleRoute): RolePermissions => {
   const raw = role.permissions;
   if (!raw || typeof raw !== "object") return {};
   const source = raw as Record<string, unknown>;
   const list = (key: string): string[] | undefined => {
      const value = source[key];
      if (!Array.isArray(value)) return undefined;
      const items = value.filter(
         (item): item is string => typeof item === "string",
      );
      return items.length ? items : undefined;
   };
   return { allow: list("allow"), ask: list("ask"), deny: list("deny") };
};

/** 通配 `*` 视为全量；否则精确匹配工具名。 */
const covers = (values: string[] | undefined, tool: string): boolean =>
   Array.isArray(values) && (values.includes(tool) || values.includes("*"));

/**
 * 判定一个角色可以动用哪些工具。
 * 返回 denied / needsAsk 两份清单：denied 非空即预检失败；needsAsk 只提示，不阻止。
 */
export const checkRolePermissions = (
   name: string,
   role: RoleRoute,
): PermissionVerdict => {
   const permissions = readPermissions(role);
   const tools = Array.isArray(role.tools) ? role.tools : [];
   const denied = tools.filter((tool) => covers(permissions.deny, tool));
   const needsAsk = tools.filter(
      (tool) => !denied.includes(tool) && covers(permissions.ask, tool),
   );
   if (denied.length) {
      return {
         role: name,
         allowed: false,
         denied,
         needsAsk,
         reason: `角色 ${name} 的 tools 里包含被 deny 的工具：${denied.join(", ")}`,
      };
   }
   if (tools.length === 0) {
      return {
         role: name,
         allowed: false,
         denied: [],
         needsAsk: [],
         reason: `角色 ${name} 没有可用工具（tools 为空），派发只会空转`,
      };
   }
   return { role: name, allowed: true, denied, needsAsk };
};

/**
 * 派发请求里显式点名工具时用它二次判定（角色 tools 之外的越权请求）。
 * 为什么留着 allow：有些角色 tools 是 `*`，此时 allow 表是唯一能表达「只准这些」的手段。
 */
export const checkRequestedTool = (
   name: string,
   role: RoleRoute,
   tool: string,
): PermissionVerdict => {
   const verdict = checkRolePermissions(name, role);
   const permissions = readPermissions(role);
   if (covers(permissions.deny, tool)) {
      return {
         ...verdict,
         allowed: false,
         denied: [tool],
         reason: `角色 ${name} 被禁止使用工具 ${tool}`,
      };
   }
   const declared = Array.isArray(role.tools) ? role.tools : [];
   const withinRole =
      declared.includes(tool) ||
      declared.includes("*") ||
      covers(permissions.allow, tool);
   if (!withinRole) {
      return {
         ...verdict,
         allowed: false,
         denied: [tool],
         reason: `工具 ${tool} 不在角色 ${name} 的 tools 白名单里`,
      };
   }
   return verdict;
};
