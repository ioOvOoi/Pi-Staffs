---
name: codemap
description: 为陌生仓库生成分层代码地图（目录 → 职责/设计/流程/依赖）。开销大：只在用户明确要求代码库文档、或首次接触陌生仓库时使用。
---

# Codemap 技能

帮用户把仓库理解成一份**分层地图**：每个目录一份 `codemap.md`，根目录一份「仓库全景」。

## 何时用

- 用户要求理解/梳理某个仓库
- 用户想要代码库文档
- 开始在陌生代码库上干活（先有地图，再谈改动）

**代价警告**：这是重活（每个目录一个 fixer）。用户没提「文档/地图」就别擅自启动。

## 工作流

### 第 1 步：看有没有既有状态

**先查仓库根下的 `.staffs/codemap.json`。**

- 不存在但有老文件 `.staffs/cartography.json`：先把它改名成 `.staffs/codemap.json`（脚本会自动做），再走变更检测。
- `.staffs/codemap.json` 已存在：**跳到第 3 步**，不要重新初始化——重新 init 会把历史快照冲掉，之后就分不清「哪些是这次才变的」。
- 两个都没有：进第 2 步。

### 第 2 步：初始化（仅当没有状态时）

1. **先看仓库结构**：列文件、看目录，别拿模型记忆猜。
2. **只把核心代码/配置文件纳入地图**，推断 include/exclude：
   - **纳入**：`src/**/*.ts`、`package.json` 之类。
   - **必须排除**（这些进地图只会稀释注意力）：
     - 测试：`**/*.test.ts`、`**/*.spec.ts`、`tests/**`、`__tests__/**`
     - 文档：`docs/**`、`*.md`（根 `README.md` 视需要保留）、`LICENSE`
     - 构建/依赖：`node_modules/**`、`dist/**`、`build/**`、`*.min.js`
     - 运行期状态：`.staffs/**`
   - `.gitignore` 由脚本自动尊重，不用手抄一遍。
3. **跑脚本**（技能自带 `scripts/codemap.mjs`，随包发布）：

   ```bash
   # 定位随包脚本（开发位置与安装位置都能命中）
   CODEMAP_SCRIPT=$(find "$HOME/.pi" -ipath '*pi-staffs*/skills/codemap/scripts/codemap.mjs' -print -quit 2>/dev/null)

   node "$CODEMAP_SCRIPT" init \
     --root ./ \
     --include "src/**/*.ts" \
     --exclude "**/*.test.ts" --exclude "dist/**" --exclude "node_modules/**" --exclude ".staffs/**"
   ```

   产出：
   - `.staffs/codemap.json`：文件与目录的 hash，供变更检测用
   - 相关目录下的空 `codemap.md` 骨架
4. **把写地图的活派给 fixer**：一个目录一个 fixer，让它读代码后填该目录的 `codemap.md`。

   ```js
   // fabric_exec 里（prelude 已注入）
   await staffs.spawn({
     role: "fixer",
     task: "读 <目录> 下的代码，按 codemap.md 骨架里的四节填写：职责/设计/流程/依赖关系。只写这一份文件，不要改代码。",
   });
   ```

   多个目录可并行派发（读是并行的，写各写各的文件，不冲突）。

### 第 3 步：检测变更（状态已存在时）

1. 先看变了什么：

   ```bash
   node "$CODEMAP_SCRIPT" changes --root ./
   ```

2. **读输出**：新增 / 删除 / 修改的文件，以及**受影响的目录**列表。
3. **只更新受影响目录的 `codemap.md`**——一个目录一个 fixer。没被波及的地图别动，那只会制造噪音。
4. 地图补齐后再落盘新快照：

   ```bash
   node "$CODEMAP_SCRIPT" update --root ./
   ```

   > 顺序很重要：先 `changes`（看差异）→ 补地图 → 才 `update`。先 update 就等于把「还没来得及理解的变化」标记成已理解。

### 第 4 步：收尾成「仓库全景」（根 codemap.md）

所有目录都填完后，由 orchestrator（不是 fixer）写根 `codemap.md`，它是任何人/任何 agent 进入仓库的**总入口**：

1. **记录根资产**：根目录文件（`package.json`、入口文件…）与项目总体用途。
2. **汇总子地图**：建一节「目录地图」，把每个有 `codemap.md` 的目录的「职责」摘要收进表格。
3. **互相引用**：表格里给出每个子地图的路径，方便直接跳过去看细节。

### 第 5 步：在 AGENTS.md 里登记地图

Pi 每个会话都会读项目根的 `AGENTS.md`。要让后来的 agent 自动发现地图，就更新（或创建）根 `AGENTS.md`：

1. 已有 `## Repository Map` 节 → **跳过**（幂等，别重复追加）。
2. 有 `AGENTS.md` 但没有该节 → **追加**下面这段。
3. 没有 `AGENTS.md` → **创建**并写入下面这段。

```markdown
## Repository Map

完整代码地图在项目根的 `codemap.md`。

动手做任何任务前，先读 `codemap.md` 了解：
- 项目架构与入口
- 各目录的职责与设计模式
- 数据流与模块间的集成点

深挖某个目录时，再读那个目录自己的 `codemap.md`。
```

## codemap.md 里该写什么

写地图的是 fixer，用**精确的工程术语**：

- **职责**：这个目录在系统里是什么角色（如「服务层」「数据访问对象」「中间件」）。
- **设计**：点名具体模式（如「观察者」「单例」「工厂」「策略」），讲清抽象与接口。
- **流程**：数据怎么进怎么出，关键函数调用序列与状态迁移。
- **依赖关系**：被谁消费、依赖谁，列出 hook / 事件 / API 端点等技术名。

示例（子目录）：

```markdown
# src/agents/

## 职责
定义 agent 人格，并管理它们的配置生命周期。

## 设计
每个 agent = 一段提示词 + 一组权限。配置系统分三层：
- 内置提示词（orchestrator.ts、explorer.ts …）
- 用户覆盖（~/.pi/agent/pi-staffs.json）
- skill/MCP 的权限通配符

## 流程
1. 插件加载 → 调 getAgentConfigs()
2. 读用户配置档位
3. 合并默认与覆盖
4. 展开权限通配符
5. 返回 agent 配置

## 依赖关系
- 消费方：主插件 src/index.ts
- 依赖：配置加载器、技能注册表
```

示例（根全景）：

```markdown
# 仓库全景：<项目名>

## 项目职责
一句话说清这个项目为什么存在。

## 系统入口
- `src/index.ts`：插件初始化与宿主集成
- `package.json`：依赖与脚本

## 目录地图（汇总）
| 目录 | 职责摘要 | 详细地图 |
|------|---------|---------|
| `src/agents/` | 定义 agent 人格并管理模型路由 | [查看](src/agents/codemap.md) |
| `src/features/` | 会话状态与多路复用集成的核心逻辑 | [查看](src/features/codemap.md) |
```

## 与本插件其他部分的配合

- 地图写完后，`AGENTS.md` 的登记让后续会话自动带上它；不要每轮重新扫仓库。
- 地图过期比没有地图更危险：改完代码顺手跑一次 `changes`，只补受影响的目录。
- 想给 Pi-Staffs 自己建地图：把本流程的 `src/**/*.ts` 换成本包实际结构即可，`.staffs/**` 一定要排除。
