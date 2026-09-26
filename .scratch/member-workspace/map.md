# 成员工作台与信号发送 · 进度

Spec：`spec.md`（2026-09-26 起按 §10 的新分步）

| 步骤 | Ticket | 状态 |
|---|---|---|
| 1 身份与登录 | `issues/01-identity-and-sign-in.md` | resolved（2026-09-24） |
| 2a 框架与我的 Agent（含会议二级页） | `issues/02a-framework-and-my-agent.md` | resolved（2026-09-26） |
| 2c 会后闭环（录音转写、Action Item 派发、CEO 战略确认） | `issues/02c-meeting-follow-through.md` | resolved（2026-09-26），待真会验收 |
| 2d 去掉会话、声纹、个人菜单 | `issues/02d-sessions-and-voiceprint.md` | resolved（2026-09-27） |
| 2b 议题群 | 待写 | — |
| 3 发送与收件 | 待写 | — |
| 4 执行事项 | 待写 | — |
| 5 会议（含安排会议、飞书忙闲） | 待写 | — |
| 6 部署 | 待写 | — |

## 结果摘要

- 第 1 步：登录 ID + 4 位口令（初始码首次必改、5 次锁 15 分钟、会话 30 天、重置即失效）；`requirePerson` / `requireCEO` 两道闸门；`/me` 成员工作台外壳；锁屏两阶段；CEO 长密码与 `hash-password` 脚本已移除；ADR-0020 与 CONTEXT.md 已更新。
