# Pi-Staffs

Pi 的编排插件：角色矩阵 + **有状态派发**（run attempt / 预检 / 退避 / 看门狗）+ 团队依赖 DAG + TUI 面板。

装：

```bash
pi install git:github.com/ioOvOoi/Pi-Staffs@v1
```

开发期（本机）：

```bash
git submodule add https://github.com/ioOvOoi/Pi-Staffs.git selfex/Pi-Staffs
node selfex/Pi-Staffs/scripts/smoke.mjs   # 契约冒烟，不需要启动 Pi
```

改完在 Pi 里 `/reload`，再敲 `/pi-staffs` 看版本。

## 现状

骨架阶段：只注册 `/pi-staffs`。实现依赖 Fabric agents 内核（`pi-fabric`），**不自建派发通道**。

## 设计约束

- 单一状态文件、一个核心模块 + 薄工具层；优先复用已装件，新增依赖需先证明 stdlib 不够。
- 面板（TUI）是**观测层**，不持有状态。
- 派发是有状态 run attempt，终态区分 `Succeeded / Failed / TimedOut / Stalled / CanceledByReconciliation`。
