import { Type, type Static } from "@sinclair/typebox";

/**
 * 全局进展（② 进展，前端交互实现说明第 5 节）。一号位看全部，二号位看同一战场的人（可见范围在仓储层判）。
 *
 * - 红线只在 Task 级判断两种（Task = 有计划日期、挂在个人任务下的执行事项）：
 *   - slow 比预期慢：过了 finish_date（dueDate）还没完成（overdue），或已过 start_date 3 个工作日仍没有核实过的进展（no_progress）；
 *   - deadline 按截止日做不完：同一项个人任务下未完成的执行事项还需的计划工作日之和，超过离卡片截止日剩下的工作日。
 * - 没有 Task 基线的人，退回按人的进展摘要：已提交的周复盘 + 采集器整理结果。
 * - 计划外工作：采集器整理时归不上 Task 的部分，分待挂靠、待改计划。
 * - 信息截至：这个人各采集来源 coverage_until 的最小值；没有采集来源为 null。
 */

const DateTime = Type.String({ description: "ISO 8601" });
const NullableDateTime = Type.Union([DateTime, Type.Null()]);
const Day = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });

export const ProgressPerson = Type.Object(
  { personId: Type.String({ minLength: 1 }), name: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
/** 做出来的东西：文档、草稿、PR 的链接。 */
export const ProgressArtifact = Type.Object(
  { url: Type.String({ minLength: 1 }), title: Type.Union([Type.String(), Type.Null()]) },
  { additionalProperties: false },
);
export const ProgressMissionRef = Type.Object(
  { missionId: Type.String({ minLength: 1 }), title: Type.String({ minLength: 1 }), deadline: Day },
  { additionalProperties: false },
);

/** 一件有计划的执行事项（Task）。 */
export const ProgressTask = Type.Object(
  {
    taskId: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    status: Type.Union([Type.Literal("not_started"), Type.Literal("in_progress")]),
    startDate: Day,
    dueDate: Day,
    /** 计划工作日（startDate..dueDate，含首尾，周一到周五）。 */
    plannedDays: Type.Integer({ minimum: 0 }),
    /** 已用工作日（startDate..今天，含首尾；没开始为 0）。 */
    usedDays: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const ProgressSlowReason = Type.Union([Type.Literal("overdue"), Type.Literal("no_progress")]);

/** 一条红线。slow 带一件 Task；deadline 带一项个人任务和其下未完成的 Task。 */
export const ProgressRedLine = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("slow"),
      reason: ProgressSlowReason,
      person: ProgressPerson,
      mission: ProgressMissionRef,
      task: ProgressTask,
      artifacts: Type.Array(ProgressArtifact),
      coverageUntil: NullableDateTime,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("deadline"),
      person: ProgressPerson,
      mission: ProgressMissionRef,
      /** 未完成的 Task 还需的计划工作日之和。 */
      neededDays: Type.Integer({ minimum: 0 }),
      /** 今天到截止日（含）剩下的工作日。 */
      leftDays: Type.Integer({ minimum: 0 }),
      tasks: Type.Array(ProgressTask),
      artifacts: Type.Array(ProgressArtifact),
      coverageUntil: NullableDateTime,
    },
    { additionalProperties: false },
  ),
]);

/** 按计划在走的 Task。 */
export const ProgressOnTrack = Type.Object(
  {
    person: ProgressPerson,
    mission: ProgressMissionRef,
    task: ProgressTask,
    artifacts: Type.Array(ProgressArtifact),
    coverageUntil: NullableDateTime,
  },
  { additionalProperties: false },
);

/** 没有 Task 基线的人：最近一份已提交的周复盘 + 最近的采集整理结果。 */
export const ProgressPersonSummary = Type.Object(
  {
    person: ProgressPerson,
    weeklyReview: Type.Union([
      Type.Object(
        {
          href: Type.String({ minLength: 1 }),
          weekStart: Day,
          weekEnd: Day,
          /** 本周总体判断（去掉出处标记）。 */
          overall: Type.String(),
          /** 关键进展与 Evidence（去掉出处标记）。 */
          progress: Type.String(),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    recent: Type.Array(Type.Object(
      {
        text: Type.String({ minLength: 1 }),
        endedAt: DateTime,
        taskTitle: Type.Union([Type.String(), Type.Null()]),
        links: Type.Array(ProgressArtifact),
      },
      { additionalProperties: false },
    )),
    artifacts: Type.Array(ProgressArtifact),
    coverageUntil: NullableDateTime,
  },
  { additionalProperties: false },
);

/** attach 待挂靠：像某件现有执行事项的一部分；replan 待改计划：现有计划里没有它的位置。 */
export const OffPlanKind = Type.Union([Type.Literal("attach"), Type.Literal("replan")]);
export const OffPlanItem = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    person: ProgressPerson,
    kind: OffPlanKind,
    /** 在做什么（整理出的一句话）。 */
    text: Type.String({ minLength: 1 }),
    /** 待挂靠时最像的那件执行事项。 */
    candidateTask: Type.Union([Type.Object({ taskId: Type.String({ minLength: 1 }), title: Type.String({ minLength: 1 }) }, { additionalProperties: false }), Type.Null()]),
    /** 证据：来源、仓库、时间段、链接。 */
    evidence: Type.Object(
      {
        source: Type.String({ minLength: 1 }),
        repo: Type.Union([Type.String(), Type.Null()]),
        startedAt: DateTime,
        endedAt: DateTime,
        links: Type.Array(ProgressArtifact),
      },
      { additionalProperties: false },
    ),
    /** 花了多少分钟：整理出它的那几段会话时长之和。 */
    spentMinutes: Type.Integer({ minimum: 0 }),
    /** 本人已提出改计划的时间；没提为 null。 */
    replanProposedAt: NullableDateTime,
  },
  { additionalProperties: false },
);

export const ProgressOverview = Type.Object(
  {
    today: Day,
    redLines: Type.Array(ProgressRedLine),
    onTrack: Type.Array(ProgressOnTrack),
    summaries: Type.Array(ProgressPersonSummary),
    offPlan: Type.Array(OffPlanItem),
  },
  { additionalProperties: false },
);
export const ProgressOverviewResponse = Type.Object({ progress: ProgressOverview }, { additionalProperties: false });

/** 本人的计划外：没处理的和已提出改计划的；tasks 是挂靠时可选的本人未完成执行事项。 */
export const MyOffPlanResponse = Type.Object(
  {
    items: Type.Array(OffPlanItem),
    tasks: Type.Array(Type.Object({ taskId: Type.String({ minLength: 1 }), title: Type.String({ minLength: 1 }) }, { additionalProperties: false })),
  },
  { additionalProperties: false },
);
export const AttachOffPlanRequest = Type.Object({ taskId: Type.String({ format: "uuid" }) }, { additionalProperties: false });

export type TProgressPerson = Static<typeof ProgressPerson>;
export type TProgressArtifact = Static<typeof ProgressArtifact>;
export type TProgressMissionRef = Static<typeof ProgressMissionRef>;
export type TProgressTask = Static<typeof ProgressTask>;
export type TProgressSlowReason = Static<typeof ProgressSlowReason>;
export type TProgressRedLine = Static<typeof ProgressRedLine>;
export type TProgressOnTrack = Static<typeof ProgressOnTrack>;
export type TProgressPersonSummary = Static<typeof ProgressPersonSummary>;
export type TOffPlanKind = Static<typeof OffPlanKind>;
export type TOffPlanItem = Static<typeof OffPlanItem>;
export type TProgressOverview = Static<typeof ProgressOverview>;
export type TProgressOverviewResponse = Static<typeof ProgressOverviewResponse>;
export type TMyOffPlanResponse = Static<typeof MyOffPlanResponse>;
export type TAttachOffPlanRequest = Static<typeof AttachOffPlanRequest>;
