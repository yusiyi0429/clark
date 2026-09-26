# 成员工作台与信号发送 · 进度

Spec：`spec.md`

| 步骤 | Ticket | 状态 |
|---|---|---|
| 1 身份与登录 | `issues/01-identity-and-sign-in.md` | resolved（2026-09-24），待用户本人登录验收 |
| 2 发送与收件 | 待写 | — |
| 3 事项群组 | 待写 | — |
| 4 执行事项 | 待写 | — |
| 5 部署 | 待写 | — |

## 结果摘要

- 第 1 步：登录 ID + 4 位口令（初始码首次必改、5 次锁 15 分钟、会话 30 天、重置即失效）；`requirePerson` / `requireCEO` 两道闸门；`/me` 成员工作台外壳；锁屏两阶段；CEO 长密码与 `hash-password` 脚本已移除；ADR-0020 与 CONTEXT.md 已更新。
