/**
 * 干净上下文复审（票 08）。
 *
 * 复审的价值在于「只看 diff 与验收标准，不带写代码时的来回」，所以 brief 构造、findings 解析、
 * 回合策略都写成纯函数：宿主的 staffs_review 工具与 guest 侧的 staffs.run 共用它们，
 * 冒烟测试也能逐条钉住行为，不必真的起一个子 agent。
 */

export type FindingSeverity = "blocker" | "major" | "minor" | "nit";

export type ReviewFinding = {
   severity: FindingSeverity;
   file?: string;
   line?: number;
   message: string;
   raw: string;
};

export const FINDINGS_FORMAT = [
   "输出格式（每条一行；确实没有发现就单独写一行 `no findings`）：",
   "- [blocker|major|minor|nit] <文件>[:<行号>] — <问题与依据>",
].join("\n");

const SEVERITY_ALIASES: Record<string, FindingSeverity> = {
   blocker: "blocker",
   major: "major",
   minor: "minor",
   nit: "nit",
   p0: "blocker",
   p1: "major",
   p2: "minor",
   p3: "nit",
};

const HEAD_PATTERN = /^\s*(?:[-*]\s*)?\[([A-Za-z0-9]+)\]\s*(.*)$/;

const SEPARATORS = [" — ", " – ", " - ", ": "];

/** 只在第一个分隔符处切开：问题描述里再出现破折号不该被当成分隔符。 */
const splitOnce = (value: string): [string, string | undefined] => {
   for (const separator of SEPARATORS) {
      const at = value.indexOf(separator);
      if (at >= 0) return [value.slice(0, at), value.slice(at + separator.length)];
   }
   return [value, undefined];
};

/** 解析审阅者回话：认不出严重度标记的行不当发现（避免把普通列表当成结论）。 */
export const parseFindings = (text: string): ReviewFinding[] => {
   const findings: ReviewFinding[] = [];
   for (const raw of String(text ?? "").split(/\r?\n/)) {
      const head = HEAD_PATTERN.exec(raw);
      if (!head) continue;
      const severity = SEVERITY_ALIASES[(head[1] ?? "").toLowerCase()];
      if (!severity) continue;
      const rest = (head[2] ?? "").trim();
      if (!rest) continue;
      const [targetRaw, messageRaw] = splitOnce(rest);
      if (messageRaw === undefined) {
         findings.push({ severity, message: targetRaw.trim(), raw });
         continue;
      }
      const target = targetRaw.trim();
      const lineMatch = /:(\d+)$/.exec(target);
      const file = lineMatch ? target.slice(0, -lineMatch[0].length) : target;
      findings.push({
         severity,
         ...(file ? { file } : {}),
         ...(lineMatch ? { line: Number(lineMatch[1] ?? 0) } : {}),
         message: messageRaw.trim(),
         raw,
      });
   }
   return findings;
};

/** 指纹：同一处问题被不同措辞重复报告时也只修一次。 */
export const findingKey = (finding: ReviewFinding): string =>
   [
      finding.severity,
      finding.file ?? "-",
      finding.line ?? "-",
      finding.message.toLowerCase().replace(/\s+/g, " "),
   ].join("|");

export const dedupeFindings = (
   findings: ReviewFinding[],
   seen: Iterable<string> = [],
): { fresh: ReviewFinding[]; duplicates: ReviewFinding[] } => {
   const known = new Set(seen);
   const fresh: ReviewFinding[] = [];
   const duplicates: ReviewFinding[] = [];
   for (const finding of findings) {
      const key = findingKey(finding);
      if (known.has(key)) {
         duplicates.push(finding);
         continue;
      }
      known.add(key);
      fresh.push(finding);
   }
   return { fresh, duplicates };
};

export type RoundDecision = {
   action: "fix" | "stop";
   reason: string;
   findings: ReviewFinding[];
};

/**
 * 回合策略：默认忽略 nit（改它们只会把 diff 越滚越大），其余按严重度从高到低排队；
 * 轮次用尽就停并把剩余条目交回队长——禁止在扩展里自转循环。
 */
export const planReviewRound = (input: {
   round: number;
   findings: ReviewFinding[];
   maxRounds?: number;
   ignoreNits?: boolean;
}): RoundDecision => {
   const maxRounds = input.maxRounds ?? 2;
   const order: FindingSeverity[] = ["blocker", "major", "minor", "nit"];
   const relevant = (input.ignoreNits === false
      ? input.findings
      : input.findings.filter((finding) => finding.severity !== "nit")
   )
      .slice()
      .sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
   if (!relevant.length) return { action: "stop", reason: "没有待修条目", findings: [] };
   if (input.round >= maxRounds)
      return {
         action: "stop",
         reason: `已达 ${maxRounds} 轮上限，剩余 ${relevant.length} 条交回队长判断`,
         findings: relevant,
      };
   return { action: "fix", reason: `第 ${input.round + 1} 轮修复 ${relevant.length} 条`, findings: relevant };
};

export type ReviewBriefInput = {
   task: string;
   diff: string;
   acceptance?: string[];
   base?: string;
   focus?: string[];
   maxChars?: number;
};

/** 给审阅者的 brief：只有任务、验收标准、diff —— 干净上下文是刻意的（不附实现者的自辩）。 */
export const buildReviewBrief = (input: ReviewBriefInput): string => {
   const maxChars = input.maxChars ?? 60000;
   const diff = String(input.diff ?? "");
   const clipped =
      diff.length > maxChars
         ? diff.slice(0, maxChars) + `\n（diff 已截断，原长 ${diff.length} 字符）`
         : diff;
   return [
      "你是独立审阅者。只看下面的任务、验收标准与 diff；不要读仓库其他文件，也不要重写实现。",
      "",
      "## 任务",
      input.task,
      "",
      "## 验收标准",
      ...(input.acceptance?.length ? input.acceptance.map((item) => "- " + item) : ["（未提供）"]),
      ...(input.focus?.length ? ["", "## 额外关注", ...input.focus.map((item) => "- " + item)] : []),
      "",
      "## diff" + (input.base ? `（相对 ${input.base}）` : ""),
      "```diff",
      clipped,
      "```",
      "",
      FINDINGS_FORMAT,
   ].join("\n");
};

/** 把待修条目变成修复者的 task：编号 + 明确「只改这些」，避免顺手重构。 */
export const formatFindingTasks = (findings: ReviewFinding[]): string =>
   [
      "只修下面这些复审发现，不要顺手重构或扩大范围：",
      ...findings.map(
         (finding, index) =>
            `${index + 1}. [${finding.severity}] ${finding.file ?? "（未指明文件）"}${
               finding.line ? ":" + finding.line : ""
            } — ${finding.message}`,
      ),
      "",
      "修完逐条回应对应关系。",
   ].join("\n");
