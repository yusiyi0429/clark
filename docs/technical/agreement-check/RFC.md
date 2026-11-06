# RFC：约定与对表（V1 后端）

2026-11-06 · 分支 `claude/v1-agreement-api` · 设计依据：《约定与对表：V1 开发设计》v0.2（第 3–7、9 节，第 12 节「A 后端」）· 决定见 [ADR 0033](../../adr/0033-task-agreements-in-tianshu-for-november.md)

## 0. 一句话

本体 Task 的每条验收标准写清「用什么证明、谁来认」，再加「这次不包括什么」。DRI 随时对表，只会得到两种回答之一：还不能交、差哪几条；或者约定的都有证据、可以交。对表不调模型，也不卡交付。

## 1. 范围

| 做了 | 没做（不在这次） |
|-|-|
| 契约 `agreements.ts`；迁移 225；约定读取（本体优先、天枢补充、只有原文）和 11 月补充的存取；对表；「请 X 看」飞书推送；参考评审两处改动；`/internal` 两个只读接口；MCP 三个工具和 `list_my_items` 两个字段；交付物读权限放宽 | 网页（`apps/web`，分支 `claude/v1-agreement-web`）；新 Chat API 的锚点和两个工具（设计第 10 节，等新 Chat API）；本体 Task 加字段（斯一，12 月）；Mission 确认时填约定（溪南，12 月）；认可人在天枢里逐条确认 |

## 2. 组成

| 文件 | 做什么 |
|-|-|
| `packages/contracts/src/agreements.ts` | `TaskAgreementResponse`、`PutTaskAgreementRequest`、`TaskCheckResponse`、`CheckNotifyRequest/Response` |
| `apps/api/migrations/225_task_agreement_notes.sql` | 11 月补充 `task_agreement_notes`、修改记录 `task_agreement_note_revisions`、`deliverable_versions.agreement` 快照列 |
| `apps/api/src/planTasks.ts` | `worldAgreementOf`：从本体 Task 的 definition 块读 `proof` / `acceptor` / `exclusions`，挂在 `PlanTask.agreement` |
| `apps/api/src/planTaskAccess.ts` | `locatePlanTask`：找 Task、判看的人和它的关系；`taskBasis`；`planTaskViewer` |
| `apps/api/src/taskAgreements.ts` | 读约定、存补充、对表、「请 X 看」、`list_my_items` 汇总、传版本时的约定快照 |
| `apps/api/src/routes/agreements.ts` | 4 个公开接口 |
| `apps/api/src/routes/internalMeetings.ts` | `/internal/plan-tasks/:taskId/agreement`、`/check` |
| `apps/api/src/mcpAgreements.ts` | 3 个 MCP 工具；`mcpMe.ts` 只接线 |
| `apps/api/src/deliverableReview.ts` | 评审输入带 `proof`、`exclusions`；输出 `beyondScope` |

## 3. 数据（迁移 225）

`task_agreement_notes`，主键 `task_id`，只给 11 月补用：

| 列 | 说明 |
|-|-|
| `basis` | `acceptance` 或 `definition`，和交付物评审同一套 |
| `criteria` | `[{index, text, proof, acceptorId}]`；`text` 是当时的标准原文，`acceptorId` 为 null 表示有对表的证据就算数 |
| `exclusions` | `text[]`，这次不包括什么 |
| `basis_hash` | `sha256(JSON.stringify([basis, criteria]))`，标准改了就对不上 |
| `revision`、`updated_by`、`updated_at` | 每存一次 `revision` 加 1 |

- 没有认可状态：这是补充说明，不是另一道认可。
- `task_agreement_note_revisions`（主键 `task_id, revision`）：每存一次留一份整份的约定，和主表在同一个事务里写。
- `deliverable_versions.agreement`：传版本时约定的快照 `{proofs: (string|null)[], exclusions: string[]}`，和这一版的 `criteria` 一一对应；一条都没写、也没写不包括什么时为 null。评审只看快照，之后改约定不影响已经传的版本。

## 4. 读约定

顺序：本体 → 天枢补充 → 只有原文（`source` 依次是 `world`、`tianshu`、`none`）。

- **本体**：Task 的 definition 块里只要出现一项 `proof`、`acceptor` 或 `exclusions`，整个 Task 就用本体的，不再读天枢补充，也不能在天枢里改（PUT 回 409 `AGREEMENT_FROM_WORLD`）。字段 12 月才由斯一加，形状先按这几种兼容读取（测试用假数据）：
  - 每个 `acceptance_criterion` 组件上的 `proof`（文字）、`acceptor`（主体 id 字符串，或带 `principal_id` 的引用）；没有验收标准时看完成定义那个 `outcome` 组件；
  - 块上的 `exclusions` 字符串数组，或 `exclusion` 组件的文字；
  - `acceptor` 经实例配置的 people 换成天枢 personId，对不上为 null 并记 `AGREEMENT_ACCEPTOR_UNMAPPED`。
- **天枢补充**：按现在的标准逐条对回去，三遍：原文一样的；一条包含另一条的（补了几个字）；同一个序号上被改了字的（原文已不在现在的标准里）。对不上的条算没写。`basis_hash` 和现在的标准对不上时 `basisChanged=true`。
- **标准**：有验收标准按验收标准（`acceptance`）；没有时按完成定义算一条（`definition`）；两样都没有（`none`）就没有约定可写，PUT 回 409 `NO_CRITERIA`。
- **补全**（`complete`）：有标准，而且每条都写了「用什么证明」；谁来认、这次不包括可以空。
- **存补充**（PUT）：整份覆盖。没写到的序号算没写；序号越界或重复 400 `INVALID_INPUT`；认可人不在人员目录 400 `UNKNOWN_PERSON`。

## 5. 权限

看的人和 Task 的关系由 `locatePlanTask` 判：先在本人的 Mission 里找（和首页同一组，缓存是热的），找不到再在公司当期全部 Mission 里找（第一次读本体可能慢，等 8 秒）。

| 谁 | 读约定、对表、交付物和原文件 | 改约定 | 传版本、交付、异议、重评、改说明 | 请 X 看 |
|-|-|-|-|-|
| 负责人（本体没登记时是 Mission 负责人） | ✓ | ✓ | ✓ | ✓ |
| Mission 负责人 | ✓ | ✓ | 只在他就是负责人时 | 同左 |
| 战场负责人（Mission 挂的战场由他负责） | ✓ | — | — | — |
| CEO（按人员目录认，不看当前视角） | ✓ | — | — | — |
| 约定里的认可人 | ✓ | — | — | — |
| 其他人 | 404 | 404 | 404 | 404 |

- 能看但不能改的人改：403。交付物的写接口仍要求成员工作台视角；读接口两种视角都行。
- 交付物原来只认「本人 Mission 下的 Task」，负责人不是 Mission 负责人时负责人自己反而找不到；现在负责人也能找到并传版本。

## 6. 对表

输入：约定（按第 4 节读）、本体当前的标准、最新一版交付物和它的参考评审。每条按标准原文在这一版的标准快照里找到对应的评审：

| 结果 `status` | 条件 | 带出来什么 |
|-|-|-|
| `no_deliverable` 还没交付物 | 一版都没交 | — |
| `reviewing` 评审中 | 这一版排队、在评或评审失败；异议重评时只有在重评的那一条 | — |
| `gap` 差 | 评审判部分达到或未达到；或这条标准改过、这一版没按它评 | `gap`：评审的 `fix`（标准改过时写「传一版新的再对表」） |
| `evidenced` 有证据 | 评审判达到，约定没写认可人或认可人就是负责人 | `evidence`：第几版、哪份材料（评审定位里点到名字的；这一版只有一样时就是它）、评审的定位 |
| `needs_acceptor` 要 X 确认 | 评审判达到，约定写了由别人认 | 同上，另有 `notifiedToday` |

结论（`verdict` + `conclusion`）只有两种：

- `ready`：每条都是有证据或要 X 确认。「约定的 N 条都有证据了，可以交。交之前请 X 确认第 k 条。再改要重新谈范围。」中间那句只在有要别人确认的条时出现。
- `not_ready`：
  - 一版都没交：「还不能交：还没交付物。」
  - 最新一版在评：「还不能交：第 N 版还在评审，评完再对表。」
  - 评审失败：「还不能交：第 N 版的评审没做完，重评以后再对表。」
  - 其余：「还不能交：差第 i 条（评审的理由）、第 j 条（评审中）。」
  - 没有标准：「还不能交：这个 Task 没有可对照的标准。」

结论前面的提示 `notices[{code, text}]`（网页和 MCP 用同一句）：

- `basis_changed`：约定写下以后标准改过，或最新一版是按改之前的标准评的；
- `agreement_incomplete`：哪几条没写用什么证明。

评审的 `beyondScope`（下次可以做）单独附在后面，不进结论。对表不卡交付，交付仍由本人点。

## 7. 「请 X 看」

`POST /api/plan-tasks/:taskId/check/notify {index, personId}`：

- 只有负责人能推（其余 403）；`personId` 要和这一条约定的认可人一致（400 `NOT_ACCEPTOR`）；这一条要是 `needs_acceptor`（409 `NOT_AWAITING_ACCEPTOR`）；飞书没接 503 `FEISHU_NOT_CONFIGURED`；认可人没关联飞书 409 `ACCEPTOR_NOT_ON_FEISHU`（否则队列会直接算完成、什么也不发，负责人却看到「推了」）。
- 走现有飞书通知队列：`enqueueJob(kind=feishu.notify)`，由 `feishu/notify.ts` 的处理器经 `feishu/messages.ts` 发消息卡片给认可人的 open_id。
- 去重键 `feishu.notify:task-check:<taskId>:<index>:<personId>:<公司时区日期>`：同一条同一个人一天只推一次，第二次回 `{status: "already_sent"}`。对表结果里的 `notifiedToday` 也按这个键查。
- 内容：标题「请看「Task 名」第 k 条」；正文「负责人的 Task「…」第 k 条约定由你来认：标准原文 / 交付物第 n 版，证据在 …」；按钮「打开 Task」跳 `/me?planTask=<taskId>`（经飞书免登深链接）。

## 8. 参考评审

- 输入：有约定的条带 `proof`；有「这次不包括」时带 `exclusions`（`exclusions` 是这次多加的，帮评审不把不包括的事当缺口）。提示词写明只按约定判、不加新要求。
- 输出：`beyondScope: string[]`（最多 5 条），放约定外的改进建议，不能当作部分达到、未达到的理由。异议重评保留原来的 `beyondScope`。旧报告读成 `[]`。
- 契约注释里「每一条都达到才能交付」改成「评审只作参考、不卡交付」。

## 9. 接口

| 方法和路径 | 说明 |
|-|-|
| `GET /api/plan-tasks/{taskId}/agreement` | 约定，见第 4、5 节 |
| `PUT /api/plan-tasks/{taskId}/agreement` | 存 11 月补充，回存好后的约定 |
| `GET /api/plan-tasks/{taskId}/check` | 对表，见第 6 节 |
| `POST /api/plan-tasks/{taskId}/check/notify` | 请 X 看，见第 7 节 |
| `GET /internal/plan-tasks/:taskId/agreement`、`/check` | 给伙伴只读，鉴权同其他 `/internal`（`INTERNAL_CHAT_TOKEN` + `X-Owner-Id` + `X-Viewer-Role`），可见范围同网页；照仓库惯例不进公开 OpenAPI |

## 10. MCP

- `get_task_agreement {taskId}`、`check_task {taskId}`：只读，结果和网页一样；成员和 CEO 都列。
- `add_deliverable_version {taskId, links[], note?}`：写工具，在 `MCP_WRITE_TOOLS` 里（只读连接里没有），说明写「只在本人要求时用」；只有负责人能交；沿用上一版的全部材料（和网页默认勾着的一样），同一个链接不重复放；交完自动评审；文件还是从网页传；不是交付。
- `list_my_items`：`missions[].tasks[]` 加 `criteriaCount` 和 `agreementComplete`。
- 三个工具的定义和执行在 `mcpAgreements.ts`；`mcpMe.ts` 只改了工具清单、一处分派、`list_my_items` 两个字段和说明里一句，方便 V2 看板在上面接着改。

## 11. 测试与验证（11/06）

| 检查 | 文件 |
|-|-|
| 约定的三种读法、标准改过的对回、存补充和修改记录、各种 400 / 409 | `test/agreements.test.ts`「约定：读的顺序」 |
| 本体字段的兼容读取（假数据） | `test/planTasks.test.ts` |
| 权限表（负责人、Mission 负责人、CEO、战场负责人、认可人、无关的人） | `test/agreements.test.ts`「约定和交付物的权限」 |
| 对表各种情况的表格测试，带出来的证据、fix、beyondScope、提示原话 | `test/agreements.test.ts`「对表」 |
| 请 X 看：飞书发送打桩，一天一次、第二天再推、各种拒绝 | `test/agreements.test.ts`「请 X 看」 |
| 评审输入带 proof / exclusions、输出 beyondScope、快照 | `test/agreements.test.ts`「参考评审按约定判」 |
| 内部接口 | `test/agreements.test.ts`「给伙伴的内部接口」 |
| MCP 工具清单、只读连接、三个工具 | `test/personalMcp.test.ts`、`test/ceoMcp.test.ts`、`test/mcpOAuth.test.ts`、`test/agreements.test.ts` |

## 12. 已知问题与待定

- 本体字段的确切形状等斯一 12 月定，`worldAgreementOf` 先认第 4 节列的几种；定了以后对照改读取和测试数据。
- 本人 Mission 以外的 Task 第一次读要列整个公司当期的 Task，本体慢时可能等满 8 秒，超时会当找不到（再点一次就有缓存）。
- 「请 X 看」的链接 `/me?planTask=<taskId>` 由网页实现；认可人是 CEO 且没有成员工作台时，这个链接要网页另行处理。
- 认可人逐条确认不在天枢里记（V1 只推飞书提醒）；改约定的取舍流程放 12 月。
