# 07 — 切换后的历史兼容、集成验收与 PR 级审查

Type: implementation
Status: resolved

**What to build:** 原有用户进入新主聊后仍保有原始聊天，新的事实与个人记忆链路可靠；所有切片在同一分支组合后没有新旧上下文混用、越权或遗忘回流。

**Blocked by:** 02、03、04、05、06。

这是集成验收票，不再发明新功能；各行为票在本票之前应能独立验证。

- [x] 仅重建可替换 Pi entries，保留原始聊天，兼容没有新字段的已有客户端。
- [x] 运行 30 条固定验收场景的机制检查；真实模型/World 未执行项与已通过结果分开报告。
- [x] 完成相关检查和最终全量检查，区分环境缺失、原有失败与本次缺陷。
- [x] 对整体差异执行 Standards/Spec 两轴独立 review，修复有效发现后重验并提交。

**TDD seams:** Web → messages HTTP → Pi → 工具/记忆的端到端公共行为；不通过直接数据库读取替代用户可观察断言。

## Execution

Each ticket uses one implement subagent in an isolated worktree; red/green evidence and Standards/Spec review evidence must be recorded before resolution. User-approved public seams and fixed point are in ticket-breakdown.md.


## Result

Implemented in isolated `memory/07-integration` worktree. Own source commits: `ec30929`, `aed5a3d`, `3861244`. Dependency cherry-picks present in this worktree are `6fff41d` (original `a483bbd`), `7a58f73` (`76aebf1`), `0b1a043` (`b341a3e`), `1ae2d5d` (`17cc954`); the integrating parent already has these dependency changes and should not apply them twice.

Public TDD/ablation, full-run failures and focused repairs are recorded in [the integration report](../reviews/07-integration.md); [30-case coverage](../acceptance-matrix.md) distinguishes tested mechanisms from unrun model/World semantics. The broad API run was 944/949 initially; every failed behavior's complete file was rechecked after the corrections, including the existing introduction timing test. Latest changed tests: 32/32, API typecheck/build green; Web814/contracts75/M296 and monorepo typecheck/build passed.

Two independent Ticket07 axes at fixed base `9e4779b` through `3861244`: Standards0; Spec initial P2 cursor binding corrected, final0 unresolved. Parent owns the separate final PR-level review against `b32e531`; no remote publish/deploy performed.
