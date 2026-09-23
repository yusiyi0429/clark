import { Type, type Static } from "@sinclair/typebox";
import { IssueLocation, IssueUrgencyLevel } from "./issues.js";
import { MissionAnchor } from "./config.js";
import { MonthlyPlanExportStatus } from "./monthlyPlans.js";

/** BattlefieldConfig 只作为 battlefieldId 的确定性校验来源；本文件只定义战场 Card 投影。 */

/** 战场正面：归属于该战场的 pending Issue 摘要。 */
export const BattlefieldPendingIssue = Type.Object(
  {
    id: Type.String(),
    title: Type.String(),
    urgency: IssueUrgencyLevel,
    location: IssueLocation,
  },
  { additionalProperties: false },
);

/** 战场背面：普通待办 + 真实 DRI 外发状态；没有 open/done 等执行状态。 */
export const BattlefieldTodo = Type.Object(
  {
    id: Type.String(),
    title: Type.String(),
    ownerId: Type.String(),
    dueAt: Type.Union([Type.String(), Type.Null()]),
    sourceRef: Type.String(),
    exportStatus: Type.Union([MonthlyPlanExportStatus, Type.Null()]),
    exportRef: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

export const BattlefieldLatestFeedback = Type.Object(
  {
    text: Type.String(),
    observedAt: Type.String(),
    sourceRef: Type.String(),
    evidenceRef: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

export const BattlefieldCardPayload = Type.Object(
  {
    battlefieldId: Type.String(),
    code: Type.String(),
    sortOrder: Type.Integer(),
    name: Type.String(),
    ownerId: Type.String(),
    /** 投影时现查 company-people.v1；空 ownerId 显示为“待指派”。 */
    ownerDisplayName: Type.String(),
    sixMonthOutcome: Type.String(),
    missionAnchors: Type.Array(MissionAnchor),
    /** 当前公司月已签发计划的 period；没有 confirmed 计划时为 null。 */
    period: Type.Union([Type.String(), Type.Null()]),
    /** 正面目标；公司级待办与 feedback 不进入单个战场。 */
    target: Type.Union([Type.String(), Type.Null()]),
    pendingIssues: Type.Array(BattlefieldPendingIssue),
    todos: Type.Array(BattlefieldTodo),
    latestFeedback: Type.Union([BattlefieldLatestFeedback, Type.Null()]),
  },
  { additionalProperties: false },
);

export type TBattlefieldPendingIssue = Static<typeof BattlefieldPendingIssue>;
export type TBattlefieldTodo = Static<typeof BattlefieldTodo>;
export type TBattlefieldLatestFeedback = Static<typeof BattlefieldLatestFeedback>;
export type TBattlefieldCardPayload = Static<typeof BattlefieldCardPayload>;
