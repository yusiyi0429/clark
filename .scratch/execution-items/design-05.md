# 工单 05 · 执行事项：自建、本月计划拆分、详情、协作、事项群组 · 设计

日期：2026-09-27。依据：
- 用户要求（本日对话，见下文「用户原话要点」）。
- 概念版调研 [concept-survey.md](concept-survey.md)：界面照搬概念版 DRI 工作面。
- Codex 接入调研 [codex-integration-survey.md](codex-integration-survey.md)：本单不实现，只在模型上留好位置。

## 0. 用户原话要点与已定事项

- **执行事项是什么**：「我给自己列的今天该干什么的清单」。分两类：
  1. 为完成某项个人任务拆出来的步骤，比如用甘特图把「上线」拆成四五步。
  2. 不属于任何个人任务的独立事项，比如 CEO 让某人去调查一个信号。
- **个人任务**：月初领到的本月 Mission Card 上的条目，在 MVP 里就是挂在个人卡上的 Mission 行。执行事项由 DRI 自己拆出来，系统不会自动从 Mission 生成。
- **已定（用户 2026-09-27 选定）**：
  - 允许独立事项。点「+」新建时，「所属个人任务」可以选「不挂个人任务」。会后分派来的事项默认是独立事项，之后可以在详情里挂到个人任务上。
  - 甘特图拆分采用「整月一张计划图」：在个人卡页上，每项个人任务是一组，组里加步骤、定起止日期，步骤按先后排；另有「独立事项」一组。保存时生成或更新执行事项。
  - 个人卡整轮确认之后才能拆；讨论期只能看。
  - CEO 指派（信号或议题上安排某人调查，对方接下或拒绝）放到下一张工单。本单在「来源」上留好位置。
  - 先后关系：首页按截止排（SSOT DRI-01），卡上写「第 n 步，共 m 步」和所属个人任务；上一步没完成时写「等上一步」并稍淡。不画连线。
- **界面**：照搬概念版（刘人豪的 DRI 工作面）：
  - `TaskSection`：首页卡片，带「+ 开启执行事项」。
  - `CreateTaskPane`：新建。
  - `TaskPane`：详情。
  - `CollaboratorsDialog`：邀请协作。
  - `LinkedTaskRows`：个人任务下的事项行。
  - 右列 `ConversationColumn` 两个频道：我的天枢、事项群组。
  - 拆分交互照 `PersonalTaskGantt` 的视觉与交互：逐日网格、周末底色、今天竖线、行首、悬浮卡、键盘与触屏。
  - 概念版没有的（拆分编辑、先后关系、独立事项）按同一视觉语言补上，不另起风格。
  - 状态文案用概念版的「未启动／进行中／完成」。会后分派的事项仍保留「退回」。
- **本单不做**：
  - CEO 指派的交接包（下一单）。
  - 进展记录和 Codex、Claude Code 接入（Codex 接入单）。
  - 让拍板人或 CEO 看团队成员的执行事项（以后再定）。
  - 协作者在首页「我的执行事项」里看到别人的事项（SSOT：协作者不混入）。

## 1. 数据：迁移 `036_execution_items.sql`

```sql
ALTER TABLE tasks ADD COLUMN mission_id TEXT REFERENCES missions (id);
ALTER TABLE tasks ADD COLUMN start_date DATE;
ALTER TABLE tasks ADD COLUMN step_order INTEGER CHECK (step_order > 0);
ALTER TABLE tasks ADD COLUMN client_id UUID;
ALTER TABLE tasks ADD CONSTRAINT tasks_step_with_mission CHECK ((mission_id IS NULL) = (step_order IS NULL));
ALTER TABLE tasks ADD CONSTRAINT tasks_start_not_after_due CHECK (start_date IS NULL OR due_date IS NULL OR start_date <= due_date);
CREATE UNIQUE INDEX tasks_owner_client ON tasks (owner_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX tasks_mission_order ON tasks (mission_id, step_order) WHERE mission_id IS NOT NULL;

-- 非推进人的私人批注：一人一条，只有自己看得到。
CREATE TABLE task_notes (
  task_id UUID NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  person_id TEXT NOT NULL,
  note TEXT NOT NULL CHECK (char_length(note) BETWEEN 1 AND 2000),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (task_id, person_id)
);

-- 通知新增「邀请你协作」。
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('meeting_action_assigned', 'task_returned', 'strategic_rejected', 'task_collaborator_added'));
```

- `created_by` 的取值：
  - 原有 `meeting`。
  - 新增 `self`：点「+」新建。
  - 新增 `plan`：从本月计划生成。
  - 契约里叫 `source`。
- 同一项个人任务下的执行事项按 `step_order` 排成 1..m。
  - 推进人一定是这张个人卡的主人：只有本人能在自己的个人任务下建事项。
  - 删除、改归属后由 API 重新编号，不靠唯一约束。
- 数据库里真实的约束名以现有库为准。迁移测试要能在全新库上跑通，也要能在已有 026 的库上跑通。

## 2. 契约（已冻结，见 `packages/contracts/src/tasks.ts`、`openapi.ts`、`conversations.ts`）

- **`TaskView`**：在原有字段上增加以下字段；`dueDate` 改为严格的 `YYYY-MM-DD`。
  - `source`：`meeting | self | plan`。
  - `startDate`。
  - `doneDefinition`。
  - `mission`：`{missionId,title,cardId,period,battlefieldName,step,steps}`，独立事项为 null。
  - `waitingOn`：`{taskId,title}`，上一步还没完成时有值。
  - `owner`、`collaborators`：`{personId,name}`。
- **`TaskDetailResponse`**：`{task, judgment, judgmentAt, myNote, myNoteAt, role, missionOptions, collaboratorOptions}`（写入时间在验收时补上，照概念版写「某某写于…」「上次写于…」）。
  - `role`：owner 或 collaborator。
  - `missionOptions`、`collaboratorOptions` 只给推进人，其他人为空数组。
- **`CreateMyTaskRequest`**：`{clientId, title, missionId|null, startDate?, dueDate?, doneDefinition?}`，直接返回 `TaskView`（和现有的修改、退回接口一致）。
- **`PatchMyTaskRequest`**：`version` 必填，以下字段可选：`status`、`title`、`startDate`、`dueDate`、`doneDefinition`、`judgment`、`missionId`。原来只改状态的调用照样可用。
- **`PutMyTaskNoteRequest`**：`{note|null}`，返回 `{myNote}`。
- **`AddTaskCollaboratorsRequest`**：`{personIds}`，直接返回 `TaskView`。
- **`MonthPlanResponse`**：`{period, firstDay, lastDay, today, editable, closedReason, groups}`。
  - 每个 group：`{missionId|null, title, battlefieldName|null, cardId|null, milestones:[{date|null,text}], items: TaskView[]}`。
- **`SaveMonthPlanRequest`**：`{period, groups:[{missionId|null, items:[{taskId?, version?, clientId?, title, startDate, dueDate}]}]}`，返回 `MonthPlanResponse`。
- **`ConversationScope`**：增加 `task:<id>`。
- **`NotificationKind`**：增加 `task_collaborator_added`。

## 3. API 行为

**读**
- `GET /api/me/home`：`myTasks` 是本人推进的事项（owner），全部状态，结构为新的 `TaskView`。排序照旧，前端按截止排。
- `GET /api/me/tasks/:id`：推进人和在职协作者（`left_at IS NULL`）能看；其他人一律 404。
  - `missionOptions`：本人已确定、月份未过的个人卡上的个人任务。
  - `collaboratorOptions`：人员名单里除本人和现有成员以外的人。

**写**：只有推进人能写，协作者只能写自己的批注；version 冲突返回 409 并带 `latestTask`。
- **新建** `POST /api/me/tasks`
  - owner 为本人，status 为 `not_started`，source 为 `self`。
  - 按 `(owner, clientId)` 幂等：内容相同返回原事项，不同返回 409。
  - `missionId` 必须是本人个人卡上的个人任务，而且该轮已确定、月份未过；否则 400 或 404。挂上后排在这项个人任务的最后一步。
  - 日期规则：`startDate ≤ dueDate`。
  - 同时建 `task_members`（owner）和事项群组成员 `thread_members`。
- **修改** `PATCH /api/me/tasks/:id`
  - 可改：状态、标题、日期、完成定义、判断、`missionId`。
  - 改归属：从原来的个人任务移出，两边重新编号。
  - 状态沿用原规则，不能直接改成 `returned`。
- **删除** `DELETE /api/me/tasks/:id?version=`
  - 只能删自己的、未启动的、source 是 `self` 或 `plan` 的。
  - 同时删事项群组的成员和消息；原个人任务下重新编号；返回 204。
  - 会后分派的不能删，只能退回。
- **退回** `POST /api/me/tasks/:id/return`：只适用于 source 为 `meeting` 的，其余返回 409。
- **批注** `PUT /api/me/tasks/:id/note`：只有非推进的成员能写；传 null 表示删除。
- **邀请协作** `POST /api/me/tasks/:id/collaborators`
  - 推进人把人员名单里的人加为协作者，写入 `task_members` 和 `thread_members`，并给每人发 `task_collaborator_added` 通知。
  - 已是成员的忽略；最多 10 人。
  - 协作不转移推进责任。
- **事项群组**：沿用现有 `/api/threads/task/:id`。
  - 成员 = 推进人 + 在职协作者，与 `task_members` 同步。
  - Co-Agent 开场在新建时写进群消息（kind=co-agent），并给推进人记为已读，不计未读。实现时按任务单写入，和个人卡群组的现算不同；它是当时的交代，之后改了标题或日期不回改，所以不写会随拆分变化的「第 n 步，共 m 步」。例如：「这个群讨论孙铭泽的执行事项「…」（所属个人任务「…」，第 2 步，共 4 步），截止 10/12。」
- **我的天枢**：`task:<id>` 范围对推进人和协作者开放，只读问答。上下文带事项本身、所属个人任务、战场和本月目标。

**本月计划**
- `GET /api/me/plan?period=`：`period` 默认公司当前月。
  - `groups`：本人在这个月个人卡上的每项个人任务各一组，组内是它的执行事项，按步骤排；最后一组「独立事项」。
  - 独立事项组收：本人的独立事项里起止在这个月的，加上没有日期且未完成的。
  - 里程碑：从个人任务的 milestones 原文里解析开头的日期（`M/D` 或 `YYYY-MM-DD`，按这个月所在的年份）；解析不出的 `date` 为 null。不从正文猜日期。
- `editable` 和 `closedReason`，按以下顺序判断：
  - 这个月没有本人个人卡：「这个月还没有你的个人卡」。
  - 卡还没确定：「个人卡确定之后才能拆成执行事项」。
  - 月份已过：「月份已过，计划只读」。
  - 以上都不满足时可以编辑，`closedReason` 为 null。
- `PUT /api/me/plan`（用户 2026-09-27 验收时改定：「以好用为主，越灵活越好用」，不要形式化；替代原来「每步必须有本月内起止、每次整张提交、version 对不上就 409」的规则）：
  - 只能在 `editable` 时保存，否则返回 409 `PLAN_NOT_EDITABLE`。
  - 只传改过的组，没传的组不动。
  - 组内数组顺序即先后；组里已有、这次没列出的事项（别处刚建的）保留，排在列出的后面，不报错。
  - 带 `taskId` 的已有事项只带改过的字段（标题、开始、截止，日期可为 null 表示清空），没带的保持原样；不比对 version（计划只有本人编辑，后写为准）。
  - 不带 `taskId` 的新步骤带 `clientId` 和标题，日期可以不给；新建 source 为 `plan`，按 `(owner, clientId)` 幂等。
  - 日期给了就要是有效日期，开始不晚于截止；不再要求落在这个月内（甘特图按月裁切）。
  - 列出的 `taskId` 已不在这一组（别处移走或删了）才返回 409 `PLAN_STALE`。删除只走 DELETE。每组最多 100 项。
  - 整个保存在一个事务里完成，返回最新的 `MonthPlanResponse`。

## 4. Web 行为（照搬概念版）

- **首页执行事项区**：照概念版 `TaskSection` 搬，替换 `MemberTasks`。
  - 标题行：「N 项执行事项在推进」，右侧「+ 开启执行事项」。
  - 每张卡上有：
    - 标题。
    - 所属个人任务的链接，或「独立事项」「会后分派 · 会名」标签。
    - 「第 n 步，共 m 步」。
    - 等上一步时写「等上一步：…」，整张稍淡。
    - 计划开始或截止。
    - 「协作 · 人名」。
  - 按 SSOT 要在首页改状态：卡上保留一个紧凑的状态切换（未启动／进行中／完成），会后分派的保留「退回」。
  - 卡片点开进详情；排序照 SSOT 按截止。
- **新建**：`/me/tasks/new`，照 `CreateTaskPane`。
  - 字段：标题、所属个人任务（下拉里有本人可选的个人任务和「不挂个人任务（独立事项）」）、计划开始、截止、完成定义。
  - 在工作区展开区打开；成功后直接进新事项的详情。
- **详情**：`/me/tasks/[id]`，照 `TaskPane` 布局。
  - 左边：归属、状态（推进人自报）、战场、推进人与协作者、「邀请协作」、计划开始与截止、完成定义、这件事的判断（推进人写）、我的批注（其他人，只自己可见）、会议来源与原话。
  - 推进人在这里编辑；可以删除未启动的自建或计划事项，删除前要确认。
  - 右列两个频道：
    - 我的天枢：`task:<id>`。
    - 事项群组：`/api/threads/task/:id`，3 秒轮询。
- **个人卡页**：本人、并且卡已确定时增加「本月计划」页签。
  - 照 `PersonalTaskGantt` 画整月网格：逐日、周末底色、今天竖线。
  - 每组是一项个人任务，组头写个人任务名和它的里程碑点；最后一组是「独立事项」。
  - 组里的每一步是一行，条从开始画到截止。
  - 编辑（直接在甘特图上，好用优先）：
    - 每组最后一行「＋ 加一步」，行内输入，回车即加，只要标题。
    - 在行里按住拖动画出起止，点一下是当天；拖条两端改起止，拖整条平移；只有截止日的画截止标记。
    - 点行首标题展开小编辑条：改标题、两个日期输入、上移下移、删除（已保存的删除要确认）。
    - 有改动时贴底一条「保存计划 · 新增 n 步，调整 m 步」和「放弃改动」，直接保存，不再弹确认框。
    - 独立事项不是步骤：不写「第 n 步」，组头写「N 件」。
  - 未确定或月份已过时只读，并写出 `closedReason`。
  - 手机上网格可以在自己的框里横向滚动；也提供不用拖动的日期选择方式，保证能用。
  - 「个人任务」页签里，每项个人任务下面照 `LinkedTaskRows` 列出它的执行事项。
- **通知**：成员通知栏的「推动」类里加「邀请你协作」，点开进详情。

## 5. 测试

- **API**：
  - 迁移清单。
  - 新建的幂等和归属校验；修改、删除、退回的权限与状态规则；重新编号。
  - 协作者邀请、线程成员同步和通知。
  - 批注的私有性。
  - 本月计划的读写：可编辑的三种关闭原因、`PLAN_STALE`、日期范围、幂等。
  - `task:` 对话范围的权限。
  - 原有会后分派、退回、首页的测试全部通过。
- **Web**：
  - 首页卡片的各种标签和「等上一步」。
  - 新建表单；详情里推进人和协作者的权限差异。
  - 邀请协作；删除确认。
  - 计划图：只读和可编辑、加一步、改日期、保存的请求体、409 提示。
  - 手机 390 宽不横向溢出。
