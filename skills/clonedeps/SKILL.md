---
name: clonedeps
description: 把关键依赖的源码克隆到被忽略的本地工作区，便于直接读库内部实现。用户要求克隆依赖、查依赖/SDK 源码、从源码理解框架行为、调试库实现细节时使用。普通的 API/文档问题不要用（让 librarian 查就够）。
---

# Clonedeps 技能

把**少量**关键依赖的源码放到本地，让 agent 能直接读。

这是流程技能，不是命令包装：依赖识别、ref 校验、克隆、状态与清理都不靠脚本。repo 相关的判断由 orchestrator 与 `@librarian` 做，文件系统/git 操作由 orchestrator 在用户批准后亲自执行。

## 工作流

### 第 1 步：看有没有既有状态

先看 `.staffs/clonedeps.json` 是否存在。

存在的话：

1. 先读它，再决定要不要请 librarian 出新计划；
2. 检查其中每个 `path` 在 `.staffs/clonedeps/repos/` 下是否真的存在；
3. 已克隆的 repo 若已满足当前任务，直接复用；
4. 只有当清单缺失、过期或不足以支撑当前任务时，才请 librarian 重新推荐。

**清单里有可用条目时，不要从头重扫重规划。**

### 第 2 步：请 librarian 出克隆计划

依赖发现与源码定位派给 `@librarian`。用这个提示词：

```md
先理解这个项目，然后推荐「值得本地克隆源码」的远端仓库。

先把这个仓库读够，理解：
- 项目做什么
- 主要架构
- 关键集成点
- 实际依赖了哪些外部系统/库

像一个要调试或扩展这个项目的开发者那样思考。

哪些远端仓库如果克隆到本地，真的能帮你理解代码库、或解决接下来大概率的实现/调试任务？

不要做「依赖大礼包」：绝大多数依赖不值得克隆。只有当它的源码比文档、比现有代码更有用时，才推荐。

每个推荐给出：
- 仓库名
- 仓库 URL
- 建议的 ref/tag/commit（若已知）
- 克隆它为什么有用
- 什么时候有用
- 注意事项

另外给出：
- 应该先看的当前仓库文件/目录
- 考虑过但不建议克隆的仓库/依赖

保持精简：0–3 个强推荐，好过 5 个弱推荐。若没有明确需要克隆的，直接说没有。
```

librarian 应交回一个精简计划，含：

- 依赖名；
- 当前版本/范围（能查到时）；
- 官方源码仓库 URL；
- 要检出的 tag/commit/ref；
- monorepo 时的包子目录；
- 本地源码为什么有用；
- 注意事项（仓库巨大、缺少对应 tag、版本映射不确定等）。

最多 3–5 个核心依赖。优先包含用户点名的，以及框架、SDK、ORM、运行时/插件 API、构建/运行时工具；小工具、传递依赖、纯开发依赖不要去克隆，除非与当前任务直接相关。

### 第 3 步：核实并向用户确认计划

最终批准权在 orchestrator。克隆之前：

1. 尽量用 `git ls-remote` 手工核实 ref；
2. 优先钉 tag 或 commit SHA；没有精确 tag 时，让 librarian 找到模块对应的 tag/commit，或说明退而求其次的理由；
3. 默认只用 HTTPS 形式的 GitHub/GitLab 仓库 URL。**拒绝** `file://`、SSH URL、本地路径、内嵌凭据的 URL，以及私有/需鉴权的仓库，除非用户明确批准；
4. 把计划（依赖、URL、ref、理由、注意事项）呈现给用户；
5. 除非用户已明确要求立刻克隆，克隆前先取得确认。

### 第 4 步：更新忽略文件

在克隆或清理之前，检查既有 `.gitignore` 与 `.ignore`：已有托管块就就地更新，没有就追加。只补下面缺失的行，不重复、不动无关规则。

`.gitignore`：

```gitignore
# BEGIN pi-staffs clonedeps
.staffs/clonedeps/repos/
# END pi-staffs clonedeps
```

`.ignore`：

```ignore
# BEGIN pi-staffs clonedeps
!.staffs/
!.staffs/clonedeps.json
!.staffs/clonedeps/
!.staffs/clonedeps/repos/
!.staffs/clonedeps/repos/**
.staffs/clonedeps/repos/**/.git/
.staffs/clonedeps/repos/**/.git/**
# END pi-staffs clonedeps
```

### 第 5 步：手工克隆

每个源码仓库一个目录：

```text
.staffs/clonedeps/repos/<安全名>/
```

安全名从仓库的 owner/name 推出来，**不要**用包名。例如 `https://github.com/opencode-ai/opencode.git` → `opencode-ai__opencode`：把 `/` 换成 `__`，去掉 `.git`，其他不安全字符换成 `_`。

同一个 monorepo 里的多个包：**只克隆一次**，让清单里各条指向同一个 `path`，用不同 `packagePath` 区分。不要建「生态目录」「按包克隆」「按版本克隆」。若两个不同仓库归一化后重名，手工消歧并把选定路径写进 `.staffs/clonedeps.json`。

用普通 git 命令克隆/更新。已存在的克隆，先确认 `git remote get-url origin` 与批准的 URL 一致；不一致就停下，问用户是清理还是重克隆。

安全的 git 套路：

1. `git ls-remote <repoUrl> <ref>` 核实 ref；
2. 克隆时不带 submodule/递归；
3. 尽量浅克隆/浅 fetch；
4. 先克隆到 `.staffs/clonedeps/repos/` 下的临时目录，checkout 成功后再移进最终安全名路径；
5. 失败的临时克隆要删掉。

**不要**在克隆下来的仓库里跑安装、构建、测试脚本。

### 第 6 步：写本地清单

写 `.staffs/clonedeps.json`，让后来的 agent 知道现在有什么：

```json
{
  "version": "1.0.0",
  "updatedAt": "2026-05-12T00:00:00.000Z",
  "dependencies": [
    {
      "name": "@some/plugin",
      "resolvedVersion": "1.3.17",
      "repoUrl": "https://github.com/opencode-ai/opencode.git",
      "ref": "v1.3.17",
      "path": ".staffs/clonedeps/repos/opencode-ai__opencode",
      "packagePath": "packages/plugin",
      "reason": "项目用到的插件 API 源码"
    }
  ]
}
```

若前面几个克隆成功、后面某个失败：**成功的那几个也要写进清单**，否则后续排查会被误导。

`.staffs/clonedeps.json` **不要**加进 `.gitignore`：它小、可评审，属于可提交的项目元数据。只有 `.staffs/clonedeps/repos/` 下的克隆内容要被忽略。

### 第 7 步：在 AGENTS.md 里登记依赖源码

克隆成功后，更新仓库根 `AGENTS.md`，让后续 agent 知道这些源码为什么在、去哪看。

已有 `## Cloned Dependency Source` 节就更新该节，没有就追加。列表每条一句话，够用即止：

```markdown
## Cloned Dependency Source

只读的依赖源码放在 `.staffs/clonedeps/repos/`，供查阅。**不要修改这些克隆。**

- `.staffs/clonedeps/repos/<safe-name>/` —— `<repo>` @ `<ref>`；一句话说明这份源码的用处。
```

`.staffs/clonedeps.json` 仍作为结构化清单维护，但不要让 agent 为了拿到仓库列表去读它。

## 清理

用户要求清理克隆依赖时，删除：

- `.staffs/clonedeps/repos/`
- `.gitignore` 与 `.ignore` 里的 clonedeps 托管块

删除 `.staffs/clonedeps.json` 或 `AGENTS.md` 里那节之前**先问**：它们可能是有意的项目元数据。
