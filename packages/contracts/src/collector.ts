import { Type, type Static } from "@sinclair/typebox";

/** 本机采集器上报：鉴权用 client=collector 的个人令牌，人取自令牌，请求体里不带人。 */
const Instant = Type.String({ format: "date-time" });
const SourceName = Type.String({ pattern: "^[a-z0-9_-]{1,32}$" });

export const CollectorDevice = Type.Object({
  /** 安装时生成、存在本机状态文件里的设备 id。 */
  id: Type.String({ pattern: "^[A-Za-z0-9_-]{8,64}$" }),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  platform: Type.Union([Type.Literal("windows"), Type.Literal("macos"), Type.Literal("linux")]),
}, { additionalProperties: false });

export const CollectorSourceStatus = Type.Union([Type.Literal("ok"), Type.Literal("not_found"), Type.Literal("error")]);
/** 一个来源（codex、claude……）在这台设备上的状态：信息截至、最近一次有新证据的时刻。 */
export const CollectorSourceState = Type.Object({
  source: SourceName,
  status: CollectorSourceStatus,
  coverageUntil: Type.Union([Instant, Type.Null()]),
  lastNewEvidenceAt: Type.Union([Instant, Type.Null()]),
  errorCode: Type.Union([Type.String({ pattern: "^[A-Z0-9_]{1,40}$" }), Type.Null()]),
}, { additionalProperties: false });


/** consent：本人是否同意采集（D-18）；没同意时心跳带的本机清单不收，采集器据此不做盘点。 */
export const CollectorHeartbeatResponse = Type.Object({ receivedAt: Instant, consent: Type.Boolean() }, { additionalProperties: false });

export const CollectorLink = Type.Object({
  url: Type.String({ pattern: "^https?://", maxLength: 500 }),
  title: Type.Optional(Type.String({ maxLength: 120 })),
}, { additionalProperties: false });
/** 一段工作：client_event_id 由本机按设备、来源、会话与时间段算出，重放同一条只记一次。 */
export const CollectorReportItem = Type.Object({
  clientEventId: Type.String({ format: "uuid" }),
  source: SourceName,
  startedAt: Instant,
  endedAt: Instant,
  summary: Type.String({ minLength: 1, maxLength: 4000 }),
  links: Type.Array(CollectorLink, { maxItems: 20 }),
  taskHint: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
}, { additionalProperties: false });

export const CollectorScheduledTask = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  schedule: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  command: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
}, { additionalProperties: false });
export const CollectorFeishuDoc = Type.Object({
  url: Type.String({ pattern: "^https://", maxLength: 500 }),
  title: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  readAt: Instant,
}, { additionalProperties: false });
/** 记忆文件的盘点：只有路径（以 ~/ 开头）、大小、修改时间，不含正文。 */
export const CollectorMemoryFile = Type.Object({
  source: SourceName,
  path: Type.String({ minLength: 1, maxLength: 500 }),
  bytes: Type.Integer({ minimum: 0 }),
  modifiedAt: Instant,
}, { additionalProperties: false });
/**
 * 本机清单：定时任务、近 30 天会话里读过的飞书文档、记忆文件盘点。
 * 采集器每天做一次完整盘点，随当次的心跳或上报带上；不带 memoryFiles 的旧版采集器照收。
 */
export const CollectorInventory = Type.Object({
  scheduledTasks: Type.Array(CollectorScheduledTask, { maxItems: 200 }),
  feishuDocs: Type.Array(CollectorFeishuDoc, { maxItems: 200 }),
  memoryFiles: Type.Optional(Type.Array(CollectorMemoryFile, { maxItems: 500 })),
}, { additionalProperties: false });

export const CollectorHeartbeatRequest = Type.Object({
  device: CollectorDevice,
  version: Type.String({ minLength: 1, maxLength: 40 }),
  sources: Type.Array(CollectorSourceState, { minItems: 1, maxItems: 10 }),
  inventory: Type.Optional(CollectorInventory),
}, { additionalProperties: false });

export const CollectorReportKind = Type.Union([Type.Literal("digest"), Type.Literal("eod"), Type.Literal("catchup")]);
export const CollectorReportRequest = Type.Object({
  device: CollectorDevice,
  version: Type.String({ minLength: 1, maxLength: 40 }),
  kind: CollectorReportKind,
  windowStart: Instant,
  windowEnd: Instant,
  sources: Type.Array(CollectorSourceState, { minItems: 1, maxItems: 10 }),
  items: Type.Array(CollectorReportItem, { maxItems: 200 }),
  inventory: Type.Optional(CollectorInventory),
}, { additionalProperties: false });
export const CollectorReportResponse = Type.Object({
  /** 这次新记下的条数；重放已记过的不算。 */
  accepted: Type.Integer({ minimum: 0 }),
  duplicates: Type.Integer({ minimum: 0 }),
  receivedAt: Instant,
}, { additionalProperties: false });

/**
 * 上手时本人同意采集（D-02）：同意后本机采集器上报的原文片段才被收下，服务端用统一的模型整理成进展；
 * 原文只有本人能看，收到 14 天后删除。没同意或撤回后，上报的工作段一律不收（心跳照收），撤回时清空本人的原文。
 */
export const CollectorConsent = Type.Object({
  granted: Type.Boolean(),
  updatedAt: Type.Union([Instant, Type.Null()]),
}, { additionalProperties: false });
export const CollectorConsentResponse = Type.Object({ consent: CollectorConsent }, { additionalProperties: false });
export const UpdateCollectorConsentRequest = Type.Object({ granted: Type.Boolean() }, { additionalProperties: false });

/** 本人的采集器：连上的设备（收到过心跳或上报）、最近一次完整盘点、盘点到的条数。上手的「安装采集器」和扫描页轮询这里。 */
export const CollectorStatusResponse = Type.Object({
  /** 本人是否同意采集：没同意时不收本机清单，扫描页那几步停在「未同意」。 */
  consent: Type.Boolean(),
  devices: Type.Array(Type.Object({
    id: Type.String(),
    name: Type.String(),
    platform: Type.String(),
    lastSeenAt: Instant,
  }, { additionalProperties: false })),
  scannedAt: Type.Union([Instant, Type.Null()]),
  inventory: Type.Object({
    scheduledTasks: Type.Integer({ minimum: 0 }),
    feishuDocs: Type.Integer({ minimum: 0 }),
    memoryFiles: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export type TCollectorStatusResponse = Static<typeof CollectorStatusResponse>;
export type TCollectorConsent = Static<typeof CollectorConsent>;
export type TCollectorConsentResponse = Static<typeof CollectorConsentResponse>;
export type TCollectorDevice = Static<typeof CollectorDevice>;
export type TCollectorSourceState = Static<typeof CollectorSourceState>;
export type TCollectorHeartbeatRequest = Static<typeof CollectorHeartbeatRequest>;
export type TCollectorHeartbeatResponse = Static<typeof CollectorHeartbeatResponse>;
export type TCollectorReportItem = Static<typeof CollectorReportItem>;
export type TCollectorInventory = Static<typeof CollectorInventory>;
export type TCollectorReportRequest = Static<typeof CollectorReportRequest>;
export type TCollectorReportResponse = Static<typeof CollectorReportResponse>;
