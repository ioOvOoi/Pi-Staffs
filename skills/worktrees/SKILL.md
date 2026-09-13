---
name: worktrees
description: 把 git worktree 当作隔离的编码车道：并行任务、高风险实验、集成评审与清理。复杂、有风险或需要并行的工作使用。
---

# Worktree 编排协议

本技能给 Orchestrator 一套有明确约束的 worktree 编排协议：让并行 agent、高风险实验、集成评审与清理都有统一走法。

## 核心契约

这是**只属于 orchestrator** 的流程。`fixer`、`designer` 等专才可以被派进某个车道里干活，但**车道的规划、分支/路径选择、文件归属、派发、diff 校验、集成与清理都由 Orchestrator 负责**。

所有 worktree 都放在默认路径下：

```text
.staffs/worktrees/<slug>/
```

**不要**把 worktree 建成主仓库的兄弟目录。

### 状态跟踪（`.staffs/worktrees.json`）

用本地元数据清单 `.staffs/worktrees.json` 维持结构化跟踪：

```json
{
  "version": "1.0.0",
  "updatedAt": "2026-06-14T00:00:00.000Z",
  "lanes": [
    {
      "slug": "feature-auth-v2",
      "branch": "staffs/feature-auth-v2",
      "path": ".staffs/worktrees/feature-auth-v2",
      "base": "main",
      "purpose": "refactor authentication flow to use OAuth2",
      "owner": "orchestrator",
      "status": "active",
      "areas": ["src/auth", "src/config"],
      "createdAt": "2026-06-14T12:00:00.000Z"
    }
  ]
}
```

初始化车道时若该文件不存在就创建，并在车道**切换、集成、清理**时持续更新。默认把它当本地工作流元数据；要把它变成提交进仓库的项目约定之前，先问用户。

> 本插件另有 `staffs_worktree` 工具做同一套动作（建车道、列车道、收车道）。能自动化的部分优先用它，手工命令作为兜底与查证手段；无论走哪条路，本协议的安全约束不变。

---

## 安全约束

在执行任何会改动 git 状态的命令前，Orchestrator 必须遵守以下护栏。

### 1. 起飞前检查

- 确认当前目录在某个 git 仓库内。
- 检查当前分支、基线分支、以及是否有未提交改动。
- 看一遍 `git worktree list`，避免路径或分支冲突。
- 确认分支名（默认 `staffs/<slug>`，或项目自定约定）在本地与远端都不存在。
- 创建嵌套 worktree 之前，确认 `.staffs/worktrees/` 已被 git 忽略。

### 2. 必须获得用户确认

执行以下操作前必须取得用户明确确认：

- `git worktree add` 或 `git worktree remove`
- 创建、删除、重命名分支
- merge、rebase、cherry-pick
- `git prune` 或 `git worktree prune`
- 破坏性命令（`git reset --hard`、`git clean`、`git push --force`，或删除有未提交改动的 worktree 目录）

没有**针对该次操作**的明确确认，绝不执行破坏性命令、删除分支、移除有改动的 worktree，或清掉未提交的改动。

### 3. 忽略文件设置

创建或清理车道之前，检查既有 `.gitignore` 与 `.ignore`：已有托管块就就地更新，没有就追加。只补下面缺失的那几行，**不要重复条目，也不要动无关规则**。这些块让车道产物只留在本地，而 `.ignore` 的允许清单让工具仍能读到它们。

`.gitignore`：

```gitignore
# BEGIN pi-staffs worktrees
.staffs/worktrees/
.staffs/worktrees.json
# END pi-staffs worktrees
```

`.ignore`：

```ignore
# BEGIN pi-staffs worktrees
!.staffs/
!.staffs/worktrees.json
!.staffs/worktrees/
!.staffs/worktrees/**
# END pi-staffs worktrees
```

---

## 工作流

### 阶段 1：规划与搭建

1. 明确任务范围，定一个简短的 `<slug>`。
2. 定分支名：默认 `staffs/<slug>`，除非项目或用户另有约定。
3. 校验仓库安全状态，向用户确认后再初始化车道。
4. 建车道之前，按上面的「忽略文件设置」确保托管块已存在。
5. 执行：

   ```bash
   git worktree add -b <branch-name> .staffs/worktrees/<slug> <base-commit/branch>
   ```

6. 在 `.staffs/worktrees.json` 里登记元数据。

### 阶段 2：执行与派发

1. 所有子 agent 的工作目录都严格设为车道路径，例如 `.staffs/worktrees/<slug>`。
2. 车道工作**不要**改主检出：构建、测试、编辑都留在车道里。
3. 按车道跟踪文件/目录归属，避免并行 agent 之间产生合并冲突。
4. 只有用户要求提交、或批准了本地检查点提交时，才在 worktree 内提交进度。

### 阶段 3：集成与验证

合并或集成车道分支之前：

1. 对改动的行为与其重要边界施加一份**相称的最终状态验证计划**；执行仓库与发版要求的检查。
2. 生成并展示「车道分支 vs 集成基线分支」的清晰 diff。
3. 请用户确认再集成。
4. 在主检出（或用户批准的集成检出）里执行被批准的集成（merge / cherry-pick）。

### 阶段 4：清理与修剪

1. 清理车道之前，按「忽略文件设置」确保托管块符合规则。
2. 确认所有改动都已安全合并或归档。
3. 确认 worktree 内没有未提交改动。
4. 请求用户批准移除 worktree。
5. 安全移除：

   ```bash
   git worktree remove .staffs/worktrees/<slug>
   ```

6. 更新 `.staffs/worktrees.json`：把车道标为 `archived` 或移除。

---

## 何时用 / 何时不用

### 该用

- 可能破坏当前工作环境的危险重构
- 需要在不提交半成品的前提下切换上下文的并行任务 / 修 bug
- 让独立的后台 agent 跑在各自的分支上
- 可能被丢弃的探索性 spike 或原型
- 隔离第三方包或复杂升级
- 用户明确要求用 worktree 的任务

### 不该用

- 单文件小改、文档更新、小 bug 修复
- git 仓库尚未完全初始化，或带有 worktree 难以处理的多子模块复杂状态

## 与 omo-slim 原版的差异

| 原版 | 本插件 |
| --- | --- |
| `.slim/worktrees/<slug>`、`.slim/worktrees.json` | `.staffs/worktrees/<slug>`、`.staffs/worktrees.json` |
| 分支前缀 `omos/` | `staffs/` |
| 忽略块标签 `oh-my-opencode-slim` | `pi-staffs` |
| 只靠手工 git 命令 | 可用 `staffs_worktree` 工具（同一套动作），手工命令兜底 |
| 其余契约、护栏、四阶段流程 | 逐条保留 |
