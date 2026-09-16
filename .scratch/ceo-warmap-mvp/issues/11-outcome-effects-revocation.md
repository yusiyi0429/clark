# 11: 逐项确认 MeetingOutcome 效果

Type: implementation
Status: resolved
Blocked by: 06 从真实来源生成可管理的 Signal; 10 导入 Transcript 并抽取 MeetingOutcome

## What to build

让 CEO 分别处理 MeetingOutcome 的 decision、todo、CEO judgment 和 reopenWhen；每项确认后立即产生精确效果，忽略或撤回一项不影响其他项。

## Acceptance criteria

- [x] 每个可审阅 item 独立处于 pending、confirmed 或 dismissed，open item 只展示且不能创建 Issue。
- [x] decision confirmation 创建精确 Issue Receipt；todo confirmation 创建带真实状态的 DRI Handoff。
- [x] CEO judgment 保留在 MeetingOutcome，不直接写入 CompanyMemory。
- [x] reopenWhen 只能在父 decision confirmed 后确认并写入 Radar anchor；父 decision dismissed 或撤回时同步清理子条件和 anchor。
- [x] confirm 与 dismiss 使用 Outcome version 串行，重复 action fingerprint 不产生第二个 effect。
- [x] `revokeEffect(effectRef)` 同步处理 Outcome item、Receipt、Radar anchor、Handoff 可撤销部分和 Meeting 派生状态。
- [x] 已 delivered 的外部效果按契约禁用撤回或返回明确 warning，不报告虚假恢复。
- [x] 至少两个 item 可分别确认；撤回其中一个后另一个 effect 保持不变。
- [x] 全部可审阅 item 已 confirmed 或 dismissed 时 Meeting 自动进入 reviewed。

## Comments

实现摘要：

- `packages/contracts`：`OutcomeReview` 增加可选 `handoff`（pending_export/delivered/failed）、`anchorId`、`reason`；新增严格输入 `MeetingConfirmItemInput`/`MeetingDismissItemInput`/`MeetingRevokeEffectInput`；`IssueReceipt.source` 记录 meeting-item 精确来源；`RadarAnchor` 增加字面量 `source`（meeting-reopen/ontology）与 `originRef`；三个 Action 输入进入 OpenAPI components 并重新生成 Web client。
- `apps/api/src/effects.ts`：统一 `revokeEffect(effectRef)` 领域用例按前缀分派——`issue:` Receipt 撤回（`revokeIssueReceipt` 纯函数）与 `meeting:decision|todo|judgment|reopen:<itemId>` 撤回。meeting 撤回在同一事务内同步 Outcome item、关联 Issue Receipt 与 Issue 状态、Radar anchor、Meeting 派生状态；`delivered` Handoff 拒绝撤回并返回 `EFFECT_NOT_REVOCABLE` 明确 warning。`deriveMeetingStatus`/`meetingEffectRef`/reopen anchor 构造与增删都在此集中，构造与解析共用同一 kind↔slug 映射。
- `apps/api/src/meetings.ts`：`meeting.confirm_item`/`dismiss_item`/`revoke_effect` 走 Card 签名 actionId（itemId 在 scope 内）+ fingerprint 幂等 + Meeting version 串行。decision 确认写入关联 Issue Receipt（来源 meeting-item）；todo 确认生成内嵌 DRI Handoff，`pending_export` 为默认，仅在真实 exporter 回执后写 `delivered/failed`；judgment 只保留在 Outcome；reopenWhen 要求父 decision confirmed 并写确定性 Radar anchor。父 decision dismissed 时 pending 子条件同事务 `parent_dismissed`，撤回父时同步删除子 anchor 并回 pending。open item 无 Review、无任何逐项 Action、无创建 Issue 入口；无法解析关联 Issue 的 decision 不暴露确认。无 confirmed effect 的 held/reviewed Meeting 可替换 Transcript，替换后回到 held。
- `apps/api/src/issues.ts`：Issue 页面 `issue.revoke_receipt` 遇到 `meeting:` Receipt 时委托统一 `revokeEffect`，用 Card 上的 Issue version 串行，避免 Issue/Outcome/Meeting 漂移；meeting Receipt 不再走旧的 `EFFECT_REVOKER_PENDING` 占位。
- `apps/api/src/outcome.ts`：抽取 ready 时即派生 Meeting 状态，无可审阅条目（只有 open 或 0 item）按 doc 04 §8 直接 reviewed。
- 未新增 Todo/Action/Mission 等实体；Outcome item、Handoff、Receipt、anchor 都保持内嵌结构；未写 CompanyMemory。

验证：

- `apps/api`：14 文件 / 190 tests passed（新增 `test/outcomeEffects.test.ts` 19 条，覆盖 9 条 AC：逐项独立状态与 open 只展示、decision Receipt、todo pending_export/delivered/failed、judgment 不写外部、reopen 父约束与 anchor 清理、confirm/dismiss/revoke 重放与 version 冲突、Issue 页面委托撤回、delivered 不可撤回、两项独立撤回、reviewed 派生与真空 reviewed、reviewed 换稿）。
- `@warmap/contracts`：25 tests passed（新增 OutcomeReview/输入契约、IssueReceipt.source、RadarAnchor source 字面量校验）。
- `pnpm -r typecheck`、`pnpm -r build`（contracts + api + web）通过；`pnpm --filter @warmap/web gen:client` 重新生成 OpenAPI client，`git diff --check` 干净。

内部 review：

- Herdr 启动 deepseek-flash 只读 reviewer，Standards/Spec 双轴三轮，最终无 blocking。第一轮 4 条 Medium 全部 red→green 修复并各自加回归测试：revoke fingerprint 重放幂等、Issue 页面委托使用 Card version 串行、无可解析关联 Issue 的 decision 不暴露确认、无可审阅条目真空 reviewed。第二轮复核确认修复成立、无回归；第三轮收口确认 reviewed 换稿与 dismiss 重放测试无回归。

延后边界：

- ownerPersonId 缺失的 todo 以及「confirm 提交后、外发前进程中断」会让 Handoff 停在 `pending_export` 且当前没有显式重试入口；MVP 无真实渠道，保持诚实 pending_export，重试入口与 DRI 出站导出 API（doc 05 §9）随 Ticket 13 的 DRI export 边界一起落地。
- Meeting 关联多个 Issue 且 decision item 未提供 issueId 时无法确定精确 Receipt 目标：Card 不暴露确认、服务端返回 `DECISION_ITEM_WITHOUT_ISSUE`，只能忽略；抽取期推断归属留待后续。
- `RadarAnchor.source` 的 `ontology` 取值是为 Ticket 13 月度签发预留的契约词汇，本票只生产 `meeting-reopen`。
- Web 上逐项处理与浮卡交互属 Ticket 14；本票只交付 API/Card/Action 与持久效果。
