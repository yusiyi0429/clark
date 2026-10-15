# 04 Meeting、Transcript 与 Outcome

## 1. 职责

实现 Issue 的可选 Meeting 路径、会前预审、严格 Transcript 导入、MeetingOutcome 抽取、逐项确认和精确撤回。

不实现日历、录音、ASR、说话人映射或会议管理页。

## 2. Meeting 创建

来源：

- Issue Action：加入已有 Meeting／新建 Meeting；
- DRI Meeting import。

必填：title、time、leadDriId、ceoParticipantId、participants、issueIds。人员 ID 必须来自 PeopleDirectory；保存 name/role snapshot。

状态：

```text
scheduled → held → reviewed
scheduled → cancelled
reviewed → held   # 撤回已确认 Outcome effect 后
```

## 3. Preflight

Meeting 创建后启动临时 Pi Session。会前预审采用 advisor-review 后端场景：方法固化在后端 Prompt，当前对象提供待审材料，公司正式事实通过授权只读 World Company 获取，不在运行时加载 `.agents` 文件。

四输入映射不新增 Material 实体：背景来自关联 Issue 与 CompanyMemory；目的由 Meeting 标题和 Issue 决策问题推导并明确标记；源材料来自 ResearchDoc 与当前 Meeting 内嵌会前材料的受限抽取文本；关联会议取最近一场包含相同 Issue 的历史 Transcript/Outcome。缺失项写入 `inputCoverage` 并显示“待补”，不得由模型猜造。

候选严格输出材料任务定义、`ready | revise | blocked`、七类条目（核心判断、战略一致性、积极信号、风险校准、3–5 个会议追问、下一阶段建议、一号位视角预判）及一句话总结。视角预判必须标注“非权威发言”；内部校验过程不进入 Card。

代码验证条目数量、issue/research/material/history/memory sourceRef、字段完整性后写现有 `Meeting.preflight` JSONB。旧 preflight 保持兼容；CEO 显式“重新预审”才运行，不会后台静默重跑。

Draft 保存：checkedEntryIds、editsByEntryId、readIssueIds、pinnedIssueIds、supplementRequests、note。编辑已核对 entry 或重新生成预审时，API 自动移除已失效的核对状态。

## 4. Meeting Material

Meeting Material 是 `Meeting.materials[]` 内嵌值对象，不建立表或第七实体。每项保存 `id`、`fileName`、`mimeType`、`sizeBytes`、`pageCount?`、`receivedBy`、`providedBy?`、`uploadedAt`、`storageKey`、`sha256` 与受限抽取结果；原件不进入 Action JSON、JSONB、Web 持久化或 Agent 的自由读取范围。

仅 CEO 可为 `scheduled` Meeting 通过独立 multipart endpoint 替换**整个**会前材料集，允许空集。仅允许有有效文字层的 PDF、DOCX、Markdown；单文件最大 20 MiB、最多 10 份、整批最大 100 MiB、每份抽取文本最大 100,000 字符、总输入最大 300,000 字符。PDF 最多 500 页；DOCX 最多 1,000 ZIP entries、250 MiB 解压总量、50 MiB 单 entry 与 200:1 压缩比。PDF 文件头必须为 `%PDF-`，空文字层、加密或损坏即拒绝；DOCX 必须是含 OOXML 必要入口的 ZIP，拒绝路径穿越、嵌套压缩包、图片和外部资源；Markdown 仅接受严格 UTF-8 的 `.md` 并作为受限纯文本。每份在独立临时目录中由无 shell 的受限 Node 子进程顺序解析，使用 `--max-old-space-size=256`，15 秒后 `SIGTERM`、额外 2 秒后 `SIGKILL`；整批最长 90 秒。解析实现固定为 `pdfjs-dist`、`mammoth` 与 ZIP 预检，不引入 `pdf-parse`、native addon 或 Office 服务。任何文件失败即整批拒绝，不保存原件、元数据或部分结果；不支持 OCR、TXT、PPT/PPTX、扫描件或图片型文件。

验证通过后才原子写入新元数据与 volume 文件、删除旧材料元数据/原件/抽取文本，并将 preflight 置为 `pending`。不自动调用模型。`scheduled + ready` 时材料只读，CEO 必须确认“返回编辑材料”令当前 Candidate Material 失效并保持 `pending`，之后才能替换、清空或手动重新预审；即使不更换材料离开页面也不恢复 `ready`。`held`、`reviewed`、`cancelled` 始终只读；Outcome 原始材料视图仅查看，没有该回退入口。

PDF 经鉴权 API 流式预览/下载，Markdown 安全渲染且禁用 raw HTML/外部资源，DOCX 仅按需以 `mammoth` 生成 HTML、经服务端显式 allowlist sanitizer 后显示并允许下载；不持久化 HTML。sanitizer 仅允许 `p`、标题、列表、强调、表格和受限 `https` 链接，删除 style、事件属性、外部图片及 `javascript:`、`data:`、`file:` 等危险协议。旧 preflight 的失效 `material:<id>` 引用只显示“材料已由 CEO 替换/移除，原件不再保留”。Outcome 永远只输入 `warmap-transcript.v1`。

## 5. Supplement Request

Supplement Request 只保留向 DRI 外发补充信息及真实渠道回执；它不提供上传、移除或动态状态机，也不直接持有附件。

补充材料**文件**由 CEO 会外收件后上传至 `Meeting.materials[]`（`kind: "supplement"`、`supplementFor` 指向已记录请求）：仅 scheduled Meeting 可上传，单文件受限解析与主材料同规格；不自动重置或触发预审，仅在 CEO 显式重新预审时纳入输入；整批替换主材料时随 preflight 重置一并清空；held/reviewed/cancelled 只读。

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

## 6. warmap-transcript.v1

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

## 7. Transcript 替换

默认不静默覆盖。仅 Outcome 没有 confirmed effect 时允许危险 Action 替换，并要求二次确认。替换事务整体删除旧未确认 Outcome candidate、保存新 Transcript、保持 Meeting.held，并使旧 Card/actionId 因 version 变化失效；旧 AgentRun 保留，事务提交后强制启动新的 PostMeeting run。已有任何 confirmed effect 时禁止替换。

## 8. PostMeeting Agent

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

## 9. Outcome Review

每个 decision、todo、ceoJudgment、reopenWhen 有独立 Review：

```text
pending → confirmed
pending → dismissed
confirmed → pending  # effect 可撤回时
```

整体状态派生：全部 pending 为 draft，部分处理为 reviewing，全部处理为 confirmed。没有 review item 时直接 confirmed。

reopenWhen 是父 decision 的附属条件：只有父 decision confirmed 后才可确认；父 decision dismissed 时，其 pending reopenWhen 在同一事务中自动 dismissed，原因 `parent_dismissed`；撤回父 decision 时同步撤回其已确认 Radar anchors。

## 10. Deterministic effect

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

## 11. confirm-item 事务

1. 锁 Outcome；
2. item 必须 pending；
3. 写对应数据库 effect；
4. 写 effectRef；
5. item confirmed；
6. 派生 reviewStatus；
7. 全部处理则 Meeting reviewed；
8. 提交后尝试外部 export。

不同 item 仍由 Outcome 行 version 串行，避免两个确认互相覆盖。

## 12. dismiss-item

pending → dismissed，只记录原因和时间，不产生 effect。全部 item 处理后同样可使 Meeting reviewed。

## 13. 撤回

所有撤回都进入统一 `revokeEffect(effectRef)` 领域用例。Issue 页面遇到 meeting-item Receipt 时必须委托该用例，不能直接改 Receipt。

- decision：标记指定 Receipt revoked，并同步 Outcome item；
- todo：未 delivered 可取消；delivered 禁止自动撤回并提示人工处理；
- judgment：清除本 item confirmed；
- reopen：删除 deterministic Radar anchor；
- item 回 pending；
- Meeting reviewed 回 held。

不建立跨系统补偿。

## 14. Open item

open 只展示 quote 和内容，不带 Review，不提供形成 Issue。新问题由 DRI 之后重新提交。

## 15. Card

Meeting detail 在 scheduled 显示 preflight，在 held/reviewed 可显示 Transcript/Outcome 对照。会后通知仅投影 pending review items，并在浮卡内 confirm/dismiss/revoke。

稳定 URL 不创建独立会后页面。

## 16. API/Action

- create/add Meeting 走 Issue Action；
- DRI Meeting 走 service import；
- preflight draft/submit/request supplement 走 Action；
- Transcript 走 multipart Action 或 service API；
- retry Outcome 仅 held + failed；
- item review/revoke 走 Action。

## 17. 失败

- Preflight 失败：Meeting scheduled，页面显示失败并可重试；
- Transcript 失败：不写任何 turn，Meeting 状态不变；
- Outcome 失败：Transcript 保留，Meeting held；
- export 失败：item confirmed，但 exportStatus=failed；
- 不自动 retry 或升档。

## 18. 测试 seam

- 创建／导入 Meeting；
- participant ID；
- preflight 编辑使核对失效；
- scheduled-only 材料集替换、`ready` 只读、确认回退、空材料集、未变材料手动重跑与 Outcome 只读；
- 材料批次的格式、容量、抽取失败原子拒绝，及删除材料引用的降级展示；
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

## 19. 完成条件

一条 DRI Issue 完成 Meeting 创建、Preflight、Transcript、Outcome 和至少两个 item 的分别处理；撤回一项不影响另一项；open item 不产生 Issue。
