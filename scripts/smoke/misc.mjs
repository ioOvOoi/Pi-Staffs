/**
 * Pi-Staffs 冒烟 · 复审 / 体检 / 技能 / 状态机 / 杂项（票 07-26）
 * 由 scripts/smoke.mjs 薄壳按原单体顺序调用；段落文本与 ok() 台账名逐字节沿用原文件。
 */
import {
   assert, throws, rejects, ok, load, makeAgents, installEnv, evaluatePrelude,
   readConfigFile, hookLists, hooks, commands, tools, notifications, ctx, runCommand,
   checks, repo, sandbox, configPath, fabricPath, S, sleeps,
   existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
   createServer, tmpdir, path, fileURLToPath, pathToFileURL,
} from "./_shared.mjs";

export const run = async () => {
   const { config, aliases, good, buildStaffsPrelude, prelude } = S;
// ---------- 9. 复审（票 08）：纯逻辑 + 宿主工具 ----------
const review = await load("src/review.ts");
const parsed = review.parseFindings(
   [
      "结论如下：",
      "- [blocker] src/a.ts:12 — 越权写文件",
      "- [P1] src/b.ts — 缺少超时",
      "- 普通列表项，不该算发现",
      "no findings",
   ].join("\n"),
);
assert(parsed.length === 2, `应解析出 2 条发现，实际 ${parsed.length}`);
assert(
   parsed[0].file === "src/a.ts" && parsed[0].line === 12,
   "应解析文件与行号",
);
assert(parsed[1].severity === "major", "P1 应映射为 major");
assert(
   parsed[1].file === "src/b.ts" && parsed[1].line === undefined,
   "无行号时不该编造行号",
);
const deduped = review.dedupeFindings([...parsed, ...parsed]);
assert(
   deduped.fresh.length === 2 && deduped.duplicates.length === 2,
   "重复发现应按指纹去重",
);
const nit = { severity: "nit", message: "风格", raw: "- [nit] 风格" };
const round1 = review.planReviewRound({ round: 0, findings: [...parsed, nit] });
assert(round1.action === "fix" && round1.findings.length === 2, "nit 默认不修");
assert(round1.findings[0].severity === "blocker", "应按严重度排序");
const round2 = review.planReviewRound({
   round: 1,
   findings: round1.findings,
   maxRounds: 2,
});
assert(round2.action === "fix", "未到上限应继续修");
const round3 = review.planReviewRound({
   round: 2,
   findings: round1.findings,
   maxRounds: 2,
});
assert(
   round3.action === "stop" && /上限/.test(round3.reason),
   "到上限应停下交回队长",
);
assert(
   review.planReviewRound({ round: 0, findings: [] }).action === "stop",
   "无发现即停",
);
const brief = review.buildReviewBrief({
   task: "T",
   diff: "diff --git a/x b/x",
   acceptance: ["通过冒烟"],
   base: "HEAD",
});
assert(brief.includes("相对 HEAD"), "brief 应写清基线");
assert(
   brief.includes("通过冒烟") && brief.includes(review.FINDINGS_FORMAT),
   "brief 应含验收标准与输出格式",
);
assert(
   review
      .buildReviewBrief({ task: "T", diff: "x".repeat(50), maxChars: 10 })
      .includes("已截断"),
   "超长 diff 应截断并标注",
);
ok("复审：findings 解析 / 去重 / 轮次策略 / brief 截断");

const reviewTool = tools.get("staffs_review");
assert(reviewTool, "应注册 staffs_review");
const briefReply = await reviewTool.execute("id", {
   task: "T",
   diff: "diff --git a/x b/x",
   acceptance: ["A"],
});
assert(briefReply.content[0].text.includes("```diff"), "应回可派发的 brief");
assert(briefReply.content[0].text.includes("oracle"), "应指明交给 oracle 角色");
const fixReply = await reviewTool.execute("id", {
   task: "T",
   findingsText: "- [major] src/a.ts:3 — 少了守卫",
});
assert(
   fixReply.content[0].text.includes("只修下面这些复审发现"),
   "应把发现转成待修任务",
);
assert(fixReply.details.action === "fix", "有待修条目时 action=fix");
const cleanReply = await reviewTool.execute("id", {
   task: "T",
   findingsText: "no findings",
});
assert(cleanReply.content[0].text.includes("没有待修条目"), "无发现应直接停");
ok("复审工具：brief / 待修任务 / 无发现即停");

// ---------- 10. 外部引擎白名单 + 体检 + 子命令（票 14/16/19） ----------
const withAcp = config.validateConfig(
   {
      roles: {
         orchestrator: {
            model: "p/a",
            thinking: "high",
            mode: "primary",
            tools: ["*"],
         },
      },
      acp: {
         mine: { command: "my-cli", args: ["-p", "{prompt}"] },
         broken: 42,
         noCommand: { args: [] },
      },
   },
   aliases,
);
assert(withAcp.config.acp.codex.command === "codex", "默认引擎应保留");
assert(withAcp.config.acp.mine.command === "my-cli", "自定义引擎应合并进来");
assert(!withAcp.config.acp.broken, "非法引擎条目应被丢弃");
assert(
   withAcp.issues.some((issue) => issue.includes("acp.broken")) &&
      withAcp.issues.some((issue) => issue.includes("acp.noCommand")),
   "非法引擎应逐个报告",
);
const { formatDoctorReport } = await load("src/doctor.ts");
const doctorText = formatDoctorReport({
   config: withAcp.config,
   aliases,
   state: {
      stateVersion: 1,
      updatedAt: 0,
      attempts: [],
      tasks: [],
      mailbox: [],
   },
   path: "mem",
});
assert(
   doctorText.includes("orchestrator") && doctorText.includes("p/a"),
   "体检应列出角色与实际模型",
);
assert(
   doctorText.includes("外部引擎") && doctorText.includes("mine=my-cli"),
   "体检应列出外部引擎",
);
assert(doctorText.includes("看板："), "体检应含看板计数");
ok("体检：角色模型 / 引擎白名单 / 看板计数");

assert(
   ["staffs_doctor", "staffs_astgrep", "staffs_acp"].every((name) =>
      tools.has(name),
   ),
   "应注册体检 / 结构化搜索 / 外部引擎工具",
);
const doctorReply = await tools.get("staffs_doctor").execute("id", {});
assert(
   doctorReply.content[0].text.includes("配置："),
   "staffs_doctor 应回体检报告",
);
const unknownEngine = await tools.get("staffs_acp").execute("id", {
   engine: "nope",
   prompt: "hi",
});
assert(unknownEngine.details.ok === false, "白名单外的引擎必须被拒绝");
ok("工具：staffs_doctor 可用，staffs_acp 拒绝白名单外引擎");

assert((await runCommand("board")).length > 0, "/staffs board 应有输出");
const cmdDoctor = await runCommand("doctor");
assert(
   cmdDoctor.includes("档位：") && cmdDoctor.includes("合议："),
   "/staffs doctor 应回体检",
);
ok("/staffs：board 与 doctor 子命令");

const statuses = [];
await hooks.get("turn_end")(
   {},
   {
      hasUI: true,
      ui: {
         notify: () => {},
         setStatus: (key, value) => statuses.push([key, value]),
      },
   },
);
assert(
   statuses.length === 1 && statuses[0][0] === "pi-staffs",
   `turn_end 应写 footer 状态行，实际 ${JSON.stringify(statuses)}`,
);
ok("TUI：turn_end 更新 footer 状态行（空闲时清空）");

// ---------- 11. D26 旋钮：maxRetries 覆盖 attemptsPerModel（票 21） ----------
const knobConfig = config.validateConfig(
   { ...good.config, dispatch: { ...good.config.dispatch, maxRetries: 1 } },
   aliases,
).config;
const knobPrelude = buildStaffsPrelude({
   config: knobConfig,
   aliases: { "alias-fixer": "q/heavy-fixer" },
   promptFallback: (role) => `ROLE-PROMPT:${role}`,
});
const knobAgents = makeAgents(["RPC admission timed out; task was not sent"]);
installEnv(knobAgents);
const knobStaffs = evaluatePrelude(knobPrelude);
const knobRole = Object.keys(knobConfig.roles)[0];
const knobRun = await knobStaffs.run({ role: knobRole, task: "T" });
assert(
   knobRun.ok === false && knobRun.kind === "admission",
   "maxRetries=1 仍应如实上报准入失败",
);
assert(
   knobAgents.calls.length === 2,
   `maxRetries=1 应为 2 次尝试，实际 ${knobAgents.calls.length}`,
);
ok("韧性：maxRetries 覆盖 attemptsPerModel（总尝试 = 1 + maxRetries）");

// ---------- 12. 技能（票 10/23） ----------
const skillsMod = await load("src/skills.ts");
const skillList = skillsMod.listStaffsSkills();
assert(skillList.length === 9, `应有 9 个随包技能，实际 ${skillList.length}`);
assert(
   skillList.every((skill) => skill.name && skill.description.length > 10),
   "每个技能都要有 name 与可用的 description",
);
for (const name of [
   "clonedeps",
   "codemap",
   "deepwork",
   "loop-engineering",
   "pi-staffs",
   "reflect",
   "simplify",
   "verification-planning",
   "worktrees",
])
   assert(
      skillList.some((skill) => skill.name === name),
      `缺少技能 ${name}`,
   );
const skillText = await runCommand("skills");
assert(skillText.includes("deepwork"), "/staffs skills 应列出技能");
const syncTarget = path.join(sandbox, "skills");
const synced = skillsMod.syncStaffsSkills(syncTarget);
assert(
   synced.copied.length === 9 &&
      existsSync(path.join(syncTarget, "deepwork", "SKILL.md")),
   "同步应把全部 SKILL.md 复制到目标目录",
);
ok("技能：9 个随包技能可列出、可同步");

// ---------- 13. 状态机：DAG / 信箱 / 落盘（票 12/13） ----------
const stateMod = await load("src/state.ts");
const team = stateMod.emptyState(1_000);
stateMod.addTask(team, { id: "t-1", title: "造工具", role: "fixer" }, 1_000);
stateMod.addTask(team, { id: "t-2", title: "接工具", deps: ["t-1"] }, 1_000);
assert(
   stateMod
      .readyTasks(team)
      .map((t) => t.id)
      .join(",") === "t-1",
   "有依赖的任务不该进就绪集",
);
stateMod.claimTask(team, "t-1", "att-1", 1_000);
assert(stateMod.readyTasks(team).length === 0, "进行中的任务不该再进就绪集");
stateMod.finishTask(team, "t-1", "done", 1_000);
assert(
   stateMod
      .readyTasks(team)
      .map((t) => t.id)
      .join(",") === "t-2",
   "前置完成后下游才就绪",
);
assert(stateMod.formatBoard(team).includes("t-2"), "看板应列出任务");
stateMod.sendMail(
   team,
   { from: "fixer", to: "orchestrator", text: "干完了" },
   1_000,
);
assert(
   stateMod.takeMail(team, "orchestrator").length === 1,
   "信箱应能取到消息",
);
assert(
   stateMod.takeMail(team, "orchestrator").length === 0,
   "已读消息不该重放",
);
const stateFile = path.join(sandbox, "state.json");
stateMod.writeState(team, stateFile);
assert(stateMod.readState(stateFile).tasks.length === 2, "状态应能落盘再读回");
ok("状态机：依赖门控 / 句柄认领 / 信箱已读 / 落盘回读");

// ---------- 14. tracker 导入幂等（票 12） ----------
const trackerMod = await load("src/tracker.ts");
const issuesDir = path.join(sandbox, "issues");
mkdirSync(issuesDir, { recursive: true });
writeFileSync(
   path.join(issuesDir, "07-a.md"),
   "---\ntitle: 甲\ndeps: [06-x]\n---\n正文\n",
);
writeFileSync(
   path.join(issuesDir, "08-b.md"),
   "---\ntitle: 乙\nstatus: done\n---\n做完的\n",
);
const imported = stateMod.emptyState(1_000);
const markdownTracker = trackerMod.localMarkdownTracker(issuesDir);
const firstImport = await trackerMod.importCandidates(
   imported,
   markdownTracker,
   1_000,
);
const secondImport = await trackerMod.importCandidates(
   imported,
   markdownTracker,
   1_000,
);
assert(firstImport.map((t) => t.id).join(",") === "07-a", "只应导入未关闭的票");
assert(secondImport.length === 0, "重复导入必须幂等");
ok("tracker：local-markdown 导入未关闭票且幂等");

// ---------- 15. 合议（票 07/17） ----------
const councilAliases = {
   "alias-fixer": "q/heavy-fixer",
   "alias-oracle": "q/oracle",
};
const councilCfg = config.validateConfig(
   {
      council: {
         members: ["alias-fixer", "alias-oracle"],
         synth: "alias-fixer",
      },
   },
   councilAliases,
).config;
const councilStaffs = evaluatePrelude(
   buildStaffsPrelude({
      config: councilCfg,
      aliases: councilAliases,
      promptFallback: (role) => `ROLE-PROMPT:${role}`,
   }),
);
const councilAgents = makeAgents([]);
installEnv(councilAgents);
const council = await councilStaffs.council({ task: "选个方案" });
assert(
   council.ok === true && council.members.length === 2,
   `合议应并行跑满成员：${JSON.stringify(council.members)}`,
);
assert(
   council.members.map((member) => member.model).join(",") ===
      "q/heavy-fixer,q/oracle",
   "成员模型应由宿主解析成最终引用",
);
assert(council.synthesis?.answer === "done", "有 synth 时应给出合成答案");
const synthCall = councilAgents.calls[councilAgents.calls.length - 1];
assert(
   synthCall.task.includes("## q/heavy-fixer") &&
      synthCall.task.includes("## q/oracle"),
   "合成输入应带上各成员答案",
);
try {
   await councilStaffs.council({ task: "x", models: ["q/only"] });
   throw new Error("预期合议报错");
} catch (error) {
   assert(
      /至少需要 2 个模型/.test(String(error.message)),
      `成员不足应报错：${error.message}`,
   );
}
ok("合议：成员并行 + 合成答案 + 成员不足时报错");

// ---------- 16. reviver（票 16） ----------
const reviveAgents = makeAgents([]);
reviveAgents.status = async () => ({ state: "failed", task: "旧任务" });
installEnv(reviveAgents);
const reviveStaffs = evaluatePrelude(prelude);
const revived = await reviveStaffs.revive({ id: "agent-9", role: "fixer" });
assert(
   revived.revived === true && revived.handle.id === "agent-1",
   `死句柄应按原角色重新拉起：${JSON.stringify(revived)}`,
);
assert(
   reviveAgents.calls.some((call) => call.__spawn === true),
   "revive 必须走 spawn 通道，不能阻塞宿主",
);
reviveAgents.status = async () => ({ state: "running" });
const alive = await reviveStaffs.revive({ id: "agent-9" });
assert(alive.revived === false, "活着的句柄不该被重开");
ok("reviver：死句柄重拉同角色，活句柄不打扰");

// ---------- 17. worktree 注入 + 缓存安全（票 18/20） ----------
const { injectAgentsBlock, installDeps, worktreeTarget } =
   await load("src/tools.ts");
const worktree = path.join(sandbox, "worktree");
mkdirSync(worktree, { recursive: true });
writeFileSync(path.join(worktree, "AGENTS.md"), "# 人类写的规约\n");
injectAgentsBlock(worktree, "车道：只改 src/\n");
injectAgentsBlock(worktree, "车道：只改 src/\n");
const agentsMd = readFileSync(path.join(worktree, "AGENTS.md"), "utf8");
assert(agentsMd.includes("# 人类写的规约"), "注入不该冲掉人类已有的内容");
assert(
   agentsMd.split("<!-- pi-staffs:begin -->").length === 2,
   "重复注入应替换同一块，而不是叠加",
);
assert(
   (await installDeps(worktree)).includes("无 package.json"),
   "没有 package.json 时应跳过依赖安装",
);
const target = worktreeTarget(worktree, "feature-x");
assert(
   target.branch === "staffs/feature-x" &&
      target.directory ===
         path.join(worktree, ".staffs", "worktrees", "feature-x"),
   "worktree 名应落到 .staffs/worktrees 下，分支带 staffs/ 前缀",
);
for (const bad of [
   "../escape",
   "a/../../b",
   "/abs/x",
   "C:/abs/x",
   "bad name",
   "  ",
]) {
   throws(() => worktreeTarget(worktree, bad), /不得越出|需要 name|只允许/);
}
await rejects(
   () =>
      tools
         .get("staffs_worktree")
         .execute("id", { op: "remove", name: "../../etc" }),
   /不得越出|只允许|需要 name/,
);
const hooksMod = await load("src/hooks.ts");
assert(
   buildStaffsPrelude({
      config: good.config,
      aliases: { "alias-fixer": "q/heavy-fixer" },
      promptFallback: (role) => `ROLE-PROMPT:${role}`,
   }) === prelude,
   "同样输入必须产出逐字节相同的 prelude（前缀缓存安全）",
);
assert(
   hooksMod.buildTurnInjection(stateMod.emptyState(1_000), 1_000) === "",
   "空状态不该注入任何文本（缓存前缀稳定）",
);
ok("worktree：注入块幂等；越界名被拒；缓存：prelude 稳定、空状态零注入");

// ---------- 17b. webfetch：协议白名单 + 响应字节封顶 ----------
const server = createServer((_request, response) => {
   response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
   response.end("<p>" + "x".repeat(2_000_000) + "</p>");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
const webfetch = tools.get("staffs_webfetch");
const fetched = await webfetch.execute("id", {
   url: `http://127.0.0.1:${port}/`,
   maxChars: 1_000,
});
assert(
   fetched.content[0].text.length <= 1_100,
   "正文必须按 maxChars 截断后才进上下文",
);
assert(
   fetched.details.length > 1_000,
   "服务端确实发了 2MB：截断应发生在输出侧，而不是读不到内容",
);
await rejects(
   () => webfetch.execute("id", { url: "file:///etc/passwd" }),
   /只支持 http\/https/,
);
await rejects(
   () => webfetch.execute("id", { url: "不是 URL" }),
   /需要合法的绝对 URL/,
);
server.close();
ok("webfetch：非 http(s) 直接拒收；2MB 响应按字节封顶");

// ---------- 18. 观测层（票 15）：footer 相位判定 / 面板行 / 开关 ----------
const obsNow = 2_000_000;
const mkAttempt = (patch = {}) => ({
   id: "a1",
   role: "fixer",
   model: "p/m",
   phase: "running",
   startedAt: obsNow,
   heartbeatAt: obsNow,
   owner: "host",
   notes: [],
   ...patch,
});
const obsState = {
   ...stateMod.emptyState(obsNow),
   attempts: [
      mkAttempt(),
      mkAttempt({ id: "a2", phase: "settled", terminal: "stalled" }),
      mkAttempt({ id: "a3", phase: "awaiting", heartbeatAt: obsNow - 200_000 }),
   ],
   mailbox: [
      {
         id: "m1",
         from: "orchestrator",
         to: "fixer",
         text: "x",
         at: obsNow,
         read: false,
      },
      {
         id: "m2",
         from: "orchestrator",
         to: "*",
         text: "y",
         at: obsNow,
         read: true,
      },
   ],
};
assert(
   stateMod.footerSummary(obsState) === "staffs · 跑 2 · 停 1 · 信 1",
   `footer 要按相位统计（含 awaiting 的「跑」与直接寄出的未读信），实际 ${stateMod.footerSummary(obsState)}`,
);
assert(
   stateMod.footerSummary(stateMod.emptyState(obsNow)) === undefined,
   "空状态必须清掉状态行（返回 undefined）",
);
const panelLines = stateMod.formatPanel(obsState, { now: obsNow });
assert(
   panelLines.some((line) => line.includes("[running]")),
   "面板要显示 attempt 相位",
);
assert(
   panelLines.some((line) => line.includes("疑似卡住")),
   "面板要与看门狗同阈值标出 stale",
);
assert(
   stateMod.formatPanel(stateMod.emptyState(obsNow), { now: obsNow }).length ===
      0,
   "空态面板应为空数组（空面板不占屏幕）",
);
ok("观测层：footer 按相位统计、面板带相位与 stale 标记");

// ---------- 19. 面试稿 frontmatter 往返 + ast-grep 参数（票 16/17） ----------
const { formatInterview, parseInterview, astGrepArgs } =
   await load("src/tools.ts");
const interviewDoc = {
   topic: "派发韧性",
   createdAt: "2026-01-01T00:00:00.000Z",
   status: "in-progress",
   items: [
      { question: "准入失败怎么办", answer: "同模型退避重试" },
      { question: "限次用尽呢", answer: "（未回答）" },
   ],
};
const roundtrip = parseInterview(formatInterview(interviewDoc));
assert(
   roundtrip &&
      roundtrip.topic === interviewDoc.topic &&
      roundtrip.status === "in-progress",
   "面试稿要能被 parser 读回（含 frontmatter 与状态）",
);
assert(
   roundtrip.items.length === 2 &&
      roundtrip.items[0].answer === "同模型退避重试",
   `Q&A 历史要按序读回，实际 ${JSON.stringify(roundtrip.items)}`,
);
assert(
   parseInterview("# 别的 markdown\n") === undefined,
   "没有 frontmatter 的稿子应当作新稿处理",
);
const replaceArgs = astGrepArgs({
   pattern: "foo($A)",
   lang: "ts",
   rewrite: "bar($A)",
   path: "src",
});
assert(
   replaceArgs.includes("--rewrite") && replaceArgs.includes("--update-all"),
   "给了 rewrite 才带替换参数",
);
assert(
   !astGrepArgs({ pattern: "foo" }).includes("--update-all"),
   "只搜不换绝不能改盘",
);
ok("面试稿：frontmatter 往返可读回；ast-grep：只搜不换不动盘");

// ---------- 20. 观测层开关 + 包清单 + 钩子不抹状态（发版回归钉） ----------
assert(config.defaultStaffsConfig().panel === "footer", "默认观测层是 footer");
assert(
   config.validateConfig({ ...good.config, panel: "nope" }, aliases).config
      .panel === "footer",
   "非法观测层形态退回 footer",
);
assert(
   config.validateConfig({ ...good.config, panel: "widget" }, aliases).config
      .panel === "widget",
   "合法观测层形态要保留",
);
const manifest = JSON.parse(
   readFileSync(path.join(repo, "package.json"), "utf8"),
);
assert(
   manifest.pi.skills?.includes("./skills") &&
      manifest.pi.prompts?.includes("./prompts"),
   "有 pi manifest 时不再自动发现：skills/prompts 必须显式声明",
);
assert(
   manifest.files.includes("skills/") && manifest.files.includes("prompts/"),
   "files 必须带上 skills/prompts，否则发出去的包会丢技能与角色提示词",
);
assert(
   manifest.peerDependencies?.typebox === "*",
   "typebox 由 pi 提供，必须声明为 peer",
);
ok("清单：skills/prompts 显式声明且随包发布；观测层非法值有兜底");

// 钩子不许把注册期的陈旧快照写回去：那会抹掉工具刚写的任务（最难查的一类数据丢失）。
const hookHandlers = new Map();
const hookPath = path.join(sandbox, "hook-state.json");
hooksMod.registerStaffsHooks(
   { on: (name, handler) => hookHandlers.set(name, handler) },
   { statePath: hookPath },
);
stateMod.writeState(
   {
      ...stateMod.emptyState(obsNow),
      tasks: [
         {
            id: "t1",
            title: "别把我抹掉",
            deps: [],
            status: "running",
            updatedAt: obsNow,
         },
      ],
   },
   hookPath,
);
await hookHandlers.get("turn_end")();
const afterTurn = stateMod.readState(hookPath, obsNow);
assert(
   afterTurn.tasks.length === 1 && afterTurn.tasks[0].id === "t1",
   `turn_end 不得抹掉工具刚写的任务，实际 ${JSON.stringify(afterTurn.tasks)}`,
);
ok("钩子：turn_end 重读状态后再落盘（不抹工具刚写的数据）");

// ---------- 21. 安全边界（评审第一批）：通配 deny / 路径锁 / ref 校验 / 票 id / Windows npm ----------
const sec21Perms = await load("src/permissions.ts");
const sec21Wild = sec21Perms.checkRolePermissions("wild", {
   instructions: "x",
   model: "p/x",
   thinking: "off",
   tools: ["*"],
   permissions: { deny: ["bash"] },
});
assert(
   !sec21Wild.allowed && sec21Wild.reason.includes("*"),
   "tools 含 * 且配了 deny 必须预检失败，而不是静默放行",
);
const sec21Tools = await load("src/tools.ts");
assert(
   (() => {
      try {
         sec21Tools.resolveInside("/repo", "../evil.md");
         return false;
      } catch {
         return true;
      }
   })(),
   "resolveInside 必须拒绝越出项目目录的相对路径",
);
assert(
   sec21Tools.resolveInside("/repo", "a/b.md") ===
      path.resolve("/repo", "a/b.md"),
   "resolveInside 放行项目内路径",
);
assert(
   (() => {
      try {
         sec21Tools.assertSafeGitRef("--output=x");
         return false;
      } catch {
         return true;
      }
   })(),
   "git base 以 - 开头必须拒绝",
);
assert(sec21Tools.assertSafeGitRef("HEAD~2") === "HEAD~2", "正常 ref 放行");
const sec21Tracker = await load("src/tracker.ts");
const sec21Local = sec21Tracker.localMarkdownTracker(
   path.join(sandbox, "tracker"),
);
let sec21Rejected = false;
try {
   await sec21Local.writeState("../evil", "done", "");
} catch {
   sec21Rejected = true;
}
assert(sec21Rejected, "票 id 含路径分隔必须拒绝（目录穿越）");
assert(
   (await sec21Local.fetchIssue("T-1")) === undefined,
   "合法 id 不存在时返回 undefined 而不是抛错",
);
// installDeps 端到端：空依赖项目必须真装上（win32 同时验证 cmd.exe 垫片）。
const sec21Deps = path.join(sandbox, "deps");
mkdirSync(sec21Deps, { recursive: true });
writeFileSync(
   path.join(sec21Deps, "package.json"),
   JSON.stringify({ name: "smoke-deps", version: "0.0.0" }),
);
const sec21Install = await sec21Tools.installDeps(sec21Deps);
assert(
   sec21Install.startsWith("依赖已安装"),
   "installDeps 必须真装上（win32 走 cmd.exe 垫片），实际：" + sec21Install,
);
ok(
   "安全边界：通配 deny 报错；interview/astgrep 路径锁；git ref 校验；票 id 白名单；npm 安装可用",
);
// ---------- 22. 坏状态文件回归（P1-2）：readState 留证改名，writeState 照常落新文件 ----------
const sec22Dir = mkdtempSync(path.join(sandbox, "sec22-"));
const sec22Bad = "state.json 内容不是合法 JSON{{{";
const sec22File = path.join(sec22Dir, "state.json");
writeFileSync(sec22File, sec22Bad, "utf8");
const sec22Read = stateMod.readState(sec22File);
assert(
   sec22Read.tasks.length === 0 && sec22Read.mailbox.length === 0,
   "坏文件应退回空态，而不是抛错或回半截数据",
);
const sec22Entries = readdirSync(sec22Dir);
const sec22Corrupt = sec22Entries.find((name) =>
   name.startsWith("state.json.corrupt-"),
);
assert(
   sec22Corrupt !== undefined,
   "readState 应把坏文件改名留存：" + sec22Entries.join(","),
);
assert(
   readFileSync(path.join(sec22Dir, sec22Corrupt), "utf8") === sec22Bad,
   "留证件内容必须等于原坏文件（证据不丢）",
);
assert(!existsSync(sec22File), "改名成功后原路径不该再存在");
stateMod.writeState(stateMod.emptyState(2_000), sec22File);
assert(
   stateMod.readState(sec22File).stateVersion === 1,
   "writeState 应正常落新文件并被读回",
);
assert(
   existsSync(path.join(sec22Dir, sec22Corrupt)),
   "写新文件后留证件必须还在（不能把证据抹掉）",
);
ok("坏状态文件：readState 留证改名并回空态，writeState 正常落新文件");

// ---------- 23. 评审第三批：稳定指纹 / frontmatter 防原型污染 / 技能同步清理 ----------
const hooks23 = await load("src/hooks.ts");
const tracker23 = await load("src/tracker.ts");
const skills23 = await load("src/skills.ts");
assert(
   hooks23.stableKey({ a: { x: 1, y: 2 } }) ===
      hooks23.stableKey({ a: { y: 2, x: 1 } }),
   "嵌套键序不同应同指纹",
);
assert(
   hooks23.stableKey({ a: [1, 2] }) !== hooks23.stableKey({ a: [2, 1] }),
   "数组顺序应保留",
);
const circ23 = {};
circ23.self = circ23;
assert(
   hooks23.stableKey(circ23) === "[unserializable]",
   "循环引用应降级为不可比指纹",
);
const fm23 = tracker23.parseFrontmatter(
   "---\n__proto__: [x]\ntitle: t\n---\nbody",
);
assert(
   Object.getPrototypeOf(fm23.data) === null,
   "frontmatter 解析结果应无原型",
);
assert(
   fm23.data.title === "t" && Array.isArray(fm23.data["__proto__"]),
   "__proto__ 应成为自有属性且正常字段可读",
);
const syncClean23 = mkdtempSync(path.join(tmpdir(), "pi-staffs-clean-"));
mkdirSync(path.join(syncClean23, "user-own"), { recursive: true });
writeFileSync(
   path.join(syncClean23, "user-own", "SKILL.md"),
   "name: user-own\ndescription: x\n",
);
mkdirSync(path.join(syncClean23, "ghost-skill"), { recursive: true });
writeFileSync(
   path.join(syncClean23, ".pi-staffs-manifest.json"),
   JSON.stringify(["ghost-skill"]),
);
const clean23 = skills23.syncStaffsSkills(syncClean23);
assert(clean23.removed.join(",") === "ghost-skill", "清单里的已删技能应清掉");
assert(
   !existsSync(path.join(syncClean23, "ghost-skill")),
   "被清目录应真实移除",
);
assert(
   existsSync(path.join(syncClean23, "user-own", "SKILL.md")),
   "清单外目录不应误删",
);
rmSync(syncClean23, { recursive: true, force: true });
ok(
   "评审第三批：深度稳定指纹 / frontmatter 防原型污染 / 技能同步只清自己写过的",
);

// ---------- 24. 评审第三批·车道 C：私网 fetch 闸门 / interview 无损往返 ----------
const tools24 = await load("src/tools.ts");
const isPrivate = tools24.isPrivateFetchTarget;
const savedAllow24 = process.env.PI_STAFFS_ALLOW_PRIVATE_FETCH;
delete process.env.PI_STAFFS_ALLOW_PRIVATE_FETCH; // 矩阵要测默认拒，先摘掉顶层放行
const privTargets24 = [
   "http://localhost:1/",
   "http://127.0.0.1/",
   "http://10.1.2.3/",
   "http://172.16.0.1/",
   "http://192.168.1.1/",
   "http://169.254.1.1/",
   "http://[::1]/",
   "http://[::ffff:127.0.0.1]/",
   "http://[::ffff:7f00:1]/",
   "http://[fc00::1]/",
   "http://[fd12:3456::1]/",
   "http://[fe80::1]/",
];
for (const u of privTargets24)
   assert(isPrivate(new URL(u)) === true, "私网应判定为私：" + u);
assert(
   isPrivate(new URL("https://example.com/")) === false,
   "公网域名不应误判",
);
process.env.PI_STAFFS_ALLOW_PRIVATE_FETCH = "1";
assert(isPrivate(new URL("http://127.0.0.1/")) === false, "env 放行后不再拒");
if (savedAllow24 === undefined)
   delete process.env.PI_STAFFS_ALLOW_PRIVATE_FETCH;
else process.env.PI_STAFFS_ALLOW_PRIVATE_FETCH = savedAllow24;
const doc24 = {
   topic: "往返格式",
   createdAt: new Date().toISOString(),
   status: "complete",
   items: [
      { question: "Q1", answer: "## 看起来像标题\n---\n  前后空白  " },
      { question: "Q2", answer: "普通答案" },
   ],
};
const md24 = tools24.formatInterview(doc24);
const back24 = tools24.parseInterview(md24);
assert(back24 !== undefined, "格式化稿应可解析回");
assert(
   back24.items[0].answer === doc24.items[0].answer,
   "含 ## 与 --- 的答案应无损往返",
);
assert(back24.items[1].answer === "普通答案", "普通答案不编码原样往返");
ok("评审第三批·车道 C：私网 fetch 闸门矩阵 + interview 无损往返");

// ---------- 25. 评审第三批·车道 A：回执提取加固（P1-6）+ 记账守卫（P1-8） ----------
const attempts25 = await load("src/attempts.ts");
const state25mod = await load("src/state.ts");
const extract25 = attempts25.extractReceipts;
const pretty25 = (fields = {}) =>
   JSON.stringify(
      {
         marker: attempts25.RECEIPT_MARKER,
         attempts: [{ id: "a1", ok: true }],
         ...fields,
      },
      null,
      2,
   ) + "\n";
assert(extract25(pretty25()).length === 1, "行首 marker 真回执可认");
assert(
   extract25(pretty25().replace(attempts25.RECEIPT_MARKER, "evil/v9"))
      .length === 0,
   "伪造 marker 丢弃",
);
assert(
   extract25("前文 " + attempts25.RECEIPT_MARKER + " 中段\n" + pretty25())
      .length === 1,
   "文本中段 marker 不误配",
);
assert(
   extract25('{"marker":"' + attempts25.RECEIPT_MARKER + '","attempts":[]}')
      .length === 0,
   "内联 JSON 忽略",
);
assert(
   extract25('err: "brace { x",\n' + pretty25()).length === 1,
   "花括号错误文本不吞真回执",
);
const t25 = extract25(
   JSON.stringify(
      {
         marker: attempts25.RECEIPT_MARKER,
         evil: 1,
         attempts: [{ id: "a", evil: "x" }],
      },
      null,
      2,
   ),
);
assert(
   t25.length === 1 && !("evil" in t25[0]) && !("evil" in t25[0].attempts[0]),
   "白名单剔除多余字段",
);
const rec25 = (owner, id) => [
   {
      marker: attempts25.RECEIPT_MARKER,
      role: "r",
      attempts: [{ id, role: "r", at: 7, ok: true, kind: "ok" }],
   },
];
const p25 = path.join(sandbox, "state25.json");
const first25 = attempts25.recordReceipts(rec25("host", "x"), {
   path: p25,
   owner: "host",
   now: 1,
});
const second25 = attempts25.recordReceipts(rec25("host", "x"), {
   path: p25,
   owner: "host",
   now: 2,
});
assert(
   first25.recorded === 1 && second25.recorded === 0,
   "settled 重放不再覆盖/重复记账",
);
assert(
   attempts25.recordReceipts(rec25("other", "x"), {
      path: p25,
      owner: "other",
      now: 3,
   }).recorded === 0,
   "owner 不同不覆盖",
);
assert(
   state25mod.readState(p25).attempts[0].owner === "host",
   "旧 attempt 记录未被污染",
);
ok("评审第三批·车道 A：回执提取加固 + 记账守卫");

// ---------- 26. 遗留 ①②：回执结终时刻 + settled/owner 守卫下沉 upsertAttempt ----------
const state26mod = await load("src/state.ts");
const attempts26 = await load("src/attempts.ts");
const st26 = state26mod.emptyState(3);
const up26 = state26mod.upsertAttempt(
   st26,
   { id: "a", role: "r", phase: "settled", terminal: "succeeded", finishedAt: 42 },
   100,
);
assert(up26.applied === true && up26.attempt.finishedAt === 42, "新建即结终应带 finishedAt（回执时刻优先）");
const again26 = state26mod.upsertAttempt(
   st26,
   { id: "a", role: "r", phase: "settled", terminal: "failed" },
   200,
);
assert(again26.applied === false && again26.attempt.terminal === "succeeded", "已结终态不被迟到结果改写");
const own26 = state26mod.upsertAttempt(st26, { id: "b", role: "r", phase: "running", owner: "host" }, 100);
assert(own26.applied === true, "正常新建 running 不受守卫影响");
const diff26 = state26mod.upsertAttempt(st26, { id: "b", role: "r", owner: "other" }, 200);
assert(diff26.applied === false && own26.attempt.owner === "host", "owner 双方已知且不同不覆盖");
const p26 = path.join(sandbox, "state26.json");
const out26 = attempts26.recordReceipts(
   [{ marker: attempts26.RECEIPT_MARKER, role: "r", attempts: [{ id: "x1", role: "r", at: 42, ok: true, kind: "ok" }] }],
   { path: p26, owner: "host", now: 100 },
);
assert(out26.recorded === 1, "回执应记账一次");
const rs26 = state26mod.readState(p26);
assert(rs26.attempts[0].finishedAt === 42, "回执结终时刻应写 finishedAt");
assert(
   rs26.attempts[0].phase === "settled" && rs26.attempts[0].terminal === "succeeded",
   "回执应落 settled 终态",
);
ok("遗留 ①②：回执 finishedAt 一致 + settled/owner 守卫下沉 upsertAttempt");



};
