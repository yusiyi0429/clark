import { Type, type Static } from "@sinclair/typebox";

/**
 * 会后链路：妙记状态、实际参会名单、会议记录待确认清单；旧格式会议的逐条决定只读。
 * - 妙记：none（会还没开完）/ waiting（开完了，等飞书妙记生成）/ manual（拿不到，退回手动上传）/ ready（已拿到）/ failed（读取失败，带原因）。
 * - 旧会议的逐条决定（strategic / host）只读显示，不再确认、提醒或代判；新会议会后只有会议卡一个入口（整卡确认）。
 */
export const MeetingMinutesStatus = Type.Union([Type.Literal("none"), Type.Literal("waiting"), Type.Literal("manual"), Type.Literal("ready"), Type.Literal("failed")]);
/** 妙记读取失败（failed）的原因：没权限 / 原文还没好 / 没找到 / 其他失败。主持人或创建人可以再读一次。 */
export const MeetingMinutesFailure = Type.Union([Type.Literal("no_permission"), Type.Literal("not_ready"), Type.Literal("not_found"), Type.Literal("fetch_failed")]);
/** 主持人或创建人贴妙记链接：https://<租户>.feishu.cn/minutes/<token>。 */
export const MeetingMinutesLinkRequest = Type.Object({ url: Type.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false });
/** 再读一次、贴链接之后的妙记状态。 */
export const MeetingMinutesFetchResponse = Type.Object(
  { minutesStatus: MeetingMinutesStatus, minutesFailure: Type.Union([MeetingMinutesFailure, Type.Null()]) },
  { additionalProperties: false },
);

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
 * 落点：写进本体时挂到的对象（LTO / 本月 PO / Mission / Task / 责任单元 / 公司）。
 * lto、po 的 id 是本体 object_id；其余是天枢里的 id（Mission 按 mission:<code>、单元按 capability:<code> 对本体；公司是 company）。
 */
export const WorldAnchorKind = Type.Union([
  Type.Literal("lto"), Type.Literal("po"), Type.Literal("mission"), Type.Literal("task"), Type.Literal("unit"), Type.Literal("company"),
]);
/** 预约、改挂点时能挑的挂点：LTO、本月 PO、本月 Mission、责任单元。 */
export const PickedWorldAnchor = Type.Object(
  { kind: Type.Union([Type.Literal("lto"), Type.Literal("po"), Type.Literal("mission"), Type.Literal("unit")]), id: Type.String({ minLength: 1, maxLength: 200 }) },
  { additionalProperties: false },
);
export const WorldAnchor = Type.Object(
  { kind: WorldAnchorKind, id: Type.String({ minLength: 1 }), title: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
/**
 * 一条生效的决定在本体里（只给能看会议记录状态的人）：决定随整场会议事件写，跟着会议记录走——
 * waiting 还没写，committed 已写入，failed 写入失败，off 选了不写入。
 */
export const MeetingDecisionWorld = Type.Union([Type.Literal("waiting"), Type.Literal("committed"), Type.Literal("failed"), Type.Literal("off")]);

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
    /** 旧字段：逐条确认已停，总是 false。 */
    canReview: Type.Boolean(),
  },
  { additionalProperties: false },
);

/**
 * 会议记录（B 方案）：整卡确认后写一条整场会议事件。只给主持人、创建人和 CEO，其他人为 null。
 * status：pending 待确认（还没确认过）；writing 已确认、会议事件还在写；committed 已写入（读回核对过）；excluded 选了不写入；
 * failed 写入失败；edit_pending 确认之后又改了，要重新确认。
 * version 是当前确认版本（会议卡 revision，同一草稿再确认不加）；eventId 是最近一次写进去的会议事件；由整卡确认表和同步回执算出。
 */
export const MeetingRecordStatus = Type.Union([
  Type.Literal("pending"), Type.Literal("writing"), Type.Literal("committed"), Type.Literal("excluded"), Type.Literal("failed"), Type.Literal("edit_pending"),
]);
export const MeetingRecordView = Type.Object(
  {
    status: MeetingRecordStatus,
    version: Type.Integer({ minimum: 0 }),
    eventId: Type.Union([Type.String(), Type.Null()]),
    confirmedAt: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
  },
  { additionalProperties: false },
);
/** 这场会在本体里：挂点、是否选了不写入、会议记录的状态。 */
export const MeetingWorldView = Type.Object(
  {
    excluded: Type.Boolean(),
    /** 谁选的不写入（名字）。 */
    excludedBy: Type.Union([Type.String(), Type.Null()]),
    record: Type.Union([MeetingRecordView, Type.Null()]),
    /** 最近一次写进本体的时刻（只给能看记录状态的人）。 */
    at: Type.Union([Type.String(), Type.Null()]),
    /** 已写入且确认后没改过时是写进去的挂点，否则是现在会挂的。 */
    anchors: Type.Array(WorldAnchor),
    /** 主持人或 CEO 改过挂点。 */
    edited: Type.Boolean(),
    /** 看的人能不能改挂点（主持人和建会的人）。 */
    canEdit: Type.Boolean(),
  },
  { additionalProperties: false },
);
/** 一条生效的决定在本体里：落到的对象（影响卡里受影响的 Mission、Task）和写入状态（看不到会议记录状态的人为 null）。 */
export const MeetingDecisionWorldItem = Type.Object(
  { id: Type.String({ minLength: 1 }), anchors: Type.Array(WorldAnchor), world: Type.Union([MeetingDecisionWorld, Type.Null()]) },
  { additionalProperties: false },
);
/** 会议页单独取（不进会议卡）：这场会在本体里，和每条生效的决定落到哪。 */
export const MeetingWorldResponse = Type.Object({ world: MeetingWorldView, decisions: Type.Array(MeetingDecisionWorldItem) }, { additionalProperties: false });
/** 改挂点：挑 LTO、本月 PO、本月 Mission、责任单元；null 回到自动（主持人负责的单元，没有就挂公司）。 */
export const MeetingWorldAnchorsRequest = Type.Object(
  { anchors: Type.Union([Type.Array(PickedWorldAnchor, { minItems: 1, maxItems: 10 }), Type.Null()]) },
  { additionalProperties: false },
);
/**
 * 预约、改挂点时的一个候选：名称、类型，加对象已确认的内容（brief，截 80 字）——LTO、PO 是目标块的结果，Mission 是定义的结果，
 * 单元是名称；草稿或读不到时为 null。lifecycle 照本体（LTO、PO）或 Mission 轮次（draft / confirmed；没有任务卡时照本体状态），单元为 null。
 * Mission 带负责人（ownerId，约会议默认挂自己的）和服务的 PO（parentId：选项里有这个 PO 时才给），其余为 null。
 */
export const WorldAnchorOption = Type.Object(
  {
    kind: PickedWorldAnchor.properties.kind,
    id: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    brief: Type.Union([Type.String({ maxLength: 80 }), Type.Null()]),
    lifecycle: Type.Union([Type.String(), Type.Null()]),
    ownerId: Type.Union([Type.String(), Type.Null()]),
    parentId: Type.Union([Type.String(), Type.Null()]),
    /** Mission 所在战场的名字，没有战场时是能力域名（CEO 挑挂点时按它分组）；都对不上时没有。 */
    group: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export const MeetingWorldAnchorOptionsResponse = Type.Object({ options: Type.Array(WorldAnchorOption) }, { additionalProperties: false });

/**
 * 我要处理的会议记录（通知栏，一场会一条）：记录正文不用确认（10/28），只剩我主持或创建的会里写入失败的（failed，卡上重试）。
 */
export const MyMeetingCardStatus = Type.Literal("failed");
export const MyMeetingCard = Type.Object(
  {
    meetingId: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    /** 会议结束时刻（没记下实际结束时用预约的结束时刻）。 */
    endedAt: Type.String({ minLength: 1 }),
    status: MyMeetingCardStatus,
  },
  { additionalProperties: false },
);
/**
 * 等我处理的一条（通知栏「会后确认」，一次只看一条）：我是责任人的决策（还没冻结的会）、我是负责人（没有负责人时我是主持人）的行动项，
 * 以及我主持的会里没有责任人、要我补归属的决策（needsOwner）。text 是决策或事项本身；title 是来自的那场会。
 */
export const MyMeetingConfirm = Type.Object(
  {
    meetingId: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    kind: Type.Union([Type.Literal("decision"), Type.Literal("action")]),
    id: Type.String({ minLength: 1 }),
    text: Type.String({ minLength: 1 }),
    dueDate: Type.Union([Type.String(), Type.Null()]),
    needsOwner: Type.Boolean(),
  },
  { additionalProperties: false },
);
export const MyMeetingCardsResponse = Type.Object({ meetings: Type.Array(MyMeetingCard), confirms: Type.Array(MyMeetingConfirm) }, { additionalProperties: false });

export type TMeetingMinutesStatus = Static<typeof MeetingMinutesStatus>;
export type TMeetingMinutesFailure = Static<typeof MeetingMinutesFailure>;
export type TMeetingMinutesLinkRequest = Static<typeof MeetingMinutesLinkRequest>;
export type TMeetingMinutesFetchResponse = Static<typeof MeetingMinutesFetchResponse>;
export type TMeetingAttendees = Static<typeof MeetingAttendees>;
export type TMeetingDecisionTier = Static<typeof MeetingDecisionTier>;
export type TMeetingDecisionStatus = Static<typeof MeetingDecisionStatus>;
export type TMeetingDecisionRecommendation = Static<typeof MeetingDecisionRecommendation>;
export type TMeetingDecisionView = Static<typeof MeetingDecisionView>;
export type TMyMeetingCardStatus = Static<typeof MyMeetingCardStatus>;
export type TMyMeetingCard = Static<typeof MyMeetingCard>;
export type TMyMeetingConfirm = Static<typeof MyMeetingConfirm>;
export type TMyMeetingCardsResponse = Static<typeof MyMeetingCardsResponse>;
export type TWorldAnchor = Static<typeof WorldAnchor>;
export type TWorldAnchorOption = Static<typeof WorldAnchorOption>;
export type TMeetingDecisionWorld = Static<typeof MeetingDecisionWorld>;
export type TMeetingRecordStatus = Static<typeof MeetingRecordStatus>;
export type TMeetingRecordView = Static<typeof MeetingRecordView>;
export type TMeetingWorldView = Static<typeof MeetingWorldView>;
export type TMeetingWorldResponse = Static<typeof MeetingWorldResponse>;
export type TMeetingDecisionWorldItem = Static<typeof MeetingDecisionWorldItem>;
export type TMeetingWorldAnchorsRequest = Static<typeof MeetingWorldAnchorsRequest>;
export type TPickedWorldAnchor = Static<typeof PickedWorldAnchor>;
