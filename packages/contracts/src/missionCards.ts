import { Type, type Static } from "@sinclair/typebox";
import { MonthlyPlanPeriod } from "./monthlyPlans.js";
import { ActionDescriptor } from "./cards.js";
import { MissionCardPayload } from "./missions.js";
import { ThreadMember } from "./threads.js";

/** 个人任务允许建议的 12 个字段；唯一责任人由个人卡归属决定。 */
export const MissionCardField = Type.Union([
  Type.Literal("title"), Type.Literal("why"), Type.Literal("outcome"), Type.Literal("successEvidence"),
  Type.Literal("boundaries"), Type.Literal("keyPath"), Type.Literal("milestones"), Type.Literal("resources"),
  Type.Literal("dependencies"), Type.Literal("humanAgentSplit"), Type.Literal("risk"), Type.Literal("retrospect"),
]);

/** closed 是已到截止但尚未写入快照的投影态，不写入轮次 status。 */
export const MissionRoundPhase = Type.Union([
  /** drafting：Co-Agent 正在起草个人卡（工单 10），完成后进入 draft。 */
  Type.Literal("drafting"),
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
  firstPendingFeedbackId: Type.Union([Type.String(), Type.Null()]),
  pendingCorrections: Count,
  firstPendingCorrectionId: Type.Union([Type.String(), Type.Null()]),
  mine: Type.Boolean(),
  /** 这张卡是占位：Co-Agent 起草失败时沿用上个月的卡，或整轮来自占位文件。 */
  placeholder: Type.Boolean(),
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
  /** 草稿来源：agent 为 Co-Agent 起草，placeholder 为占位文件；还没起草为 null。 */
  draftOrigin: Type.Union([Type.Literal("agent"), Type.Literal("placeholder"), Type.Null()]),
  goals: Type.Union([Type.Object({
    sixMonthOutcome: Type.String(),
    monthOutcome: Type.String(),
    signedAt: DateTime,
  }, { additionalProperties: false }), Type.Null()]),
  counts: Type.Object({
    cards: Count, feedback: Count, pending: Count, conflicts: Count, dependencies: Count, late: Count,
    /** 确认后等拍板人处理的更正申请（GAP-04）。 */
    corrections: Count,
  }, { additionalProperties: false }),
  cards: Type.Array(MissionCardRow),
}, { additionalProperties: false });

/** 尚未确认的轮次跨月保留；通知按 Owner 或当前拍板权限筛选，不写通知表。 */
export const MyMissionRoundsResponse = Type.Object({ rounds: Type.Array(MissionRoundSummary) }, { additionalProperties: false });

/** 尚未建轮次的入口只引用 slot，不伪造 round/card 身份。 */
export const MissionRoundDraftPayload = Type.Object({
  period: MonthlyPlanPeriod,
  battlefieldId: Type.String(),
  battlefieldName: Type.String(),
  /** 整理草稿时是否只能用占位文件（Co-Agent 起草不可用）。 */
  placeholder: Type.Boolean(),
  todo: Type.String(),
  serverNow: DateTime,
}, { additionalProperties: false });

export const ExecuteMissionRoundActionRequest = Type.Object({
  actionId: Type.String(),
  input: Type.Optional(Type.Unknown()),
  viewCardId: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const MissionRoundDecideInput = Type.Object({
  decision: Type.Union([Type.Literal("accept"), Type.Literal("decline")]),
}, { additionalProperties: false });
export const MissionRoundConfirmInput = Type.Object({
  note: Type.String({ minLength: 1, maxLength: 2000, pattern: "\\S" }),
}, { additionalProperties: false });

const FeedbackKind = Type.Union([Type.Literal("comment"), Type.Literal("quote"), Type.Literal("suggestion")]);
const NullableText = Type.Union([Type.String(), Type.Null()]);
export const MissionCardFeedbackView = Type.Object({
  id: Type.String(), seq: Type.Integer({ minimum: 1 }), missionId: NullableText,
  field: Type.Union([MissionCardField, Type.Null()]), kind: FeedbackKind,
  authorId: Type.String(), authorName: Type.String(), body: Type.String(),
  quote: NullableText, proposed: NullableText, original: NullableText,
  sourceVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  basis: Type.Union([Type.Literal("draft"), Type.Literal("candidate")]),
  late: Type.Boolean(), round: Type.Integer({ minimum: 1 }), createdAt: DateTime,
  verdict: Type.Object({ text: Type.String(), tone: Type.Union([Type.Literal("open"), Type.Literal("accept"), Type.Literal("decline"), Type.Literal("late"), Type.Literal("wait")]) }, { additionalProperties: false }),
  decision: Type.Union([Type.Literal("accept"), Type.Literal("decline"), Type.Null()]),
  acceptBlockedReason: NullableText,
  actions: Type.Array(ActionDescriptor),
}, { additionalProperties: false });
export const PersonalMissionCardMission = Type.Object({
  ...MissionCardPayload.properties, version: Type.Integer({ minimum: 1 }), changedFields: Type.Array(MissionCardField),
}, { additionalProperties: false });
/**
 * 已确定个人卡的更正（GAP-04）：非拍板人申请、拍板人逐条采纳或不采纳；拍板人自己更正直接生效（direct）。
 * 每条都留痕；stale 表示申请之后字段又改过，不能直接采纳。
 */
export const MissionCardCorrectionView = Type.Object({
  id: Type.String(), missionId: Type.String(), field: MissionCardField,
  original: Type.String(), proposed: Type.String(), reason: Type.String(),
  authorId: Type.String(), authorName: Type.String(), direct: Type.Boolean(),
  status: Type.Union([Type.Literal("pending"), Type.Literal("applied"), Type.Literal("rejected")]),
  decidedBy: NullableText, decidedByName: NullableText, decidedAt: NullableDateTime, note: NullableText,
  appliedVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  stale: Type.Boolean(), createdAt: DateTime,
}, { additionalProperties: false });
/** 更正入口随看的人变化；closedReason 为 null 时本卡可更正。 */
export const MissionCardCorrectionAccess = Type.Object({
  canRequest: Type.Boolean(), canApply: Type.Boolean(), closedReason: NullableText,
}, { additionalProperties: false });
export const PersonalMissionCardPayload = Type.Object({
  round: MissionRoundSummary,
  card: Type.Object({
    cardId: Type.String(), ownerId: Type.String(), ownerName: Type.String(), roleLabel: NullableText,
    members: Type.Array(ThreadMember), status: Type.String(),
    shown: Type.Union([Type.Literal("draft"), Type.Literal("candidate"), Type.Literal("confirmed")]),
    missions: Type.Array(PersonalMissionCardMission),
  }, { additionalProperties: false }),
  feedback: Type.Array(MissionCardFeedbackView),
  confirmation: Type.Union([Type.Object({ by: Type.String(), byName: Type.String(), at: DateTime, note: Type.String() }, { additionalProperties: false }), Type.Null()]),
  /** 新的在前；看得到卡的人都看得到这张卡的更正记录。 */
  corrections: Type.Array(MissionCardCorrectionView),
  correctionAccess: MissionCardCorrectionAccess,
}, { additionalProperties: false });
export const CreateMissionCardFeedbackRequest = Type.Object({
  clientId: Type.String({ format: "uuid" }), kind: FeedbackKind, round: Type.Integer({ minimum: 1 }),
  missionId: Type.Optional(Type.String({ minLength: 1 })), field: Type.Optional(MissionCardField),
  quote: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  proposed: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  body: Type.String({ minLength: 1, maxLength: 4000 }), sourceVersion: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });
export const CreateMissionCardFeedbackResponse = Type.Object({ feedback: MissionCardFeedbackView }, { additionalProperties: false });
export const CreateMissionCardCorrectionRequest = Type.Object({
  clientId: Type.String({ format: "uuid" }), missionId: Type.String({ minLength: 1 }), field: MissionCardField,
  proposed: Type.String({ minLength: 1, maxLength: 4000 }), reason: Type.String({ minLength: 1, maxLength: 300 }),
  sourceVersion: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
/** 不采纳必须写 note；采纳时 note 可省略。 */
export const DecideMissionCardCorrectionRequest = Type.Object({
  decision: Type.Union([Type.Literal("apply"), Type.Literal("reject")]),
  note: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
}, { additionalProperties: false });
export const MissionCardCorrectionResponse = Type.Object({ correction: MissionCardCorrectionView }, { additionalProperties: false });
export const MissionCardGroupView = Type.Object({
  roundVersion: Type.Integer({ minimum: 1 }),
  members: Type.Array(ThreadMember), lastReadSeq: Count, unread: Count,
  entries: Type.Array(Type.Union([
    Type.Object({ type: Type.Literal("message"), feedback: MissionCardFeedbackView }, { additionalProperties: false }),
    Type.Object({ type: Type.Literal("divider"), at: DateTime, text: Type.String() }, { additionalProperties: false }),
    Type.Object({ type: Type.Literal("opening"), at: DateTime, text: Type.String() }, { additionalProperties: false }),
  ])),
}, { additionalProperties: false });
export const MarkMissionCardReadRequest = Type.Object({ lastReadSeq: Count }, { additionalProperties: false });
export const MarkMissionCardReadResponse = Type.Object({ lastReadSeq: Count, unread: Count }, { additionalProperties: false });

export type TMissionCardField = Static<typeof MissionCardField>;
export type TMissionRoundPhase = Static<typeof MissionRoundPhase>;
export type TMissionCardRow = Static<typeof MissionCardRow>;
export type TMissionRoundSummary = Static<typeof MissionRoundSummary>;
export type TMyMissionRoundsResponse = Static<typeof MyMissionRoundsResponse>;
export type TMissionRoundDraftPayload = Static<typeof MissionRoundDraftPayload>;
export type TExecuteMissionRoundActionRequest = Static<typeof ExecuteMissionRoundActionRequest>;
export type TMissionRoundDecideInput = Static<typeof MissionRoundDecideInput>;
export type TMissionRoundConfirmInput = Static<typeof MissionRoundConfirmInput>;
export type TMissionCardFeedbackView = Static<typeof MissionCardFeedbackView>;
export type TPersonalMissionCardMission = Static<typeof PersonalMissionCardMission>;
export type TPersonalMissionCardPayload = Static<typeof PersonalMissionCardPayload>;
export type TCreateMissionCardFeedbackRequest = Static<typeof CreateMissionCardFeedbackRequest>;
export type TMissionCardCorrectionView = Static<typeof MissionCardCorrectionView>;
export type TMissionCardCorrectionAccess = Static<typeof MissionCardCorrectionAccess>;
export type TCreateMissionCardCorrectionRequest = Static<typeof CreateMissionCardCorrectionRequest>;
export type TDecideMissionCardCorrectionRequest = Static<typeof DecideMissionCardCorrectionRequest>;
export type TMissionCardGroupView = Static<typeof MissionCardGroupView>;
