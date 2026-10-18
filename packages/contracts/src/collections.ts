import { Type, type Static } from "@sinclair/typebox";
import { ActionDescriptor } from "./cards.js";
import { RequestPerson, RequestStep } from "./requests.js";

/**
 * ③ 信息收集（小版本）：只做两个场景——财务每周开销、方法部门每周进展，大家共填一张飞书多维表格。
 * 发起人一句话 → Agent 起草「收什么、发给谁、截止」→ 预览后发出；每次发出是一轮，对应一条 kind = collection 的请求（送达通道），
 * 接收人的待办卡、通知栏、飞书通知都复用它。每人一行：Agent 先填一版草稿，本人改好在天枢里点「确认完成」。
 */
export const CollectionScenario = Type.Union([Type.Literal("expense"), Type.Literal("method_progress")]);
export const CollectionStatus = Type.Union([Type.Literal("draft"), Type.Literal("active"), Type.Literal("stopped")]);

/** 表里的一栏；required 的栏都填了才算「已填」。 */
export const CollectionField = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 40 }),
    label: Type.String({ minLength: 1, maxLength: 40 }),
    kind: Type.Union([Type.Literal("text"), Type.Literal("number"), Type.Literal("link")]),
    required: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** empty：必填栏没填齐；filled：填齐了还没确认；confirmed：本人点了「确认完成」。 */
export const CollectionEntryStatus = Type.Union([Type.Literal("empty"), Type.Literal("filled"), Type.Literal("confirmed")]);

export const CollectionEntryView = Type.Object(
  {
    personId: Type.String({ minLength: 1 }),
    displayName: Type.String({ minLength: 1 }),
    /** 按栏的 key；没填的栏不出现。 */
    values: Type.Record(Type.String(), Type.String()),
    /** 必填栏里填了几栏 / 一共几栏。 */
    filled: Type.Integer({ minimum: 0 }),
    required: Type.Integer({ minimum: 0 }),
    status: CollectionEntryStatus,
    /** 草稿的来源：weekly_review = 本人这周已提交的周复盘。 */
    draftFrom: Type.Union([Type.Literal("weekly_review"), Type.Null()]),
    confirmedAt: Type.Union([Type.String(), Type.Null()]),
    updatedAt: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

export const CollectionRoundView = Type.Object(
  {
    requestId: Type.String({ minLength: 1 }),
    /** 这一轮所在周的周一（YYYY-MM-DD，上海时间）。 */
    weekStart: Type.String({ minLength: 10, maxLength: 10 }),
    deadlineAt: Type.String({ minLength: 1 }),
    remindedAt: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

/** 发起人看到草稿或某一轮的汇总（所有人的行）；接收人只看到这一轮里自己的那一行。 */
export const CollectionView = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    status: CollectionStatus,
    version: Type.Integer({ minimum: 1 }),
    scenario: CollectionScenario,
    title: Type.String({ minLength: 1 }),
    prompt: Type.String({ minLength: 1 }),
    fields: Type.Array(CollectionField, { minItems: 1, maxItems: 10 }),
    initiator: RequestPerson,
    weekly: Type.Boolean(),
    /** 草稿：拟定的截止时间；某一轮：这一轮的截止时间（ISO 8601）。 */
    deadlineAt: Type.String({ minLength: 1 }),
    /** 飞书多维表格；还没建好（或没接飞书）时为 null。 */
    table: Type.Union([Type.Object({ url: Type.String({ minLength: 1 }) }, { additionalProperties: false }), Type.Null()]),
    /** 草稿：Agent 建议的收件人。 */
    candidates: Type.Array(RequestPerson),
    /** 草稿：发起人可以加的人（真实人员目录，去掉自己）。 */
    directory: Type.Array(RequestPerson),
    round: Type.Union([CollectionRoundView, Type.Null()]),
    entries: Type.Array(CollectionEntryView),
    counts: Type.Object(
      { total: Type.Integer({ minimum: 0 }), filled: Type.Integer({ minimum: 0 }), confirmed: Type.Integer({ minimum: 0 }) },
      { additionalProperties: false },
    ),
    viewer: Type.Object({ isInitiator: Type.Boolean(), isRecipient: Type.Boolean() }, { additionalProperties: false }),
    /** collection.send（草稿）、collection.save / collection.confirm（接收人自己那一行）、collection.stop（每周固定的停用）。 */
    actions: Type.Array(ActionDescriptor),
  },
  { additionalProperties: false },
);

export const CollectionResponse = Type.Object({ collection: CollectionView }, { additionalProperties: false });

/** 起草：第一次只给 prompt；带 collectionId 时按改过的原话重写同一份草稿（version 加一）。 */
export const DraftCollectionRequest = Type.Object(
  { prompt: Type.String({ minLength: 1, maxLength: 2000 }), collectionId: Type.Optional(Type.String({ minLength: 1 })) },
  { additionalProperties: false },
);
export const DraftCollectionResponse = Type.Object(
  { collection: CollectionView, steps: Type.Array(RequestStep) },
  { additionalProperties: false },
);

export const CollectionSendInput = Type.Object(
  {
    recipientIds: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 30 }),
    /** ISO 8601；必须晚于现在。 */
    deadlineAt: Type.String({ minLength: 1, maxLength: 40 }),
    weekly: Type.Boolean(),
  },
  { additionalProperties: false },
);
export const CollectionSaveInput = Type.Object(
  { values: Type.Record(Type.String({ maxLength: 40 }), Type.String({ maxLength: 4000 })) },
  { additionalProperties: false },
);
export const ExecuteCollectionActionRequest = Type.Object(
  { actionId: Type.String({ minLength: 1 }), input: Type.Optional(Type.Unknown()) },
  { additionalProperties: false },
);

/**
 * 设置里的定时任务区：收集（每周固定的收集任务）、其他（每周五起草周复盘、上手时搬过来的本机定时任务）。
 * origin=collection 的可以在这里停用。
 */
export const ScheduleItem = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    category: Type.Union([Type.Literal("collect"), Type.Literal("other")]),
    origin: Type.Union([Type.Literal("collection"), Type.Literal("weekly_review"), Type.Literal("local")]),
    name: Type.String({ minLength: 1 }),
    cadence: Type.Union([Type.String(), Type.Null()]),
    /** 下次什么时候跑（ISO 8601）；说不准（本机任务）或已停用时为 null。 */
    nextRunAt: Type.Union([Type.String(), Type.Null()]),
    active: Type.Boolean(),
    /** 点开去哪里（收集任务的最近一轮）。 */
    href: Type.Union([Type.String(), Type.Null()]),
    /** 来源设备（本机任务）。 */
    deviceName: Type.Union([Type.String(), Type.Null()]),
    actions: Type.Array(ActionDescriptor),
  },
  { additionalProperties: false },
);
export const ScheduleListResponse = Type.Object({ items: Type.Array(ScheduleItem) }, { additionalProperties: false });

export type TCollectionScenario = Static<typeof CollectionScenario>;
export type TCollectionStatus = Static<typeof CollectionStatus>;
export type TCollectionField = Static<typeof CollectionField>;
export type TCollectionEntryStatus = Static<typeof CollectionEntryStatus>;
export type TCollectionEntryView = Static<typeof CollectionEntryView>;
export type TCollectionRoundView = Static<typeof CollectionRoundView>;
export type TCollectionView = Static<typeof CollectionView>;
export type TCollectionResponse = Static<typeof CollectionResponse>;
export type TDraftCollectionRequest = Static<typeof DraftCollectionRequest>;
export type TDraftCollectionResponse = Static<typeof DraftCollectionResponse>;
export type TCollectionSendInput = Static<typeof CollectionSendInput>;
export type TCollectionSaveInput = Static<typeof CollectionSaveInput>;
export type TExecuteCollectionActionRequest = Static<typeof ExecuteCollectionActionRequest>;
export type TScheduleItem = Static<typeof ScheduleItem>;
export type TScheduleListResponse = Static<typeof ScheduleListResponse>;
