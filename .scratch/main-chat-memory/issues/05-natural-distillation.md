# 05 — 主私聊结束后自然蒸馏个人记忆

Type: implementation
Status: ready-for-agent

**What to build:** 用户自然表达长期偏好或反复的个人情况，无需说“记住”，会在后续私聊中体现；当前回答不被后台蒸馏阻塞。

**Blocked by:** 04（持久存储、版本、遗忘和主聊消费已可用）。

- [ ] 对话成功提交与持久任务排队一致；重启、重复消费和并发更新不丢失或覆盖新纠正。
- [ ] 只依据本人消息蒸馏，不把 Company、Anchor、假设、他人话语或助手推测当本人事实。
- [ ] 支持 add/update/remove/noop，区分明确偏好与谨慎归纳；失败不影响主回答。
- [ ] 明确纠正/遗忘不依赖助手成功回答；旧任务不能复活已遗忘内容。

**TDD seams:** messages HTTP 到下一轮公开记忆读取的完整行为、Personal 蒸馏 worker 的公开任务接口；模型响应在 provider 边界受控，不 mock 内部函数。

## Execution

Each ticket uses one implement subagent in an isolated worktree; red/green evidence and Standards/Spec review evidence must be recorded before resolution. User-approved public seams and fixed point are in ticket-breakdown.md.
