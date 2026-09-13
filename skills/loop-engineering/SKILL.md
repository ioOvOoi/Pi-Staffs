---
name: loop-engineering
description: 设计并运行「可自动判定的循环」：先由 orchestrator 做 Grill 访谈定结构，再由 Monitor 盯每一轮的结果、升级与人工裁决。适合让 fixer/designer 反复改到验收条件满足的场景。
---

# 循环工程（Loop Engineering）

## Grill（orchestrator 访谈）

逐个问，答完再开工：

1. **目标**：「你到底想完成什么？」
2. **成功判据**：「描述一下我们怎么知道这个循环成功了。」
3. **成功类型**：从 `test`、`build`、`lint`、`command`、`fileExists`、`oracle`、`observer`、`manual` 里选一个。CLI 类要给出 `successCommand`；文件检测类要给出 `successPath`。
4. **执行者**：fixer / designer / explorer / librarian
5. **验证者**：oracle / observer / test
6. **最大轮次**（默认 3）
7. **可选的上下文文件**：执行前需要先读哪些文件或目录？

把访谈结果落到任务里（`staffs_task` 建 DAG、`staffs_goal` 记目标与成功判据），再开始循环。

## Loop Monitor

- 盯住这些信号：
  - **一轮结束**：记录本轮判定（成功 / 失败 + 失败原因），用 `staffs_record` 落盘
  - **升级**：达到最大轮次或同一错误重复出现时，升级给人
  - **人工复核**：需要人判「通过/不通过」时，用 `staffs_ask` 提问，拿到结论再继续
- 每次回调都要展示当前状态与轮次计数
- 人工验证时，先把失败原因摆出来，再问通过/不通过
- 人要取消时，走编排者的取消路径（停掉句柄、把任务标为放弃）

## 备注

- **人工验证是最小可用的起步方式**（autoresearch 模式）：它把循环挂起到人给出裁决为止，**不要自动替人裁决**。
- 「循环里累计的错误数 / 超时数」在 omo 里由 BackgroundJobBoard 自带；本插件里这些就是 `.staffs/state.json` 里的 attempt 记录（相位、心跳、terminal），看门狗按 `stallMs` 标 stalled，无需额外机制。

## 与 omo-slim 原版的差异

| 原版 | 本插件 |
| --- | --- |
| 运行时回调 `onLoopComplete` / `onEscalated` / `onManualReview` / `resolveManualReview` / `cancel` | 由 orchestrator 自己驱动：`staffs_record` 记录、`staffs_ask` 等人工裁决、停句柄即取消 |
| omo 插件内建的 loop 运行器与 BackgroundJobBoard 信号 | `.staffs/state.json` 的 attempt 相位 + 心跳 + 看门狗（`stallMs`） |
| Grill 的 7 个问题与 Monitor 职责 | 逐字保留 |
