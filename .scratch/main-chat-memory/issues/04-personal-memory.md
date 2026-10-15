# 04 — 本人能查看、纠正、遗忘 Personal，并用于私聊

Type: implementation
Status: ready-for-agent

**What to build:** 每个人拥有独立 Personal.md，能通过本人接口查看和修改；主聊只使用本人相关片段，遗忘后旧运行态和历史召回不能把已删除属性重新带回。

**Blocked by:** 01（稳定人员身份边界）。

- [ ] 本人 GET/修改/遗忘完整贯通到持久文档和主聊 Reference，版本冲突不覆盖新内容。
- [ ] 同人跨 scope 共用、不同人隔离；不接受任意 owner 或文件路径。
- [ ] 文件与版本控制态中断可恢复，记忆不可用时主回答仍能运行。
- [ ] 遗忘失效 Runtime/cache，并阻止旧历史重新召回相同属性；不删除公司事实。

**TDD seams:** 本人记忆 HTTP 接口、PersonalMemory 公开接口、主 Runtime 参考消费；磁盘和 PostgreSQL 使用真实临时资源，模型/远端服务在外部边界受控。

## Execution

Each ticket uses one implement subagent in an isolated worktree; red/green evidence and Standards/Spec review evidence must be recorded before resolution. User-approved public seams and fixed point are in ticket-breakdown.md.

### Checkpoint 2026-10-15
- RED: public Personal module missing (15:50), own HTTP returned404 (15:53), runtime personal reference absent (15:54).
- GREEN: 4 public service/HTTP/main-chat tests pass (15:55); API typecheck and contracts/OpenAPI generation pass.
- Isolated real PostgreSQL databases and real temporary files; provider controlled at ConversationRuntime boundary.
- Additional failure/recovery and concurrent forget coverage plus two-axis review are in progress; this is a buildable dependency checkpoint, not ticket completion.
