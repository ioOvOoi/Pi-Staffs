# Pi-Staffs

Pi 的编排插件：**角色矩阵 + 模型档位 + 有状态派发**。它不造派发通道，只把 pi-fabric 的 `agents` 与 `fabric_exec` 里的 `staffs.*` 包成一套可验证的纪律。

- 角色矩阵：七个角色的 model / thinking / 工具白名单集中定义，派发点不许再传 `model`。
- 模型档位：`baseline` 或自建档位，一条命令切换全队模型，未覆盖的角色保持原样。
- 有状态派发：准入超时、429、限次、看门狗、句柄认领、信箱、任务 DAG 都落在 `.staffs/state.json`。
- 观测层：footer 状态行或 widget 面板，只渲染状态文件，不做第二真相源。

## 装

发布后：

```bash
pi install git:github.com/ioOvOoi/Pi-Staffs@v1
```

本机开发（子模块 + 绝对路径）：

```bash
git submodule add https://github.com/ioOvOoi/Pi-Staffs.git selfex/Pi-Staffs
```

在 `~/.pi/agent/settings.json` 的 `packages` 里加一条**相对路径**（相对 settings.json 所在目录解析）：`"../selfex/Pi-Staffs"`。这样同一份配置在多台机器上都能用（只要仓库都放在 `~/.pi/selfex/` 下），不要写死绝对路径。重启 Pi 或 `/reload`。

依赖：Pi ≥ 0.80.6、pi-fabric ≥ 0.93.0（`peerDependencies`，prelude 走它的 `fabric_exec` `prelude` 入参）、Node ≥ 24。`typebox` 由 Pi 提供，因此声明为 peer。

## 首次运行

`session_start` 会生成 `~/.pi/agent/pi-staffs.json`（角色矩阵 + baseline 档位）并提示一次；之后：

```
/staffs                    # 看角色与当前档位
/staffs preset             # 列出可用档位
/staffs preset cheap       # 切档位（本会话后续派发生效）
/staffs skills             # 看随包技能
/staffs board              # 看板
/staffs doctor             # 体检（模型能否解析、引擎白名单、看板计数）
```

## 角色矩阵（基线）

| 角色 | 基线模型 | thinking | mode | 用途 |
| --- | --- | --- | --- | --- |
| orchestrator | ollama-cloud/glm-5.3 | high | primary | 拆任务 / 派发 / 整合 / 验收（全工具） |
| explorer | ollama-cloud/glm-5.3-flash | low | subagent | 只读侦察：路径 + 行号 + 结论，也能读图 |
| oracle | ollama-cloud/kimi-k3 | max | subagent | 架构选型 / diff 审查 / 调试方向（只读 + 索引工具） |
| council | ollama-cloud/glm-5.3 | high | subagent | 多模型合议：并行出稿后合成单一答案并列出分歧 |
| librarian | ollama-cloud/deepseek-v4-flash:0731 | medium | subagent | 外部知识：库 API / 版本特定行为 / 最新事实 |
| designer | ollama-cloud/glm-5.3-flash | high | subagent | 用户可见界面：布局、UX、视觉一致性、动效 |
| fixer | ollama-cloud/deepseek-v4-flash:0731 | high | subagent | 有边界改动、并行分区实现、测试改动 |

模型一律走 `~/.pi/agent/fabric.json` 的 `models.aliases` 解析；别名表只在宿主侧使用，guest 只看到解析后的结果。

## 派发

`tool_call` 钩子会把 prelude 挂到 `fabric_exec` 的 `prelude` 入参上（模型代码不被改动），因此在代码里直接用：

```js
staffs.list();                        // 角色名
staffs.describe("fixer");             // 当前档位下的模型 / thinking / tools
const pre = staffs.preflight("fixer"); // 预检：快速失败并列出候选模型
const r = await staffs.run({ role: "fixer", task: "…" });      // 等回执
const h = await staffs.spawn({ role: "explorer", task: "…" }); // 拿句柄（后接 staffs.task 族：steer/stop/resume）
await staffs.council({ task: "…" });   // 多模型合议（先 staffs.preflightCouncil()）
```

- `run` 的返回值带 `attempts`：每次重试、退避、拒因都在里面。
- 派发点**不要**传 `model` / `thinking` / `tools`：档位定模型，角色矩阵定 thinking 与工具白名单。
- 省略 `role` 时用 `dispatch.primaryRole`。

## 韧性与语义

| 情形 | 行为 |
| --- | --- |
| 准入超时 / 429 | 同一模型退避重试（429 尊重 `Retry-After`） |
| 模型不可用 | **不重试不等待**，直接失败并提示换档位 |
| 真任务失败（模型跑完但结果失败） | 不重试，交回编排者 |
| 同模型尝试上限 | `dispatch.maxRetries`（总尝试 = 1 + maxRetries）优先，否则 `attemptsPerModel` |
| 静默过久 | 看门狗按阈值标「疑似卡住」，footer 与面板同一判定 |

**没有回退链**：模型不可用时不会偷偷换个便宜模型继续跑，必须人工切档位（`/staffs preset`）——静默降级比失败更贵。

## 工具与命令

命令：`/staffs`（角色 / 档位 / 技能 / board / doctor）。

工具：`staffs_board`、`staffs_goal`、`staffs_task`、`staffs_mail`、`staffs_ticket`、`staffs_record`、`staffs_ask`、`staffs_webfetch`、`staffs_worktree`、`staffs_interview`、`staffs_doctor`、`staffs_astgrep`、`staffs_acp`、`staffs_review`。

- `staffs_task` 建 DAG（依赖未完成不允许开工）；`staffs_mail` 是带未读标记的信箱。
- `staffs_review`：独立干净上下文的复审（findings 解析 / 去重 / 轮次策略 / 无发现即停）。
- `staffs_acp` 只认识 `acp` 里声明过的引擎（默认 `codex` / `gemini` / `claude`）：参数由模型生成，所以不允许任意命令。
- `staffs_astgrep`：不给 `rewrite` 就只搜不换，绝不改盘。
- `staffs_worktree`：写操作保持单写者（读可并行、写串行或用 worktree 隔离）。

## 配置 `~/.pi/agent/pi-staffs.json`

```jsonc
{
  "configVersion": 1,
  "panel": "footer",        // footer | widget | off
  "preset": "baseline",
  "presets": { "baseline": { "fixer": { "model": "ollama-cloud/deepseek-v4-flash:0731" } } },
  "dispatch": {
    "primaryRole": "orchestrator",
    "defaultImplementationRole": "fixer",
    "initialRetryDelayMs": 0,
    "retryDelayMs": 500,
    "attemptsPerModel": 2,
    "backoffBaseMs": 1500,
    "backoffCapMs": 30000
  },
  "tracker": { "kind": "local-markdown" },
  "acp": { "codex": { "command": "codex", "args": ["exec", "-"], "stdin": true, "timeoutMs": 300000 } },
  "council": { "members": ["ollama-cloud/kimi-k3", "xai/grok-4.6"], "budgetTokens": 200000 },
  "roles": { "fixer": { "model": "…", "thinking": "high", "mode": "subagent", "tools": ["read"], "enabled": true } }
}
```

- 档位只写要覆盖的角色：`presets` 里的条目会覆盖 `roles` 的模型与 thinking，未写的角色与行为不变。
- `dispatch.maxRetries` 写了就生效，不写则退回 `attemptsPerModel`（旧配置兼容，冒烟钉住）。
- 坏字段只丢自己：`session_start` 逐条报问题并继续用其余配置；坏 JSON 不会被覆盖。
- 环境变量：`PI_STAFFS_CONFIG`（配置路径）、`PI_STAFFS_FABRIC_CONFIG`（别名表路径）、`PI_STAFFS_STATE`（状态文件，默认 `<cwd>/.staffs/state.json`）。

## 随包资源

- `prompts/`：7 个角色系统提示词（派发时注入）。
- `skills/`：9 个技能——deepwork、codemap、verification-planning、loop-engineering、simplify、reflect、worktrees、clonedeps、pi-staffs。
- 因为包里有 `pi` manifest，Pi 不再自动发现资源：`skills` / `prompts` 必须显式声明（已声明，并写进 `files` 随包发布）。

## 开发与验证

```bash
npm run typecheck   # tsc --noEmit
npm run smoke       # 契约冒烟 38 项，不启动 Pi
```

冒烟覆盖：装载与钩子、配置校验与旧字段兼容、档位解析、prelude（宿主侧解释别名）、内核重试矩阵、预检、复审、体检、工具白名单、观测层、技能同步、状态机、tracker、合议、reviver、worktree、prompt cache 前缀稳定、发版清单。

真实宿主验收：本目录加入 `settings.json` 的 `packages`，重启后 `/staffs` 应列出 7 个角色与 baseline 档位，且 `~/.pi/agent/pi-staffs.json` 已生成。

## 不做的事

- 不自建派发通道（复用 pi-fabric `agents`）。
- 不运行时拉取技能（随包发版）。
- 不做模型回退链（见上）。
- 面板不做第二真相源（只渲染 `.staffs/state.json`）。
- 不在派发点接受 `model` 覆写（档位是唯一入口）。

## License

MIT
