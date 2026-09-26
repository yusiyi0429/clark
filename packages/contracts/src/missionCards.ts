import { Type, type Static } from "@sinclair/typebox";
import { MonthlyPlanPeriod } from "./monthlyPlans.js";

/** 个人任务允许建议的 12 个字段；唯一责任人由个人卡归属决定。 */
export const MissionCardField = Type.Union([
  Type.Literal("title"), Type.Literal("why"), Type.Literal("outcome"), Type.Literal("successEvidence"),
  Type.Literal("boundaries"), Type.Literal("keyPath"), Type.Literal("milestones"), Type.Literal("resources"),
  Type.Literal("dependencies"), Type.Literal("humanAgentSplit"), Type.Literal("risk"), Type.Literal("retrospect"),
]);

/** closed 是已到截止但尚未写入快照的投影态，不写入轮次 status。 */
export const MissionRoundPhase = Type.Union([
  Type.Literal("draft"), Type.Literal("open"), Type.Literal("closed"),
  Type.Literal("reviewing"), Type.Literal("confirmed"),
]);

const DateTime = Type.String({ description: "应用时钟生成的 ISO 8601 时间" });
const NullableDateTime = Type.Union([DateTime, Type.Null()]);
const Count = Type.Integer({ minimum: 0 });

export const MissionCardRow = Type.Object({
  cardId: Type.String(),
  ownerId: Type.String(),
  ownerName: Type.String(),
  roleLabel: Type.Union([Type.String(), Type.Null()]),
  missionCount: Count,
  line: Type.String(),
  pending: Count,
  mine: Type.Boolean(),
}, { additionalProperties: false });

/** 同一轮次的公开事实；动作权限单独通过 approver 与 Card actions 投影。 */
export const MissionRoundSummary = Type.Object({
  roundId: Type.String(),
  period: MonthlyPlanPeriod,
  battlefieldId: Type.String(),
  battlefieldName: Type.String(),
  version: Type.Integer({ minimum: 1 }),
  phase: MissionRoundPhase,
  round: Type.Integer({ minimum: 1 }),
  openedAt: NullableDateTime,
  closesAt: NullableDateTime,
  reviewAt: NullableDateTime,
  serverNow: DateTime,
  approver: Type.Boolean(),
  deciderName: Type.String(),
  todo: Type.Union([Type.String(), Type.Null()]),
  placeholder: Type.Boolean(),
  goals: Type.Union([Type.Object({
    sixMonthOutcome: Type.String(),
    monthOutcome: Type.String(),
    signedAt: DateTime,
  }, { additionalProperties: false }), Type.Null()]),
  counts: Type.Object({
    feedback: Count, pending: Count, conflicts: Count, dependencies: Count, late: Count,
  }, { additionalProperties: false }),
  cards: Type.Array(MissionCardRow),
}, { additionalProperties: false });

/** 尚未建轮次的入口只引用 slot，不伪造 round/card 身份。 */
export const MissionRoundDraftPayload = Type.Object({
  period: MonthlyPlanPeriod,
  battlefieldId: Type.String(),
  battlefieldName: Type.String(),
  placeholder: Type.Literal(true),
  todo: Type.String(),
  serverNow: DateTime,
}, { additionalProperties: false });

export const ExecuteMissionRoundActionRequest = Type.Object({
  actionId: Type.String(),
  input: Type.Optional(Type.Unknown()),
  viewCardId: Type.Optional(Type.String()),
}, { additionalProperties: false });

export type TMissionCardField = Static<typeof MissionCardField>;
export type TMissionRoundPhase = Static<typeof MissionRoundPhase>;
export type TMissionCardRow = Static<typeof MissionCardRow>;
export type TMissionRoundSummary = Static<typeof MissionRoundSummary>;
export type TMissionRoundDraftPayload = Static<typeof MissionRoundDraftPayload>;
export type TExecuteMissionRoundActionRequest = Static<typeof ExecuteMissionRoundActionRequest>;
