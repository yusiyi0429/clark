# 09: 完成 Meeting 创建与会前准备

Type: implementation
Status: resolved
Blocked by: 03 提供只读 CompanyMemory MCP 与稳定人员目录; 05 补齐 Search、compaction 与 Runtime 恢复; 07 自动升级 Issue 并接收 DRI Issue

## What to build

让 CEO 从 Issue 创建或加入 Meeting，并完成可持久化的会前材料、participant 管理、核对状态、Supplement Request 与 scheduled Meeting 取消。

## Acceptance criteria

- [ ] CEO 可从 Issue 新建 Meeting 或加入已有 scheduled Meeting，DRI 服务接口也可导入合法 Meeting 元数据。
- [ ] participant 只能从稳定 Person 目录选择并保存身份快照；CEO 身份可确定识别。
- [ ] Meeting Agent 使用关联 Issue、ResearchDoc 和 CompanyMemory 生成 Candidate Preflight，失败可见且不自动重试。
- [ ] CEO 的已阅、已核对和带到会议状态持久化；已核对条目内容变化时自动取消核对。
- [ ] Supplement Request 保存真实状态：已记录、pending_export、delivered 或 failed；没有渠道回执时不显示已送达。
- [ ] 只有 scheduled Meeting 可以取消，held 或 reviewed Meeting 不可取消。
- [ ] Meeting Card、对象页面、会前通知和独立 Conversation 投影同一 Meeting。
- [ ] 本 ticket 不建设日历同步、会议管理中心、录音或会后 Action 分派。

## Comments

- 实现：`packages/contracts/src/meetings.ts`（Meeting/Preflight/Supplement/Draft 契约 + 严格 `PreflightCandidate`）、`apps/api/migrations/007_meetings.sql`（`meetings` 表，无 Notification/日历实体）、`apps/api/src/meetings.ts`（创建/加入/DRI 导入、participant 身份快照、Preflight 运行与失败可见、draft 准备状态、Supplement 真实外发状态、scheduled 取消、启动恢复）、`apps/api/src/preflightAgent.ts`（`submit_candidate` 严格候选 + 场景 Prompt）。
- Issue → Meeting：`projectIssueCard` 暴露 `issue.create_meeting` / `issue.join_meeting`；Action 执行器按 actionType 分派，Meeting 侧 action 用确定性 actionId + `action_fingerprints` 幂等重放，version 冲突返回 `latestCard`。
- participant 只来自 CompanyMemory seed：ceo 必须具 `ceo` 角色、leadDri 必须具 `dri` 角色，保存 `personId/displayName/roles/sourceRef/updatedAt` 身份快照；不存在自由文本参与人。
- Preflight：临时 Agent 严格候选经 schema + `issue:/research:/memory:` sourceRef 白名单二次校验后写入；失败以 `failed:error` 可见且不自动重试；显式 `meeting.retry_preflight`；180 秒超时 abort；join 后按当前关联 Issue 整体重建并清空旧核对；启动时把崩溃遗留的 pending/running 标为 `failed:preflight_interrupted`。
- 准备状态：`read/carried/checked/edits/note` 持久化；编辑已核对 entry 自动取消核对；条目重建时核对与编辑一并失效。
- Supplement Request：先事务保存 `recorded`，再走真实 exporter；无渠道停在 `pending_export`，成功才 `delivered`，失败 `failed`；状态回写持行锁。
- 投影：Meeting Card、`/api/cards/meetings/:id`、`/api/cards/notifications`（同一 projector）与 `meeting:<id>` Conversation scope 指向同一持久对象；`issue.join_meeting` 的 Meeting 行锁在 error/conflict 路径统一 ROLLBACK。
- 验证：contracts 15 + API 113 测试、`pnpm -r typecheck`、`pnpm -r build`、`git diff --check` 全部通过；Web client 由 OpenAPI 重新生成。**未包含** Transcript/Outcome（Ticket 10/11）、录音、日历同步、会议管理中心、DRI UI。
- Review：Herdr 只读 deepseek-flash reviewer 四轮 Standards/Spec 双轴复核，最终无 blocking。有效发现均经主 agent red→green 修复：错误/冲突路径事务与行锁泄漏（独立连接 `pg_stat_activity` 探针）、join 后预审重建与旧核对失效、加入已在会议的 Issue 为 no-op、重建失败清核对、外发状态回写持行锁、preflight 超时 abort、Issue 侧 action 的 version/status 校验（幂等优先）、OpenAPI 未引用组件与零值别名删除。
