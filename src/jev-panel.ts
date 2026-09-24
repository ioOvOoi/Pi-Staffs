/**
 * /staffs jev 路由审计面板（票 05）。
 *
 * 数据源是共享池文件的 routingLog 段（票 03 由 src/route.ts 落盘）：本面板只读跨包共享文件，
 * 不读 pi-jev 源码树，也绝不写池文件。
 *
 * 为什么复用 loadPool 而不是自己读 JSON：缺失/空/坏 JSON 三态的兜底（空池 + issues，绝不抛错、
 * 绝不覆盖用户文件）已经在 pool.ts 做全了，面板直接消费它的输出，就天然满足「池缺/坏时该段显示
 * 暂无路由记录、面板其余部分不受影响」。
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { loadPool, type PoolFile } from "./pool.ts";
import { pickOne } from "./roles-panel.ts";

/** 面板展示条数上限：池里环形日志只留最近判断（ROUTING_LOG_CAP），这里也只摊最近的。 */
export const JEVPANEL_LIMIT = 20;

/** 面板消费的单条判断：字段全部归一化（防御损坏条目），fallback 是唯一真假分流点。 */
export type JevPanelEntry = {
   at: string;
   role: string;
   profile: string;
   selected: string;
   fallback: boolean;
};

/** 面板数据：pool 由 loadPool 保证形状（正常池 / 空池），issues 给用户可见的告警文案。 */
export type JevPanelData = {
   path: string;
   issues: string[];
   pool: PoolFile;
};

/** 面板对宿主的全部依赖（index.ts 注入）：装载池数据、告警。 */
export type JevPanelIO = {
   load: () => JevPanelData;
   notify: (message: string, level?: "info" | "warning" | "error") => void;
};

/**
 * 只读装载：解析池文件路径、加载（缺/坏兜底为空池）。独立函数让冒烟直接注入 env 测，
 * 不碰命令层与 TUI。
 */
export const loadJevPanelData = (
   env: NodeJS.ProcessEnv = process.env,
): JevPanelData => {
   const outcome = loadPool({ env });
   return { path: outcome.path, issues: outcome.issues, pool: outcome.pool };
};

/**
 * 归一化并取最近的判断。为什么丢弃「缺 role」的条目：role 是定位哪次判断的唯一锚点，
 * 空/缺了显示出来也没意义（这不是路由日志的一部分，是垃圾段）；其余字段缺省用兜底文案，
 * 宁可展示也要保「面板不崩」。
 */
const coerceEntry = (raw: unknown): JevPanelEntry | null => {
   if (!raw || typeof raw !== "object") return null;
   const entry = raw as Record<string, unknown>;
   if (typeof entry.role !== "string" || !entry.role.trim()) return null;
   return {
      at: typeof entry.at === "string" ? entry.at : "",
      role: entry.role,
      profile: typeof entry.profile === "string" ? entry.profile : "（无摘要）",
      selected: typeof entry.selected === "string" ? entry.selected : "（未选定）",
      fallback: entry.fallback === true,
   };
};

/** 最近的合法判断（按池内顺序取尾部 limit 条；环形追加天然近的在后面）。 */
export const lastEntries = (
   entries: ReadonlyArray<unknown> | undefined,
   limit: number = JEVPANEL_LIMIT,
): JevPanelEntry[] =>
   (entries ?? [])
      .map(coerceEntry)
      .filter((entry): entry is JevPanelEntry => entry !== null)
      .slice(-limit);

/** ISO 时刻 → 固定格式可读时刻（不用 toLocale*，避免测试依赖机器 locale）。 */
const formatAt = (at: string): string => at.replace("T", " ").slice(0, 19);

/** 单条判断 → 展示行：时刻/角色/三问摘要/选定模型都在，fallback 用 ⚠ 前缀区分。 */
export const formatRoutingLogLine = (entry: JevPanelEntry): string => {
   const at = entry.at ? `${formatAt(entry.at)} ` : "";
   const mark = entry.fallback ? "⚠ 回落" : "✓ 命中";
   return `${mark} ${at}${entry.role}：${entry.profile} → ${entry.selected}`;
};

/**
 * 路由日志段（纯渲染）：最近判断逐条；空/缺 → 单行「暂无路由记录」。
 * 非 TUI 文本与冒烟断言共用这条渲染面，TUI 面板走 lastEntries 各自排版。
 */
export const formatRoutingLogSection = (
   entries: ReadonlyArray<unknown> | undefined,
   limit: number = JEVPANEL_LIMIT,
): string[] => {
   const rows = lastEntries(entries, limit);
   return rows.length ? rows.map(formatRoutingLogLine) : ["暂无路由记录"];
};

/** 整面板文本（非 TUI 降级与冒烟共用）：头部摘要 + 路由日志段，池缺/坏也照常渲染。 */
export const renderJevPanelText = (data: JevPanelData): string => {
   const entryCount = Array.isArray(data.pool.entries)
      ? data.pool.entries.length
      : 0;
   const logCount = Array.isArray(data.pool.routingLog)
      ? data.pool.routingLog.length
      : 0;
   const section = formatRoutingLogSection(data.pool.routingLog);
   return [
      `Pi-Staffs Jev 路由审计 — ${data.path}`,
      `池条目 ${entryCount} ｜ 路由记录 ${logCount} 条`,
      "【路由日志】最近判断：",
      ...section.map((line) => `· ${line}`),
   ].join("\n");
};

/**
 * /staffs jev 面板：只读展示最近路由判断，fallback 有可视区分。
 * 渲染风格照抄 roles/preset 面板（62779e8 / 828e17a）：TUI 用 SelectList 逐条浏览，
 * 非 TUI（RPC/print 无交互）降级为文本通知，任何模式都不报错。
 */
export const openJevPanel = async (
   ctx: ExtensionCommandContext,
   io: JevPanelIO,
): Promise<void> => {
   if (ctx.mode !== "tui") {
      const data = io.load();
      io.notify(renderJevPanelText(data), "info");
      // 池缺/坏时 loadPool 会给模板提示：单独 warning 通知，面板文本本身保持干净可读。
      for (const issue of data.issues)
         io.notify(`Pi-Staffs 模型池：${issue}`, "warning");
      return;
   }

   for (;;) {
      const data = io.load();
      const items: SelectItem[] = lastEntries(data.pool.routingLog).map(
         (entry, index) => ({
            value: `__entry_${index}__`,
            label: `${entry.fallback ? "⚠ 回落" : "✓ 命中"} ${formatAt(entry.at)} ${entry.role}`,
            description: `${entry.profile} → ${entry.selected}`,
         }),
      );
      if (items.length === 0)
         items.push({
            value: "__none__",
            label: "暂无路由记录",
            description: `池：${data.path}`,
         });
      items.push({ value: "__close__", label: "关闭面板", description: data.path });
      const chosen = await pickOne(
         ctx,
         "Jev 路由日志（只读审计）",
         items,
         "↑↓ 浏览最近判断 · esc 返回",
      );
      if (!chosen || chosen === "__close__") return;
      // 只读面板：选中任一条目只是重渲染（日志不会因选中而变）；暂无记录也回同一视图。
   }
};
