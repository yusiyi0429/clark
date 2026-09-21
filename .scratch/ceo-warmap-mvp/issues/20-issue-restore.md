# 20: dismissed Issue 恢复 Action

Type: implementation
Status: implemented（2026-09-20，独立切片）

## What to build

CEO 可把已移出决策面（dismissed）的 Issue 恢复为 pending：语义按钮、dismissed-only、幂等重放、版本防护；source/Research/Receipt 不动，移出字段保留为审计。

## Acceptance criteria

- [x] `issue.restore` 注册进 `ISSUE_ACTION_INPUTS`（无输入 schema）， dismissed 卡片仅暴露该 Action。
- [x] 非 dismissed（pending/decided）执行返回 409 `ISSUE_NOT_DISMISSED`；陈旧版本非重放返回 409 `VERSION_CONFLICT`。
- [x] 幂等：`restore_fingerprint` 持久化（migration 015），重复提交同一 actionId 返回 200 且版本不再变；重放优先于 version 校验（既有约定）。
- [x] 恢复只置 `status='pending'` 并写 `restored_at`/`restore_fingerprint`，`dismissed_at`/`dismiss_reason`/`dismiss_fingerprint` 保留为移出审计；research JSONB、receipts、origin 均不改动；version +1。
- [x] IssueCard 在 dismissed 态渲染语义按钮「恢复到待处理」（`Undo2` 图标，pending 时禁用）。
- [x] 聚焦测试：恢复成功 + 审计保留 + 幂等重放；guards（pending/decided 拒绝、陈旧版本冲突）。

## Touchpoints

- `apps/api/migrations/015_issue_restore.sql`
- `packages/contracts/src/issues.ts`（`IssueRestoreInput`）、`packages/contracts/src/openapi.ts`
- `apps/api/src/issues.ts`（columns/row/actions/registry/replay/execute/projection）
- `apps/web/src/cards/payloads.ts`、`apps/web/src/cards/IssueCard.tsx`
- `apps/api/test/issueDecision.test.ts`、`apps/api/test/migrate.test.ts`
