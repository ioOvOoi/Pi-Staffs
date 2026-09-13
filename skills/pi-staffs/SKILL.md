---
name: pi-staffs
description: 配置与改进 Pi-Staffs（本机 agent 系统）。用户想调角色模型、提示词、自定义 agent、技能、MCP/工具权限、档位，或想基于重复摩擦安全地改配置时使用。
---

# Pi-Staffs 配置技能

帮用户配置、定制、**安全**改进自己的 Pi-Staffs 设置。

目标不只是回答配置问题。有机会时，帮用户把 agent 系统变得更好：调模型、改角色提示词、加聚焦的自定义 agent、开/收工具权限，并说清生效方式。

## 何时使用

用户问及或很可能需要改动：

- `~/.pi/agent/pi-staffs.json`（档位 / 角色 / panel / dispatch / acp / council / tracker）；
- `~/.pi/agent/settings.json`（`packages` 注册、provider 与模型）；
- `~/.pi/agent/agents/*.md`（角色定义：模型、thinking、工具、技能开关、提示词）；
- `~/.pi/agent/skills/<name>/SKILL.md`（技能）；
- 派发行为或某个专才的行为；
- 自定义 agent；
- 后台编排、会话复用、看板与深工（deepwork）、worktree；
- 可被一条提示词/配置改动修掉的重复摩擦。

也可以**克制地主动**使用：某次会话暴露了可重复改进点时（例如用户反复要求同一个 agent 遵守某条项目规则），建议把这条规则写进提示词或配置。

## 有哪些可改的地方

Pi-Staffs 是 Pi 的插件包，配置分散在几个明确位置：

| 路径 | 用途 |
|---|---|
| `~/.pi/agent/settings.json` | Pi 主配置：`packages` 里注册插件包（**用相对路径**，如 `"../selfex/Pi-Staffs"`）、provider 与模型 |
| `~/.pi/agent/pi-staffs.json` | 本插件配置：`preset`/`presets`、`roles`、`panel`、`dispatch`、`acp`、`council`、`tracker`、`configVersion` |
| `<project>/.staffs/state.json` | 运行状态：看板、任务 DAG、信箱、attempt 记录（默认位置，可用 `PI_STAFFS_STATE` 改） |
| `~/.pi/agent/agents/<name>.md` | 宿主角色定义（`explorer` / `librarian` / `designer` / `fixer` / `oracle` / `observer` / 自定义）：frontmatter 里有 `model`、`thinking`、`tools`、`skills`、`prompt_mode`，正文是系统提示词 |
| `~/.pi/agent/skills/<name>/SKILL.md` | 已装技能 |
| `~/.pi/agent/fabric.json` | 模型别名与备胎表（`staffs_acp` 与派发用到的引擎别名） |
| `<包目录>/prompts/*.md` | 包内角色系统提示词（跟随发布，升级会被覆盖） |
| `<包目录>/skills/*` | 包内技能（随包发布） |

内置角色（包内提示词）：`orchestrator`、`explorer`、`librarian`、`designer`、`fixer`、`oracle`、`council`。宿主侧还常见 `observer`、`general-purpose` 等自定义定义。

**边界**：

- 角色要改**模型 / thinking / 模式 / 工具 / 开关** → 写进 `~/.pi/agent/pi-staffs.json` 的 `roles` 或档位 `presets`。
- 角色要改**行为/提示词** → 改宿主的 `~/.pi/agent/agents/<name>.md`（本机稳定生效）。直接改包内 `prompts/` 会在下次升级时被覆盖，别这么做。
- 只覆盖想动的字段；没写的沿用原值。

## 配置形态

### 调某个角色的模型 / 技能 / 工具（推荐用档位）

```jsonc
{
  "preset": "cheap",
  "presets": {
    "cheap": {
      "fixer": { "model": "ollama-cloud/deepseek-v4-flash:0731", "thinking": "low" },
      "explorer": { "model": "ollama-cloud/deepseek-v4-flash:0731" }
    }
  }
}
```

- 档位只写要覆盖的角色；换档只改 `preset` 的值；
- 角色级字段：`model`、`thinking`（如 `low`/`high`/`xhigh`）、`mode`、`tools`、`enabled`；
- 未写字段与未提及的角色保持不变。

### 改派发与韧性

```jsonc
{
  "dispatch": {
    "primaryRole": "orchestrator",
    "defaultImplementationRole": "fixer",
    "attemptsPerModel": 2,
    "retryDelayMs": 500,
    "backoffBaseMs": 1500,
    "backoffCapMs": 30000
  }
}
```

这条链是**韧性内核**：每模型尝试次数、重试间隔与退避上限。改大重试会拉长失败暴露时间，改小会让偶发故障直接失败——动之前先说清代价。

### 追加/替换角色提示词

```text
~/.pi/agent/agents/orchestrator-append.md   # 追加（更安全）
~/.pi/agent/agents/orchestrator.md          # 整体替换（谨慎）
```

小改动优先用追加式（`...-append.md` / frontmatter 的 `prompt_mode`）而不是整篇替换：整篇替换必须**重述所有关键行为**，否则会丢掉包内提示词提供的契约。

示例（追加内容）：

```markdown
## 本机编排偏好

- 并行派多个写者之前，先确认它们的文件归属不重叠。
- 有重叠就问用户，或改成串行。
- 禁止轮询运行中的后台任务，等完成通知。
```

### 自定义 agent

```markdown
---
name: api-reviewer
description: 评审 API 设计、兼容性、错误语义与迁移风险。只在 API 契约类改动时使用。
model: ollama-cloud/deepseek-v4-flash:0731
thinking: high
tools: read, grep, find, ls
skills: false
prompt_mode: replace
---

你只评审 API 设计、兼容性、错误语义与迁移风险，输出带文件引用的精简结论。
```

好的自定义 agent 具备：

- 单一明确的职责；
- `description` 里写明触发条件与**不适用**条件（orchestrator 靠它路由）；
- 只给真正需要的工具与技能；
- 与任务判断力/成本相称的模型。

不要造与既有专才重复的 agent：

- 代码侦察 → `explorer`
- 外部文档/调研 → `librarian`
- 架构 / 调试 / 评审 → `oracle`
- UI/UX 打磨 → `designer`
- 有边界的机械实现 → `fixer`

## 安全改进规则

配置改动会影响未来的 agent 行为，视为**用户资产**：

1. **改配置或提示词前先问。**
   - 简短说明要改什么、为什么；
   - 说清改哪个文件；
   - 除非用户已明确要求那个精确改动，先取得确认。
2. **优先窄改。**
   - 一条小规则能解决，就不要重写大段提示词；
   - 不为一次性任务造自定义 agent。
3. **保留用户既有设置。**
   - 在现有配置上合并，不要从头重写；
   - 尽量保留注释与格式（JSONC 场景）。
4. **避免隐藏的行为变化。**
   - 应用前说明成本、权限或派发行为的变化；
   - 换更贵的模型/provider 要明确提示可能增加花费。
5. **告诉用户生效方式。**
   - Pi 需要 `/reload` 或重启才会应用配置/提示词/agent/技能/MCP 改动；
   - 话术：「下次 Pi 运行生效；要立刻生效就 `/reload` 或重启 Pi。」

## 配置工作流

1. **看现状**
   - 读 `~/.pi/agent/pi-staffs.json`（没有就说明默认值）；
   - 找出当前 `preset` 与相关角色块；
   - 看有没有项目级覆盖（`.staffs/`）或用户自定义 agent。
2. **定最小改动**
   - 调模型/档位为了质量、速度或成本；
   - 调提示词为了反复出现的行为；
   - 只有值得独立车道时才加自定义 agent；
   - 技能/工具权限过宽或过窄时才调整。
3. **征得确认**：给精简提议 + 目标文件路径。
4. **小心落地**：保留无关设置、保持可解析、角色/技能/工具名**逐字准确**。
5. **验证**：`/staffs doctor`（或 `staffs_doctor`）自检；确认 JSON 仍可解析、坏字段只丢自己。
6. **说清生效**：立即生效还是需要 `/reload`/重启。

## 提示词微调模式

**适合**微调的情形：

- orchestrator 对这个用户的工作流反复派太多或太少；
- 某个专才反复漏掉一条项目约定；
- 用户想要稳定的沟通或验证风格；
- 团队有反复用到的评审清单或发布规则。

**不适合**：

- 一次性任务失败了一次；
- 当前问题在本会话里正常说明就能解决；
- 改完会让 agent 在通用场景下变差。

建议话术：

```text
我注意到这是重复出现的。我可以往 <文件路径> 加一条小规则，让以后自动处理。要改吗？
```

## 示例

### 让 orchestrator 对后台写者更保守

```text
我可以加一条很窄的编排规则：同一目录下的写者 agent 不并行，除非文件归属明确。
目标：~/.pi/agent/agents/orchestrator-append.md。改吗？
```

### 加一个项目专用评审 agent

```text
这个足够反复出现，值得加一个只读评审 agent。我可以加 `api-reviewer`，不给技能，
description 里写明「只评审 API 契约与兼容性」，让 orchestrator 能正确路由。
写进 ~/.pi/agent/agents/api-reviewer.md？
```

### 提醒生效方式

```text
配置已更新。下次 Pi 运行生效；要立刻生效就 `/reload` 或重启 Pi。
```

## 最终检查清单

- [ ] 除非用户明确要求，改配置/提示词前是否已确认？
- [ ] 是否保留了既有设置？
- [ ] 档位名与角色名是否仍然有效？
- [ ] 技能/工具权限是否刻意且最小？
- [ ] 是否说明了 `/reload`/重启的生效行为？
