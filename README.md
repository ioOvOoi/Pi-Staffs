# Pi-Staffs

Pi 的编排插件：**角色矩阵 + 模型档位 + 有状态派发**。对 pi-fabric 的 agents 机制做一层薄封装，不自建派发通道。

装（发布后）：

```bash
pi install git:github.com/ioOvOoi/Pi-Staffs@v1
```

开发期（本机）：

```bash
git submodule add https://github.com/ioOvOoi/Pi-Staffs.git selfex/Pi-Staffs
cd selfex/Pi-Staffs
npm run typecheck   # tsc --noEmit
npm run smoke       # 契约冒烟（19 项），不需要启动 Pi
```

改完在 Pi 里 `/reload`，然后敲 `/staffs` 看当前角色与档位。

## 现状

已实现：角色矩阵（七神祇）、模型档位切换、派发韧性内核（准入/限流重试 + 退避 + 预检）。
待做：团队 DAG 与邮箱、TUI 面板（见 `.scratch/pi-staffs/issues/`）。

## 三件事

### 1. 角色矩阵

`~/.pi/agent/pi-staffs.json` 是唯一状态文件：每个角色钉住「模型 + 思考档 + 工具白名单 + 提示」。
不在派发点传 `model` / `task` 之外的东西——**角色矩阵是权限的单一来源**，档位只能在其之上换模型与思考档。

### 2. 档位（preset）

一次换一整队模型，例如「全本地 / 全云端 / 省钱 / 顶配」：

```jsonc
{
  "preset": "cheap",                    // 当前档位；空串 = 各角色用自带 model
  "presets": {
    "baseline": { "oracle": { "model": "alias", "thinking": "high" } },
    "cheap":    { "oracle": { "model": "local/big", "thinking": "medium" } }
  }
}
```

- 档位里只认 `model` 与 `thinking`；`tools` / `mode` / `instructions` **永远由角色决定**，档位不能放宽权限。
- 没写的角色继续用基线模型；未知档位名、引用不存在的角色都会在 `/staffs` 里警告（且不覆盖你写的配置）。
- 切换：`/staffs preset cheap`（本会话后续派发生效，正在跑的子 agent 不被打断），`/staffs preset` 看用法。
- **与主会话模型无关**：档位只管 `staffs.run/spawn` 派出去的子 agent；当前会话自己的模型用 Pi 的 `/model`。

### 3. 派发（在 `fabric_exec` 里）

```js
const out = await staffs.run({ role: "fixer", task: "把 parse() 的空输入处理补上" });
// out: { ok, text|error, model, attempts:[{attempt,kind,ok,delayMs,elapsed}], elapsedMs }
```

- `staffs.spawn()` 立即返回句柄（不等待）；`staffs.list()` / `staffs.describe(role)` / `staffs.preset()` / `staffs.preflight(roles)`。
- 韧性：**准入超时与限流重试同一模型**（退避；429 尊重 `Retry-After`），模型不可用/任务失败立刻返回。
  换模型这件事交给人——用 `/staffs preset`，而不是让内核在失败时偷偷换（那会毁掉 prompt cache 与排查线索）。

## 设计约束

- 单一状态文件、一个核心模块 + 薄注入层；优先复用已装件，新增依赖需先证明 stdlib 不够（当前运行时零依赖）。
- guest 内核是**纯 JS**：宿主冒烟测试把它丢进 `new Function` + 桩 agents 执行，这是不启动 Pi 就能验证重试行为的前提。
- 面板（TUI）是观测层，不持有状态。
- 派发是有状态 run attempt，终态区分 `Succeeded / Failed / TimedOut / Stalled / CanceledByReconciliation`。
