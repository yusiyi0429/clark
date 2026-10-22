import { Type, type Static } from "@sinclair/typebox";

/**
 * 全局进展（② 进展，前端交互实现说明第 5 节）。一号位看全部，二号位看同一战场的人（可见范围在仓储层判）。
 *
 * - 红线只在 Task 级判断两种（Task = 有计划日期、挂在个人任务下的执行事项）：
 *   - slow 比预期慢：过了 finish_date（dueDate）还没完成（overdue），或已过 start_date 3 个工作日仍没有核实过的进展（no_progress）；
 *   - deadline 按截止日做不完：同一项个人任务下未完成的执行事项还需的计划工作日之和，超过离卡片截止日剩下的工作日。
 * - 没有 Task 基线的人，退回按人的进展摘要：已提交的周复盘 + 采集器整理结果。
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

export const ProgressOverview = Type.Object(
  {
    today: Day,
    redLines: Type.Array(ProgressRedLine),
    onTrack: Type.Array(ProgressOnTrack),
    summaries: Type.Array(ProgressPersonSummary),
  },
  { additionalProperties: false },
);
export const ProgressOverviewResponse = Type.Object({ progress: ProgressOverview }, { additionalProperties: false });

export type TProgressPerson = Static<typeof ProgressPerson>;
export type TProgressArtifact = Static<typeof ProgressArtifact>;
export type TProgressMissionRef = Static<typeof ProgressMissionRef>;
export type TProgressTask = Static<typeof ProgressTask>;
export type TProgressSlowReason = Static<typeof ProgressSlowReason>;
export type TProgressRedLine = Static<typeof ProgressRedLine>;
export type TProgressOnTrack = Static<typeof ProgressOnTrack>;
export type TProgressPersonSummary = Static<typeof ProgressPersonSummary>;
export type TProgressOverview = Static<typeof ProgressOverview>;
export type TProgressOverviewResponse = Static<typeof ProgressOverviewResponse>;
