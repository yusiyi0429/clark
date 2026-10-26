import { Type, type Static } from "@sinclair/typebox";
import { MemberWork } from "./memberHome.js";
import { MemberRadarBrief } from "./personalRadar.js";

/** 执行事项状态：returned 只能通过退回接口进入。 */
export const TaskStatus = Type.Union([
  Type.Literal("not_started"),
  Type.Literal("in_progress"),
  Type.Literal("done"),
  Type.Literal("returned"),
]);

/** 执行事项从哪来：会后分派、自己点「+」新建、从本月计划拆出；agent 是外部工具（Codex、Claude Code 等）按用户正在做的事替用户建的。以后加 CEO 指派。 */
export const TaskSource = Type.Union([Type.Literal("meeting"), Type.Literal("self"), Type.Literal("plan"), Type.Literal("agent")]);

export const DateOnly = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const NullableDate = Type.Union([DateOnly, Type.Null()]);
export const Period = Type.String({ pattern: "^\\d{4}-(0[1-9]|1[0-2])$" });

export const TaskPerson = Type.Object(
  { personId: Type.String({ minLength: 1 }), name: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

/** other：用「其他工具」令牌写的进展。 */
export const TaskProgressSource = Type.Union([Type.Literal("web"), Type.Literal("codex"), Type.Literal("claude"), Type.Literal("github"), Type.Literal("other")]);
export const TaskProgressLink = Type.Object({
  url: Type.String({ pattern: "^https?://", maxLength: 500 }),
  title: Type.Optional(Type.String({ maxLength: 120 })),
}, { additionalProperties: false });
export const TaskProgressEntry = Type.Object({
  id: Type.String({ format: "uuid" }),
  taskId: Type.String({ format: "uuid" }),
  author: TaskPerson,
  source: TaskProgressSource,
  body: Type.String({ minLength: 1, maxLength: 2000 }),
  links: Type.Array(TaskProgressLink, { maxItems: 5 }),
  createdAt: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
export const TaskLatestProgress = Type.Object({
  body: Type.String({ minLength: 1, maxLength: 2000 }),
  source: TaskProgressSource,
  author: TaskPerson,
  createdAt: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
export const AppendTaskProgressRequest = Type.Object({
  clientEventId: Type.String({ format: "uuid" }),
  body: Type.String({ minLength: 1, maxLength: 2000 }),
  links: Type.Optional(Type.Array(TaskProgressLink, { maxItems: 5 })),
}, { additionalProperties: false });

/** 所属 Mission；同一个 Mission 下的执行事项按先后排成第 1..steps 步。从本体导入、没有任务卡的 Mission cardId 为 null。 */
export const TaskMissionRef = Type.Object(
  {
    missionId: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    cardId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    period: Period,
    battlefieldName: Type.String(),
    step: Type.Integer({ minimum: 1 }),
    steps: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

/** 执行事项来源：会后推送的带会议与原话；自建、计划拆出的为 null。 */
export const TaskOrigin = Type.Object(
  {
    type: Type.Literal("meeting"),
    meetingId: Type.String({ minLength: 1 }),
    meetingTitle: Type.String({ minLength: 1 }),
    quote: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

/** 卡住：推进人写的「卡在哪」、在等的人（可空）、从哪一刻算起（ISO 8601）。 */
export const TaskBlocker = Type.Object(
  {
    reason: Type.String({ minLength: 1, maxLength: 200 }),
    waitingOn: Type.Union([TaskPerson, Type.Null()]),
    since: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** 成员侧执行事项视图：普通视图对象，不走 CEO 的 Card/Action 签名。 */
export const TaskView = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    version: Type.Integer({ minimum: 1 }),
    title: Type.String({ minLength: 1, maxLength: 120 }),
    status: TaskStatus,
    source: TaskSource,
    /** YYYY-MM-DD；计划开始。 */
    startDate: NullableDate,
    /** YYYY-MM-DD */
    dueDate: NullableDate,
    doneDefinition: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
    /** 独立事项为 null。 */
    mission: Type.Union([TaskMissionRef, Type.Null()]),
    /** 同一项个人任务里上一步还没完成时指向它。 */
    waitingOn: Type.Union([Type.Object({ taskId: Type.String({ minLength: 1 }), title: Type.String({ minLength: 1 }) }, { additionalProperties: false }), Type.Null()]),
    /** 推进人；协作者不转移推进责任。 */
    owner: TaskPerson,
    collaborators: Type.Array(TaskPerson),
    latestProgress: Type.Union([TaskLatestProgress, Type.Null()]),
    returnReason: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    origin: Type.Union([TaskOrigin, Type.Null()]),
    /** 外部工具替推进人提交了验收、推进人还没处理。不是状态：页头和首页卡片写「等你验收」。 */
    awaitingAcceptance: Type.Boolean(),
    /** 挂在本月计划里的哪个 Task（本体里的 Task 对象 id）；没挂为 null。 */
    planTaskId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** 没卡住为 null；事项完成时清掉。 */
    blocker: Type.Union([TaskBlocker, Type.Null()]),
    /** ISO 8601 */
    createdAt: Type.String({ minLength: 1 }),
    updatedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/**
 * 验收时对一条完成标准的判断。index 是按行拆出的完成标准里的第几条（从 0 起）；
 * evidence 是一句依据，materialId 指向这件事里的一份材料（依据是材料时才有）。
 */
export const TaskStandardCheck = Type.Object(
  {
    index: Type.Integer({ minimum: 0, maximum: 49 }),
    met: Type.Boolean(),
    evidence: Type.Union([Type.String({ minLength: 1, maxLength: 300 }), Type.Null()]),
    materialId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  },
  { additionalProperties: false },
);

/** 外部工具（Codex、Claude Code 等）替推进人提交的验收，可带草稿；推进人验收或退回后清掉。 */
export const TaskSubmission = Type.Object(
  {
    by: TaskPerson,
    via: TaskProgressSource,
    /** ISO 8601 */
    at: Type.String({ minLength: 1 }),
    verdict: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
    standards: Type.Array(TaskStandardCheck, { maxItems: 50 }),
    deliverableMaterialIds: Type.Array(Type.String({ format: "uuid" }), { maxItems: 30 }),
  },
  { additionalProperties: false },
);

/** 验收记录：完成标准存验收那一刻的文字快照；重新打开时清掉。 */
export const TaskAcceptance = Type.Object(
  {
    by: TaskPerson,
    /** ISO 8601 */
    at: Type.String({ minLength: 1 }),
    verdict: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
    standards: Type.Array(Type.Object(
      {
        text: Type.String({ minLength: 1, maxLength: 500 }),
        met: Type.Boolean(),
        evidence: Type.Union([Type.String({ minLength: 1, maxLength: 300 }), Type.Null()]),
        materialId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
      },
      { additionalProperties: false },
    ), { maxItems: 50 }),
    deliverableMaterialIds: Type.Array(Type.String({ format: "uuid" }), { maxItems: 30 }),
  },
  { additionalProperties: false },
);

/**
 * 推进人验收：只有推进人；version 不一致 409 带 latestTask。逐条对完成标准：每一条都要 met=true 才能完成（有没达到的走退回，没写完成标准的先写）。
 * 完成标准的文字由服务端按当前 doneDefinition 拆出来存快照。交付结果必须是这件事现有的材料。
 */
export const AcceptMyTaskRequest = Type.Object(
  {
    version: Type.Integer({ minimum: 1 }),
    verdict: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
    standards: Type.Array(TaskStandardCheck, { maxItems: 50 }),
    deliverableMaterialIds: Type.Array(Type.String({ format: "uuid" }), { maxItems: 30 }),
  },
  { additionalProperties: false },
);

/** 验收退回：逐条对完成标准时有没达到的；standards 至少一条 met=false，没达到的每条都要写原因（evidence）。清掉外部工具的提交，状态不变。 */
export const ReturnTaskAcceptanceRequest = Type.Object(
  {
    version: Type.Integer({ minimum: 1 }),
    standards: Type.Array(TaskStandardCheck, { minItems: 1, maxItems: 50 }),
  },
  { additionalProperties: false },
);

/** 完成后重新打开：状态回进行中，清掉验收记录。 */
export const ReopenMyTaskRequest = Type.Object(
  { version: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);

/** 我的 Agent 对照完成标准起草的验收：只预填，由推进人改完再验收。 */
export const TaskAcceptanceDraft = Type.Object(
  {
    verdict: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
    standards: Type.Array(TaskStandardCheck, { maxItems: 50 }),
    deliverableMaterialIds: Type.Array(Type.String({ format: "uuid" }), { maxItems: 30 }),
  },
  { additionalProperties: false },
);

export const MissionCardItemsResponse = Type.Object({
  missions: Type.Array(Type.Object({
    missionId: Type.String({ minLength: 1 }),
    items: Type.Array(TaskView),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

/** 成员工作台：参与的本月工作、我负责的执行事项（全部状态，新到旧），以及开着时的个人雷达小组件。 */
/** 周五 18:00 到周日结束，本周没有外部 Agent 写入的进展时提醒；no_connection 没有有效连接，not_synced 连了但没同步。 */
export const WeeklySyncReminder = Type.Object(
  { reason: Type.Union([Type.Literal("no_connection"), Type.Literal("not_synced")]) },
  { additionalProperties: false },
);

export const MeHomeResponse = Type.Object(
  { myTasks: Type.Array(TaskView), work: MemberWork, radar: Type.Union([MemberRadarBrief, Type.Null()]), weeklySync: Type.Union([WeeklySyncReminder, Type.Null()]) },
  { additionalProperties: false },
);

/**
 * 只有推进人能改；version 不一致返回 409 并带 latestTask。除 version 外至少带一个字段。
 * missionId 改归属：从原个人任务移出、排到新个人任务的最后一步；null 表示改为独立事项。
 * 完成只能走验收（AcceptMyTaskRequest），这里的 status 不收 done；已完成的事项要先重新打开。
 */
export const PatchMyTaskRequest = Type.Object(
  {
    version: Type.Integer({ minimum: 1 }),
    status: Type.Optional(Type.Union([Type.Literal("not_started"), Type.Literal("in_progress")])),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    startDate: Type.Optional(NullableDate),
    dueDate: Type.Optional(NullableDate),
    doneDefinition: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()])),
    judgment: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 2000 }), Type.Null()])),
    missionId: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
    /** 挂到哪个 Task；null 取消挂靠。 */
    planTaskId: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()])),
    /** 卡在哪；null 清掉（连同在等谁）。 */
    blockedReason: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()])),
    /** 在等谁（人员 id）；要有卡在哪才算数，null 清掉。 */
    waitingOn: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  },
  { additionalProperties: false },
);

/** 点「+」新建：推进人是本人；missionId 为 null 是独立事项。按 (本人, clientId) 幂等。返回 TaskView。 */
export const CreateMyTaskRequest = Type.Object(
  {
    clientId: Type.String({ format: "uuid" }),
    title: Type.String({ minLength: 1, maxLength: 120 }),
    missionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    startDate: Type.Optional(DateOnly),
    dueDate: Type.Optional(DateOnly),
    doneDefinition: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    planTaskId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

/** 详情：推进人和在职协作者可读；选项只给推进人。 */
export const TaskDetailResponse = Type.Object(
  {
    task: TaskView,
    /** 推进人写的「这件事的判断」，成员都看得到。 */
    judgment: Type.Union([Type.String({ minLength: 1, maxLength: 2000 }), Type.Null()]),
    /** 判断最后一次写入的时间；没写过为 null。 */
    judgmentAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** 非推进人自己的批注，只有自己看得到；推进人为 null。 */
    myNote: Type.Union([Type.String({ minLength: 1, maxLength: 2000 }), Type.Null()]),
    myNoteAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    role: Type.Union([Type.Literal("owner"), Type.Literal("collaborator")]),
    /** 可挂的 Mission：本人的、不是占位、月份未过（和首页同一口径，不要求任务卡已确认）。 */
    missionOptions: Type.Array(Type.Object(
      { missionId: Type.String({ minLength: 1 }), title: Type.String({ minLength: 1 }), battlefieldName: Type.String(), period: Period },
      { additionalProperties: false },
    )),
    /** 可邀请的同事：人员名单里除本人和现有成员以外的人。 */
    collaboratorOptions: Type.Array(TaskPerson),
    progress: Type.Array(TaskProgressEntry, { maxItems: 50 }),
    /** 完成标准：doneDefinition 按行拆开，去掉空行和行首的列表记号。 */
    standards: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 50 }),
    submission: Type.Union([TaskSubmission, Type.Null()]),
    /** 验收记录；没验收过、重新打开过、或 10/8 前就标完成的老事项为 null。 */
    acceptance: Type.Union([TaskAcceptance, Type.Null()]),
  },
  { additionalProperties: false },
);

/** 非推进人的私人批注；null 删除。 */
export const PutMyTaskNoteRequest = Type.Object(
  { note: Type.Union([Type.String({ minLength: 1, maxLength: 2000 }), Type.Null()]) },
  { additionalProperties: false },
);
export const PutMyTaskNoteResponse = Type.Object(
  { myNote: Type.Union([Type.String({ minLength: 1, maxLength: 2000 }), Type.Null()]) },
  { additionalProperties: false },
);

/** 推进人邀请协作者：已是成员的忽略；返回 TaskView。 */
export const AddTaskCollaboratorsRequest = Type.Object(
  { personIds: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 10 }) },
  { additionalProperties: false },
);

/** 本月计划的一组：一项个人任务（按步骤排），或 missionId 为 null 的「独立事项」。 */
export const MonthPlanGroup = Type.Object(
  {
    missionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    title: Type.String({ minLength: 1 }),
    battlefieldName: Type.Union([Type.String(), Type.Null()]),
    cardId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** 个人任务的里程碑原文；date 只从原文开头解析，解析不出为 null。 */
    milestones: Type.Array(Type.Object({ date: NullableDate, text: Type.String({ minLength: 1 }) }, { additionalProperties: false })),
    items: Type.Array(TaskView),
  },
  { additionalProperties: false },
);

/** 整月一张计划图：任务卡确定之后、月份未过时可编辑，否则 closedReason 写明原因。 */
export const MonthPlanResponse = Type.Object(
  {
    period: Period,
    firstDay: DateOnly,
    lastDay: DateOnly,
    /** 公司时区的今天。 */
    today: DateOnly,
    editable: Type.Boolean(),
    closedReason: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    groups: Type.Array(MonthPlanGroup),
  },
  { additionalProperties: false },
);

/**
 * 保存计划（用户 2026-09-27：好用优先，越灵活越好）：只传改过的组，没传的组不动。
 * - 组内数组顺序即先后；组里已有、这次没列出的事项（别处刚建的）保留，排在列出的后面，不报错。
 * - 已有事项（带 taskId）只带改过的字段，没带的字段保持原样；新步骤带 clientId 和标题。
 * - 日期都可以不定；给了就要是有效日期，开始不晚于截止。
 * - 列出的 taskId 已不在这一组（别处移走或删了）才返回 409 PLAN_STALE。删除只走 DELETE /api/me/tasks/:id。
 */
export const SaveMonthPlanRequest = Type.Object(
  {
    period: Period,
    groups: Type.Array(Type.Object(
      {
        missionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
        items: Type.Array(Type.Object(
          {
            taskId: Type.Optional(Type.String({ minLength: 1 })),
            clientId: Type.Optional(Type.String({ format: "uuid" })),
            title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
            startDate: Type.Optional(NullableDate),
            dueDate: Type.Optional(NullableDate),
          },
          { additionalProperties: false },
        ), { maxItems: 100 }),
      },
      { additionalProperties: false },
    ), { maxItems: 20 }),
  },
  { additionalProperties: false },
);

/** 退回要写原因；会同时通知这场会的主持人。 */
export const ReturnMyTaskRequest = Type.Object(
  {
    version: Type.Integer({ minimum: 1 }),
    reason: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

export const NotificationKind = Type.Union([
  Type.Literal("meeting_action_assigned"),
  Type.Literal("task_returned"),
  Type.Literal("strategic_rejected"),
  Type.Literal("task_collaborator_added"),
  /** 被拉进议题群或会议群（工单 08）；payload {objectType, objectId, inviterId, note?}。 */
  Type.Literal("thread_member_added"),
  /** 外部工具替推进人提交了验收，推进人收到「等你验收」。 */
  Type.Literal("task_submitted"),
  /** 一号位把议题指派给本人主责（issue.assign）；objectType=issue。 */
  Type.Literal("issue_assigned"),
  /** 送达通道（⑨ 传话）：收到请求、我的问题有人回答、接收人标记完成、接收人提问（给发起人）；objectType=request。 */
  Type.Literal("request_received"),
  Type.Literal("request_answered"),
  Type.Literal("request_done"),
  Type.Literal("request_asked"),
  /** ③ 信息收集：截止前固定时间提醒还没确认的人；objectType=request（kind = collection 的那一轮）。 */
  Type.Literal("collection_reminder"),
  /** 会议卡草稿生成好了：主持人和创建人各一条，一场会只发一次；objectType=meeting。 */
  Type.Literal("meeting_card_pending"),
  /** 别人在你推进或协作的执行事项上写了进展；同一件事没看过的只留一条，文案取最新一条；objectType=task。 */
  Type.Literal("task_progress_added"),
]);

/** 通知只指向对象；text 在读取时按对象当前状态组合。 */
export const NotificationView = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    kind: NotificationKind,
    text: Type.String({ minLength: 1 }),
    /** 事情本身（会后分派：执行事项全文）；通知栏正文只写它，来源写在小字里。 */
    subject: Type.Optional(Type.String({ minLength: 1 })),
    /** 来自哪儿（会后分派：会议名）。 */
    source: Type.Optional(Type.String({ minLength: 1 })),
    /** issue：被拉进议题群（工单 08），点开进 /me/issues/{objectId}。 */
    objectType: Type.Union([Type.Literal("task"), Type.Literal("meeting"), Type.Literal("issue"), Type.Literal("request")]),
    objectId: Type.String({ minLength: 1 }),
    /** ISO 8601 */
    createdAt: Type.String({ minLength: 1 }),
    readAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

/** 未读在前，最近 50 条。 */
export const NotificationList = Type.Object(
  { notifications: Type.Array(NotificationView, { maxItems: 50 }) },
  { additionalProperties: false },
);

/** 只标自己的通知；别人的 id 静默忽略。 */
export const MarkNotificationsSeenRequest = Type.Object(
  { notificationIds: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 100 }) },
  { additionalProperties: false },
);

export type TTaskStatus = Static<typeof TaskStatus>;
export type TTaskProgressSource = Static<typeof TaskProgressSource>;
export type TTaskProgressEntry = Static<typeof TaskProgressEntry>;
export type TTaskLatestProgress = Static<typeof TaskLatestProgress>;
export type TAppendTaskProgressRequest = Static<typeof AppendTaskProgressRequest>;
export type TMissionCardItemsResponse = Static<typeof MissionCardItemsResponse>;
export type TTaskSource = Static<typeof TaskSource>;
export type TTaskPerson = Static<typeof TaskPerson>;
export type TTaskMissionRef = Static<typeof TaskMissionRef>;
export type TCreateMyTaskRequest = Static<typeof CreateMyTaskRequest>;
export type TTaskDetailResponse = Static<typeof TaskDetailResponse>;
export type TPutMyTaskNoteRequest = Static<typeof PutMyTaskNoteRequest>;
export type TAddTaskCollaboratorsRequest = Static<typeof AddTaskCollaboratorsRequest>;
export type TMonthPlanGroup = Static<typeof MonthPlanGroup>;
export type TMonthPlanResponse = Static<typeof MonthPlanResponse>;
export type TSaveMonthPlanRequest = Static<typeof SaveMonthPlanRequest>;
export type TTaskOrigin = Static<typeof TaskOrigin>;
export type TTaskView = Static<typeof TaskView>;
export type TTaskStandardCheck = Static<typeof TaskStandardCheck>;
export type TTaskSubmission = Static<typeof TaskSubmission>;
export type TTaskAcceptance = Static<typeof TaskAcceptance>;
export type TAcceptMyTaskRequest = Static<typeof AcceptMyTaskRequest>;
export type TReopenMyTaskRequest = Static<typeof ReopenMyTaskRequest>;
export type TReturnTaskAcceptanceRequest = Static<typeof ReturnTaskAcceptanceRequest>;
export type TTaskAcceptanceDraft = Static<typeof TaskAcceptanceDraft>;
export type TMeHomeResponse = Static<typeof MeHomeResponse>;
export type TWeeklySyncReminder = Static<typeof WeeklySyncReminder>;
export type TPatchMyTaskRequest = Static<typeof PatchMyTaskRequest>;
export type TReturnMyTaskRequest = Static<typeof ReturnMyTaskRequest>;
export type TNotificationKind = Static<typeof NotificationKind>;
export type TNotificationView = Static<typeof NotificationView>;
export type TNotificationList = Static<typeof NotificationList>;
export type TMarkNotificationsSeenRequest = Static<typeof MarkNotificationsSeenRequest>;
