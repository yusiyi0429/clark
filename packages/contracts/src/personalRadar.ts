import { Type, type Static } from "@sinclair/typebox";

/**
 * 个人雷达（ADR-0021）：成员自己开关、自己写方向和来源；命中的个人信号只给本人看。
 * 方向按字符计最多 40 字（服务端规范化时按 Array.from 计）；schema 的 maxLength 按 UTF-16 计，因此放宽到 80。
 */
export const RADAR_DIRECTION_MAX_CHARS = 40;
export const RADAR_MAX_DIRECTIONS = 5;
export const RADAR_MAX_SOURCES = 10;

const DirectionText = Type.String({ minLength: 1, maxLength: 80 });
const SourceInput = Type.String({ minLength: 1, maxLength: 300 });

export const RadarDirection = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 100 }),
  text: DirectionText,
}, { additionalProperties: false });

/** 读法由服务端按当前目录现算：订阅源、全网检索后按域名筛、读取榜单、暂不支持。 */
export const RadarSourceKind = Type.Union([
  Type.Literal("feed"),
  Type.Literal("site"),
  Type.Literal("list"),
  Type.Literal("unsupported"),
]);

export const RadarSourceSetting = Type.Object({
  /** 规范化后的「域名 + 路径」，胶囊上显示的就是它。 */
  value: Type.String({ minLength: 1, maxLength: 300 }),
  /** 目录里的发布方名，如「金融时报」。 */
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  kind: RadarSourceKind,
  /** 如实写读法，如「订阅源」「全网检索后按域名筛，结果可能很少」。 */
  note: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });

export const RadarDirectionSuggestion = Type.Object({
  text: DirectionText,
  /** 建议从哪来，如「灯塔项目」「10 月讨论候选」；建议不自动选中。 */
  from: Type.String({ minLength: 1, maxLength: 60 }),
}, { additionalProperties: false });

export const PersonalRadarRun = Type.Object({
  trigger: Type.Union([Type.Literal("scheduled"), Type.Literal("manual")]),
  status: Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed")]),
  queuedAt: Type.Optional(Type.String({ format: "date-time" })),
  startedAt: Type.Optional(Type.String({ format: "date-time" })),
  completedAt: Type.Optional(Type.String({ format: "date-time" })),
  createdSignals: Type.Integer({ minimum: 0 }),
  warnings: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 50 }),
}, { additionalProperties: false });

export const MyRadar = Type.Object({
  enabled: Type.Boolean(),
  directions: Type.Array(RadarDirection, { maxItems: RADAR_MAX_DIRECTIONS }),
  sources: Type.Array(RadarSourceSetting, { maxItems: RADAR_MAX_SOURCES }),
  /** 本人最近一次保存设置的时间；从没保存过为 null（引导据此判断做过这一步）。 */
  updatedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  lastRun: Type.Union([PersonalRadarRun, Type.Null()]),
  unreadCount: Type.Integer({ minimum: 0 }),
  /** 全网检索（博查）是否可用；不可用时，只写方向或只填网站都不会有结果，只有订阅源能读。 */
  webSearch: Type.Boolean(),
  suggestions: Type.Object({
    directions: Type.Array(RadarDirectionSuggestion, { maxItems: 3 }),
    /** 只列能如实读取的常用来源，附读法。 */
    sources: Type.Array(RadarSourceSetting, { maxItems: 12 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export const PutMyRadarRequest = Type.Object({
  enabled: Type.Boolean(),
  directions: Type.Array(DirectionText, { maxItems: RADAR_MAX_DIRECTIONS }),
  sources: Type.Array(SourceInput, { maxItems: RADAR_MAX_SOURCES }),
}, { additionalProperties: false });

export const PersonalSignalSource = Type.Object({
  type: Type.Union([Type.Literal("web"), Type.Literal("outlet"), Type.Literal("list")]),
  /** 发布方名或网址主机。 */
  label: Type.String({ minLength: 1, maxLength: 200 }),
  title: Type.String({ minLength: 1, maxLength: 500 }),
  url: Type.String({ minLength: 1, maxLength: 2000 }),
  /** 榜单条目没有发布时间，为 null；web / outlet 一定有。 */
  publishedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  /** 榜单条目的上榜日（02b）；其他来源为 null。 */
  listedOn: Type.Union([Type.String({ format: "date" }), Type.Null()]),
  /** 榜单条目的语言与时段内 star（02b）；时段跟着榜单版本（日／周／月）。其他来源为 null。 */
  listing: Type.Union([Type.Object({
    language: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
    starsInPeriod: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    since: Type.Union([Type.Literal("daily"), Type.Literal("weekly"), Type.Literal("monthly")]),
  }, { additionalProperties: false }), Type.Null()]),
}, { additionalProperties: false });

export const PersonalSignalState = Type.Object({
  read: Type.Boolean(),
  saved: Type.Boolean(),
  dismissed: Type.Boolean(),
}, { additionalProperties: false });

/** 列表与首页用的轻量信号：不带原文。 */
export const PersonalSignalBrief = Type.Object({
  id: Type.String({ format: "uuid" }),
  source: PersonalSignalSource,
  /** 命中时的方向快照：之后改写或删掉方向，旧信号仍说得清为什么。 */
  direction: RadarDirection,
  summary: Type.String({ minLength: 1, maxLength: 60 }),
  reason: Type.String({ minLength: 1, maxLength: 300 }),
  relevance: Type.Integer({ minimum: 1, maximum: 5 }),
  state: PersonalSignalState,
  collectedAt: Type.String({ format: "date-time" }),
}, { additionalProperties: false });

/** 阅读页用的完整信号。 */
export const PersonalSignal = Type.Object({
  ...PersonalSignalBrief.properties,
  excerpt: Type.String({ minLength: 1, maxLength: 10_000 }),
  /** excerpt 是否为全文（订阅源只给摘要时为 false）。 */
  fullText: Type.Boolean(),
  evidenceQuote: Type.String({ minLength: 1, maxLength: 1000 }),
}, { additionalProperties: false });

/** 只含本人、未隐藏的信号，按 collectedAt 倒序。 */
export const PersonalSignalList = Type.Object({
  signals: Type.Array(PersonalSignalBrief, { maxItems: 100 }),
}, { additionalProperties: false });

export const ListMyRadarSignalsQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });

export const MyRadarScanAccepted = Type.Object({ queued: Type.Literal(true) }, { additionalProperties: false });

/** 成员首页的雷达小组件；雷达关着（或看的人是 CEO）时，首页响应里为 null。 */
export const MemberRadarBrief = Type.Object({
  lastRun: Type.Union([PersonalRadarRun, Type.Null()]),
  unreadCount: Type.Integer({ minimum: 0 }),
  /** 最近 7 天未隐藏的信号里，相关度优先、再按时间，最多 3 条。 */
  highlights: Type.Array(PersonalSignalBrief, { maxItems: 3 }),
}, { additionalProperties: false });

/** CEO 在同一个编辑器里改的是公司雷达：手工方向与目录里的发布方。 */
export const CompanyRadarSettings = Type.Object({
  directions: Type.Array(RadarDirection, { maxItems: RADAR_MAX_DIRECTIONS }),
  sources: Type.Array(RadarSourceSetting, { maxItems: RADAR_MAX_SOURCES }),
  /** 签发的本月目标、会议复议条件等自动方向，只读。 */
  automatic: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 50 }),
  webSearch: Type.Boolean(),
  suggestions: Type.Object({
    sources: Type.Array(RadarSourceSetting, { maxItems: 12 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export const PutCompanyRadarRequest = Type.Object({
  directions: Type.Array(DirectionText, { maxItems: RADAR_MAX_DIRECTIONS }),
  sources: Type.Array(SourceInput, { maxItems: RADAR_MAX_SOURCES }),
}, { additionalProperties: false });

/** 判定模型提交的严格候选：没有升级字段，多给字段会被拒。 */
export const PersonalRadarJudgeSubmission = Type.Object({
  candidates: Type.Array(Type.Object({
    sourceFingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    directionId: Type.String({ minLength: 1, maxLength: 100 }),
    summary: Type.String({ minLength: 1, maxLength: 60 }),
    reason: Type.String({ minLength: 1, maxLength: 300 }),
    evidenceQuote: Type.String({ minLength: 1, maxLength: 1000 }),
    relevance: Type.Integer({ minimum: 1, maximum: 5 }),
  }, { additionalProperties: false }), { maxItems: 20 }),
}, { additionalProperties: false });

export type TRadarDirection = Static<typeof RadarDirection>;
export type TRadarSourceSetting = Static<typeof RadarSourceSetting>;
export type TPersonalRadarRun = Static<typeof PersonalRadarRun>;
export type TMyRadar = Static<typeof MyRadar>;
export type TPutMyRadarRequest = Static<typeof PutMyRadarRequest>;
export type TPersonalSignalBrief = Static<typeof PersonalSignalBrief>;
export type TPersonalSignal = Static<typeof PersonalSignal>;
export type TPersonalSignalList = Static<typeof PersonalSignalList>;
export type TMemberRadarBrief = Static<typeof MemberRadarBrief>;
export type TCompanyRadarSettings = Static<typeof CompanyRadarSettings>;
export type TPutCompanyRadarRequest = Static<typeof PutCompanyRadarRequest>;
export type TPersonalRadarJudgeSubmission = Static<typeof PersonalRadarJudgeSubmission>;
