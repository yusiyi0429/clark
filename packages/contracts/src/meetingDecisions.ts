import { Type, type Static } from "@sinclair/typebox";

/**
 * 会后链路：妙记状态、实际参会名单、分层确认的「会上定了 X」。
 * - 妙记：none（会还没开完）/ waiting（开完了，等飞书妙记生成）/ manual（拿不到，退回手动上传）/ ready（已拿到）。
 * - 分层：strategic 推给 CEO（不代判）；host 由主持人确认，每场最多 5 条，满一个工作日没确认由 Agent 按推荐判断代判。
 */
export const MeetingMinutesStatus = Type.Union([Type.Literal("none"), Type.Literal("waiting"), Type.Literal("manual"), Type.Literal("ready")]);

/** 实际参会的人：飞书参会名单（中途加入的也算）；拿不到时退回手填的参会人。 */
export const MeetingAttendees = Type.Object(
  {
    source: Type.Union([Type.Literal("feishu"), Type.Literal("manual")]),
    personIds: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const MeetingDecisionTier = Type.Union([Type.Literal("strategic"), Type.Literal("host")]);
export const MeetingDecisionStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("confirmed"),
  Type.Literal("edited"),
  Type.Literal("not_decided"),
  Type.Literal("rejected"),
  Type.Literal("agent_judged"),
]);
export const MeetingDecisionRecommendation = Type.Union([Type.Literal("confirmed"), Type.Literal("not_decided")]);

export const MeetingDecisionView = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    meetingId: Type.String({ minLength: 1 }),
    tier: MeetingDecisionTier,
    ordinal: Type.Integer({ minimum: 1 }),
    /** 现在生效的说法：改过就是改后的。 */
    statement: Type.String({ minLength: 1 }),
    /** Agent 解读出来的原说法；没改过时与 statement 相同。 */
    originalStatement: Type.String({ minLength: 1 }),
    quote: Type.Union([Type.String(), Type.Null()]),
    speakerName: Type.Union([Type.String(), Type.Null()]),
    recommendation: MeetingDecisionRecommendation,
    why: Type.Union([Type.String(), Type.Null()]),
    status: MeetingDecisionStatus,
    /** 下游推送后再改判时加一。 */
    revision: Type.Integer({ minimum: 0 }),
    reviewerName: Type.Union([Type.String(), Type.Null()]),
    reviewedAt: Type.Union([Type.String(), Type.Null()]),
    /** 到点由 Agent 代判（只有 host）。 */
    dueAt: Type.Union([Type.String(), Type.Null()]),
    /** 看的人能不能在这里确认（主持人确认 host 条目）。 */
    canReview: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const MeetingDecisionVerdict = Type.Union([Type.Literal("confirmed"), Type.Literal("edited"), Type.Literal("not_decided")]);
export const MeetingDecisionReviewRequest = Type.Object(
  {
    verdict: MeetingDecisionVerdict,
    /** verdict = edited 时必填：改后的说法。 */
    statement: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  },
  { additionalProperties: false },
);
export const MeetingDecisionResponse = Type.Object({ decision: MeetingDecisionView }, { additionalProperties: false });

/** 我要确认的会后决定（通知栏置顶）：按会议分组，只列还没确认的。 */
export const MyMeetingDecisionGroup = Type.Object(
  {
    meetingId: Type.String({ minLength: 1 }),
    meetingTitle: Type.String({ minLength: 1 }),
    scheduledAt: Type.String({ minLength: 1 }),
    dueAt: Type.Union([Type.String(), Type.Null()]),
    decisions: Type.Array(MeetingDecisionView),
  },
  { additionalProperties: false },
);
export const MyMeetingDecisionsResponse = Type.Object({ groups: Type.Array(MyMeetingDecisionGroup) }, { additionalProperties: false });

export type TMeetingMinutesStatus = Static<typeof MeetingMinutesStatus>;
export type TMeetingAttendees = Static<typeof MeetingAttendees>;
export type TMeetingDecisionTier = Static<typeof MeetingDecisionTier>;
export type TMeetingDecisionStatus = Static<typeof MeetingDecisionStatus>;
export type TMeetingDecisionRecommendation = Static<typeof MeetingDecisionRecommendation>;
export type TMeetingDecisionView = Static<typeof MeetingDecisionView>;
export type TMeetingDecisionVerdict = Static<typeof MeetingDecisionVerdict>;
export type TMeetingDecisionReviewRequest = Static<typeof MeetingDecisionReviewRequest>;
export type TMeetingDecisionResponse = Static<typeof MeetingDecisionResponse>;
export type TMyMeetingDecisionGroup = Static<typeof MyMeetingDecisionGroup>;
export type TMyMeetingDecisionsResponse = Static<typeof MyMeetingDecisionsResponse>;
