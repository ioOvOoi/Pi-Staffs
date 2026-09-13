# Changelog

## 1.1.0

治本：prelude 改走 `fabric_exec` 的 `prelude` 入参，不再往模型代码里拼字符串。

- 依赖上抬：pi-fabric ≥ 0.93.0（`prelude` 入参自该版本起支持）。
- 消失的故障模式：prelude 与模型代码不再共用类型门禁与源映射。此前 prelude 里的类型错误会以
  模型代码的行号报出来，并把整条 `fabric_exec` 通道一起拒掉（本仓 67ae6d5 的实机故障）。
- 行为不变：guest 侧照样有 `staffs.*`；`tool_call` 钩子只设 `event.input.prelude`，模型代码一字不动。

## 1.0.0

首个可用版本：把「角色矩阵 + 模型档位 + 有状态派发」做成 Pi 扩展。

**装载与注入**

- `pi` manifest 声明 `extensions` / `skills` / `prompts`；`session_start` 生成 `~/.pi/agent/pi-staffs.json` 并逐条报配置问题。
- `tool_call` 只给 `fabric_exec` 前置 prelude；`before_agent_start` 只给顶层会话注入派发指引（子会话按 `PI_FABRIC_PARENT_RUN` 跳过）。
- `tool_result` 认领 guest 回执（marker `pi-staffs/attempts/v1`）。

**角色矩阵与档位**

- 七个角色（orchestrator / explorer / oracle / council / librarian / designer / fixer）集中定义 model / thinking / tools / mode / enabled。
- 模型走 `fabric.json` 的 `models.aliases`，在宿主侧解析，guest 只看结果。
- 档位：内置 `baseline`，`/staffs preset <名字>` 即时切换；未覆盖的角色与行为不变。

**派发韧性**

- 准入超时与 429 走同模型退避重试（429 尊重 `Retry-After`）；模型不可用不重试不等待；真任务失败不重试。
- `maxRetries` 覆盖 `attemptsPerModel`（总尝试 = 1 + maxRetries），每次尝试都写进回执。
- 不做回退链：不静默换模型，只提示人工切档位。

**团队与观测**

- attempt 相位（running / awaiting / settled）与心跳、看门狗 stale 标记。
- 任务 DAG 依赖门控、句柄认领、带未读标记的信箱；状态落在 `<cwd>/.staffs/state.json`。
- 观测层 `footer` / `widget` / `off`，只渲染状态文件；空状态零注入以保住 prompt cache。
- 子会话历史丢失后可重拉同角色（reviver），期间不打扰存活句柄。

**工具与技能**

- 14 个工具：board / goal / task / mail / ticket / record / ask / webfetch / worktree / interview / doctor / astgrep / acp / review。
- 9 个随包技能 + 7 个角色提示词；技能同步只写入插件目录，不做运行时拉取。
- `staffs_acp` 严格引擎白名单；`staffs_astgrep` 无 `rewrite` 时只搜不换。

**验证**

- `npm run typecheck`（tsc --noEmit）+ `npm run smoke`（36 项契约，不启动 Pi）。
