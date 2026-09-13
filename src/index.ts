import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PI_STAFFS_VERSION = "0.1.0";

/**
 * Pi-Staffs 唯一入口。
 *
 * 为什么先只注册一条命令：票 01 的验收是「装载链路通」，角色矩阵（04）、
 * 派发内核（05/12/14）、团队 DAG（13）与面板（15）都在后续票里长出来，
 * 这里不放任何占位抽象——避免为了「看起来完整」而先造一层壳。
 */
export default function piStaffs(pi: ExtensionAPI): void {
  pi.registerCommand("pi-staffs", {
    description: "Pi-Staffs 编排插件：版本与状态",
    handler: async (_args: string, ctx: { ui: { notify: (msg: string, level?: string) => void } }) => {
      ctx.ui.notify(`Pi-Staffs ${PI_STAFFS_VERSION} — 骨架已装载（roles / dispatch 待实现）`, "info");
    },
  });
}
