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

/**
 * 落点：写进本体时挂到的对象（9 个对象里的 Mission / Task / 责任单元 / 公司）。id 是天枢里的 id（公司是 company）。
 */
export const WorldAnchorKind = Type.Union([Type.Literal("mission"), Type.Literal("task"), Type.Literal("unit"), Type.Literal("company")]);
export const WorldAnchor = Type.Object(
  { kind: WorldAnchorKind, id: Type.String({ minLength: 1 }), title: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
/**
 * 一条决定写进本体的状态（只给主持人和 CEO）：waiting 等写，committed 已记，fallback 对不上受影响的对象、挂到了会议的挂点上，
 * skipped 没写（本体里没有对应对象），failed 写入失败，off 这场会标了不写进本体。
 */
export const MeetingDecisionWorld = Type.Union([
  Type.Literal("waiting"), Type.Literal("committed"), Type.Literal("fallback"), Type.Literal("skipped"), Type.Literal("failed"), Type.Literal("off"),
]);

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

/**
 * 这场会在本体里（会议事件）：挂点、是否不写进本体、写入状态。
 * status：none 还没写 / committed 已记 / withdrawn 已撤回（标了不写进本体）/ skipped 没写 / failed 写入失败；只给主持人和 CEO，其他人为 null。
 */
export const MeetingWorldStatus = Type.Union([
  Type.Literal("none"), Type.Literal("committed"), Type.Literal("withdrawn"), Type.Literal("skipped"), Type.Literal("failed"),
]);
export const MeetingWorldView = Type.Object(
  {
    excluded: Type.Boolean(),
    /** 谁标的不写进本体（名字）。 */
    excludedBy: Type.Union([Type.String(), Type.Null()]),
    status: Type.Union([MeetingWorldStatus, Type.Null()]),
    /** 最近一次写进本体的时刻。 */
    at: Type.Union([Type.String(), Type.Null()]),
    /** 已写入时是写进去的挂点，否则是现在会挂的。 */
    anchors: Type.Array(WorldAnchor),
    /** 主持人或 CEO 改过挂点。 */
    edited: Type.Boolean(),
    /** 看的人能不能改挂点、开关不写进本体（主持人和 CEO）。 */
    canEdit: Type.Boolean(),
  },
  { additionalProperties: false },
);
/** 一条生效的决定在本体里：落到的对象（受影响的 Mission、Task；挂到会议挂点上时是会议的挂点）和写入状态（不是主持人和 CEO 时为 null）。 */
export const MeetingDecisionWorldItem = Type.Object(
  { id: Type.String({ minLength: 1 }), anchors: Type.Array(WorldAnchor), world: Type.Union([MeetingDecisionWorld, Type.Null()]) },
  { additionalProperties: false },
);
/** 会议页单独取（不进会议卡）：这场会在本体里，和每条生效的决定落到哪。 */
export const MeetingWorldResponse = Type.Object({ world: MeetingWorldView, decisions: Type.Array(MeetingDecisionWorldItem) }, { additionalProperties: false });
export const MeetingWorldExcludedRequest = Type.Object({ excluded: Type.Boolean() }, { additionalProperties: false });
/** 改挂点：只能挑 Mission 和责任单元；null 回到自动（决定影响到的 Mission，都没有挂主持人的单元）。 */
export const MeetingWorldAnchorsRequest = Type.Object(
  {
    anchors: Type.Union([
      Type.Array(Type.Object({ kind: Type.Union([Type.Literal("mission"), Type.Literal("unit")]), id: Type.String({ minLength: 1, maxLength: 200 }) },
        { additionalProperties: false }), { minItems: 1, maxItems: 10 }),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
export const MeetingWorldAnchorOptionsResponse = Type.Object({ options: Type.Array(WorldAnchor) }, { additionalProperties: false });

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
export type TWorldAnchor = Static<typeof WorldAnchor>;
export type TMeetingDecisionWorld = Static<typeof MeetingDecisionWorld>;
export type TMeetingWorldStatus = Static<typeof MeetingWorldStatus>;
export type TMeetingWorldView = Static<typeof MeetingWorldView>;
export type TMeetingWorldResponse = Static<typeof MeetingWorldResponse>;
export type TMeetingDecisionWorldItem = Static<typeof MeetingDecisionWorldItem>;
export type TMeetingWorldAnchorsRequest = Static<typeof MeetingWorldAnchorsRequest>;
