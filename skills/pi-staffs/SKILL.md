---
name: pi-staffs
description: 配置与改进 Pi-Staffs 本身：角色矩阵、模型档位、派发策略、权限表、技能与工具。用户想调 agent 团队、换模型档位、排查派发问题，或反复出现的摩擦提示该改配置时使用。
---

# Pi-Staffs 配置技能

目标不是回答配置问题，而是让这套编排系统在下一次运行里更好用——但也只在确实值得时才改。

## 现状怎么读

- `/staffs`：角色矩阵、当前档位、合议成员。
- `/staffs doctor`：模型别名能否解析、权限表、外部引擎、tracker、看板计数。全部本地判定，不发网络请求。
- `/staffs board`：运行中的派发、就绪任务、未读信箱。

## 常见调整

| 想做的事 | 改哪里 |
| --- | --- |
| 换某个角色的模型 | `~/.pi/agent/pi-staffs.json` 里该角色的 `model`（写别名） |
| 整组切模型 | 在该文件 `presets` 下加一组，然后 `/staffs preset <名字>` |
| 派发默认给谁 | `dispatch.primaryRole` / `dispatch.defaultImplementationRole` |
| 重试与退避 | `dispatch.maxRetries` / `initialRetryDelayMs` / `retryDelayMs` |
| 角色能碰什么工具 | 角色上的 `permissions.allow/ask/deny`（预检期判定） |
| 多模型合议 | `council.members`（别名数组） |
| 外部 CLI 引擎 | `acp.<名字>.command`（白名单，`staffs_acp` 只认这里） |
| 票放哪 | `tracker.kind`（local-markdown 默认 / github-issues） |

## 改动纪律

1. 先 `/staffs doctor` 取证，再改配置；改完再 doctor 一次对比。
2. 一次一处，改完立刻验证（`npm run typecheck && node scripts/smoke.mjs`）。
3. 派发点不写 model/thinking/tools——那是档位与角色矩阵的职责。
4. 派生 agent 的定义放在 `~/.pi/agent/agents/*.md`，本插件只负责调度与档位，不复制它们的提示词。
