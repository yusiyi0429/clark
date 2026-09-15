# 04 Meeting、Transcript 与 Outcome

## 1. 职责

实现 Issue 的可选 Meeting 路径、会前预审、严格 Transcript 导入、MeetingOutcome 抽取、逐项确认和精确撤回。

不实现日历、录音、ASR、说话人映射或会议管理页。

## 2. Meeting 创建

来源：

- Issue Action：加入已有 Meeting／新建 Meeting；
- DRI Meeting import。

必填：title、time、leadDriId、ceoParticipantId、participants、issueIds。人员 ID 必须来自 CompanyMemory MCP；保存 name/role snapshot。

状态：

```text
scheduled → held → reviewed
scheduled → cancelled
reviewed → held   # 撤回已确认 Outcome effect 后
```

## 3. Preflight

Meeting 创建后启动临时 Pi Session。输入关联 Issue、ResearchDoc 和 CompanyMemory passages，输出 entries、basis、brief。

代码验证 issueId、sourceRef、字段完整性后写 `Meeting.preflight`。

Draft 保存：checkedEntryIds、editsByEntryId、readIssueIds、pinnedIssueIds、supplementRequests、note。编辑已核对 entry 时 API 自动移除 checked ID。

## 4. Supplement Request

```text
id
entryId
targetDriId
text
exportStatus: recorded | pending_export | delivered | failed
exportRef?
createdAt
```

先事务保存，再异步调用 DRI exporter。发送失败不回滚 preflight。没有真实渠道时保持 pending_export。

## 5. warmap-transcript.v1

统一使用已确认的 `warmap-transcript.v1` 模板。上传既可来自 CEO Meeting 页面，也可来自 service API。

校验：

- schemaVersion；
- meetingId 与目标一致；
- turns 非空；
- turnId 唯一；
- speakerId 属 participants；
- text 非空；
- startedAt 有值时带时区且顺序合法；
- 文件大小和 UTF-8；
- 任一项错误整份拒绝。

校验成功后单事务保存 JSONB 并把 Meeting 改 held，随后启动 Outcome run。

## 6. Transcript 替换

默认不静默覆盖。仅 Outcome 没有 confirmed effect 时允许危险 Action 替换，并要求二次确认。替换事务整体删除旧未确认 Outcome candidate、保存新 Transcript、保持 Meeting.held，并使旧 Card/actionId 因 version 变化失效；旧 AgentRun 保留，事务提交后强制启动新的 PostMeeting run。已有任何 confirmed effect 时禁止替换。

## 7. PostMeeting Agent

输入 participant snapshots、Transcript turns、关联 Issue/ResearchDoc、CEO ID。使用 HEAVY_MODEL，输出 decisions、todos、open、ceoJudgments、warnings。

代码硬校验：

- QuoteRef.turnId 存在；
- quote 连续存在该 turn；
- speaker 只能从 turn 取得；
- owner 来自明确点名或“我来”的 speaker；
- CEO 判断必须来自 CEO turn；
- kind 属五类 CEO 权限；
- issueId 属 Meeting issueIds；
- 无效候选进入 warnings，不进入 review items。

## 8. Outcome Review

每个 decision、todo、ceoJudgment、reopenWhen 有独立 Review：

```text
pending → confirmed
pending → dismissed
confirmed → pending  # effect 可撤回时
```

整体状态派生：全部 pending 为 draft，部分处理为 reviewing，全部处理为 confirmed。没有 review item 时直接 confirmed。

reopenWhen 是父 decision 的附属条件：只有父 decision confirmed 后才可确认；父 decision dismissed 时，其 pending reopenWhen 在同一事务中自动 dismissed，原因 `parent_dismissed`；撤回父 decision 时同步撤回其已确认 Radar anchors。

## 9. Deterministic effect

```text
meeting:<meetingId>:decision:<itemId>
meeting:<meetingId>:todo:<itemId>
meeting:<meetingId>:judgment:<itemId>
meeting:<meetingId>:reopen:<itemId>
```

- decision → Issue Receipt；
- todo → DRI Handoff/export 状态；
- judgment → Outcome 内 confirmed Organization Fact；
- reopen → Radar anchor。

## 10. confirm-item 事务

1. 锁 Outcome；
2. item 必须 pending；
3. 写对应数据库 effect；
4. 写 effectRef；
5. item confirmed；
6. 派生 reviewStatus；
7. 全部处理则 Meeting reviewed；
8. 提交后尝试外部 export。

不同 item 仍由 Outcome 行 version 串行，避免两个确认互相覆盖。

## 11. dismiss-item

pending → dismissed，只记录原因和时间，不产生 effect。全部 item 处理后同样可使 Meeting reviewed。

## 12. 撤回

所有撤回都进入统一 `revokeEffect(effectRef)` 领域用例。Issue 页面遇到 meeting-item Receipt 时必须委托该用例，不能直接改 Receipt。

- decision：标记指定 Receipt revoked，并同步 Outcome item；
- todo：未 delivered 可取消；delivered 禁止自动撤回并提示人工处理；
- judgment：清除本 item confirmed；
- reopen：删除 deterministic Radar anchor；
- item 回 pending；
- Meeting reviewed 回 held。

不建立跨系统补偿。

## 13. Open item

open 只展示 quote 和内容，不带 Review，不提供形成 Issue。新问题由 DRI 之后重新提交。

## 14. Card

Meeting detail 在 scheduled 显示 preflight，在 held/reviewed 可显示 Transcript/Outcome 对照。会后通知仅投影 pending review items，并在浮卡内 confirm/dismiss/revoke。

稳定 URL 不创建独立会后页面。

## 15. API/Action

- create/add Meeting 走 Issue Action；
- DRI Meeting 走 service import；
- preflight draft/submit/request supplement 走 Action；
- Transcript 走 multipart Action 或 service API；
- retry Outcome 仅 held + failed；
- item review/revoke 走 Action。

## 16. 失败

- Preflight 失败：Meeting scheduled，页面显示失败并可重试；
- Transcript 失败：不写任何 turn，Meeting 状态不变；
- Outcome 失败：Transcript 保留，Meeting held；
- export 失败：item confirmed，但 exportStatus=failed；
- 不自动 retry 或升档。

## 17. 测试 seam

- 创建／导入 Meeting；
- participant ID；
- preflight 编辑使核对失效；
- supplement 三种状态；
- Transcript 全部无效场景和原子性；
- quote 必须在目标 turn；
- owner/CEO 权限；
- warnings；
- 两项独立确认；
- dismiss；
- 精确撤回；
- delivered todo 不伪撤回；
- Issue 页面撤回 meeting Receipt 不造成 Outcome/Meeting 漂移；
- decision dismissed/撤回时 reopenWhen 不产生孤儿 anchor；
- Transcript 替换使旧 candidate 和 actionId 失效；
- reviewStatus/Meeting 状态派生。

## 18. 完成条件

一条 DRI Issue 完成 Meeting 创建、Preflight、Transcript、Outcome 和至少两个 item 的分别处理；撤回一项不影响另一项；open item 不产生 Issue。
