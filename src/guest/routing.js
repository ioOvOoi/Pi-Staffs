/**
 * Pi-Staffs guest 侧路由内核（票 10）。它被 src/prelude.ts 原样读成字符串、
 * 紧跟 guest/kernel.js 之后注入，再由模板接线行把注入数据喂给 __staffsMakeResolver。
 *
 * 独立成文件的原因与 kernel.js 相同：模板串里的内嵌 JS 没有语法检查，语法错误要等
 * 运行时才炸；出模后编辑器/typecheck/冒烟的 import 断言都能提前兜住。
 *
 * 注入约束（改这个文件前先读）：
 *  - 不能 import、不能引用模块外的变量（注入后不存在）；
 *  - 数据一律走 makeResolver 的 deps 参数（裸引用注入 const 过不了 checkJs，
 *    学 kernel.js「依赖显式化」的同一原则）；
 *  - 只写 JS（JSDoc 标类型，tsconfig 开了 checkJs）。
 */

/**
 * @param {{
 *   roles: Record<string, any>;
 *   permissions: Record<string, { allowed?: boolean; reason?: string; deny?: string[]; allow?: string[] }>;
 *   routes: Record<string, { model?: string; thinking?: string }>;
 *   dispatch: { primaryRole: string };
 *   combine: (instructions: unknown, task: string) => string;
 * }} deps
 */
function __staffsMakeResolver(deps) {
   const { roles, permissions, routes, dispatch, combine } = deps;
   const covers = (/** @type {unknown} */ list, /** @type {string} */ tool) =>
      Array.isArray(list) && (list.indexOf(tool) >= 0 || list.indexOf("*") >= 0);
   return (/** @type {any} */ request) => {
      const input = request && typeof request === "object" ? request : {};
      const name = typeof input.role === "string" && input.role.trim() ? input.role.trim() : dispatch.primaryRole;
      const role = roles[name];
      if (!role) throw new Error("Unknown Pi-Staffs role: " + String(name) + "（可用：" + Object.keys(roles).join(", ") + "）");
      if (role.enabled === false) throw new Error("Pi-Staffs 角色 " + name + " 已停用（enabled: false）");
      const perms = permissions[name] || {};
      if (perms.allowed === false)
         throw new Error("Pi-Staffs 拒绝派发角色 " + name + "：" + (perms.reason || "权限矩阵未放行"));
      const { role: _ignored, instructions, task, ...rest } = input;
      if (typeof task !== "string" || !task.trim()) throw new Error("Pi-Staffs 派发需要非空 task");
      const requested = Array.isArray(rest.tools) ? rest.tools : [];
      const declared = Array.isArray(role.tools) ? role.tools : [];
      const banned = requested.filter((/** @type {string} */ tool) => covers(perms.deny, tool));
      const outside = requested.filter(
         (/** @type {string} */ tool) =>
            !covers(declared, tool) &&
            !covers(perms.allow, tool) &&
            !banned.includes(tool),
      );
      if (banned.length) throw new Error("Pi-Staffs 角色 " + name + " 被禁止使用工具：" + banned.join(", "));
      if (outside.length)
         throw new Error("Pi-Staffs 角色 " + name + " 的 tools 白名单不含：" + outside.join(", "));
      // 逃生门（票 03 第 3 条）：调用方显式 route:false/"matrix" → 本次派发回到档位矩阵。
      const routed = input.route === false || input.route === "matrix" ? undefined : routes[name];
      return {
         name,
         role,
         routed,
         request: { ...rest, thinking: routed?.thinking ?? role.thinking, tools: role.tools, ...(role.timeoutMs ? { timeoutMs: role.timeoutMs } : {}) },
         task: combine(instructions !== undefined ? instructions : role.instructions, task),
      };
   };
}
