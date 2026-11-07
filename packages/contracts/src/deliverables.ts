import { Type, type Static } from "@sinclair/typebox";

/**
 * Task 的交付物（spec 5.2–5.4）：一个本体 Task 一个交付物，交付物有多个版本；每个版本自动做一次参考评审（有约定时按约定里的「用什么证明」判）。
 * 评审只作参考、不卡交付（11/03 定）：最新一版评审跑完就能交，交付由本人点。交付以后伙伴写这一版的说明（默认认可）。Co-Agent 的评判第二批再接。
 */

/** 一个版本里的一样东西：文件（PDF、Word、Markdown、HTML）、图片、链接。read 是评审能不能读到它。 */
export const DeliverableItem = Type.Object({
  id: Type.String({ format: "uuid" }),
  kind: Type.Union([Type.Literal("file"), Type.Literal("image"), Type.Literal("link")]),
  name: Type.String({ minLength: 1 }),
  mimeType: Type.Union([Type.String(), Type.Null()]),
  sizeBytes: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  pageCount: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  url: Type.Union([Type.String(), Type.Null()]),
  read: Type.Union([Type.Literal("pending"), Type.Literal("read"), Type.Literal("unreadable")]),
  /** 读不了时的一句原因（如「打不开 · 请导出后上传」）。 */
  readNote: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });

export const CriterionVerdict = Type.Union([Type.Literal("met"), Type.Literal("partial"), Type.Literal("unmet")]);

/** 本人对某一条判定的异议：upheld 是带着异议重评以后的结果（true 改判达到，false 仍不达到，null 还在重评）。 */
export const CriterionDissent = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 200 }),
  upheld: Type.Union([Type.Boolean(), Type.Null()]),
}, { additionalProperties: false });

/** 评审报告里的一条：对照哪条标准（index 从 1 起）、判定、理由、依据（引用交付物哪一处）、怎么补。 */
export const ReviewCriterion = Type.Object({
  index: Type.Integer({ minimum: 1 }),
  text: Type.String({ minLength: 1 }),
  verdict: CriterionVerdict,
  reason: Type.String(),
  evidence: Type.Union([Type.String(), Type.Null()]),
  fix: Type.Union([Type.String(), Type.Null()]),
  dissent: Type.Union([CriterionDissent, Type.Null()]),
}, { additionalProperties: false });

/** 按哪套标准评：本体验收标准、没有时用完成定义、两样都没有就不评。 */
export const ReviewBasis = Type.Union([Type.Literal("acceptance"), Type.Literal("definition"), Type.Literal("none")]);

/**
 * 一个版本的评审，只作参考（11/03 定）：不卡交付，也不用来算进展。phase 是评审中走到哪一步（step / total，label 如「对照第 2 条」）；
 * expectedSeconds 是预计用时。score 是达标度（达到 100、部分 50、未达到 0 的平均），met / total 是几条达到；ready 是每一条都达到。
 * beyondScope 是约定外的改进建议（「下次可以做」），不算进部分达到、未达到；11/06 以前的报告为空。
 */
export const DeliverableReview = Type.Object({
  status: Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("done"), Type.Literal("failed")]),
  phase: Type.Union([Type.Object({ step: Type.Integer({ minimum: 1 }), total: Type.Integer({ minimum: 1 }), label: Type.String() }, { additionalProperties: false }), Type.Null()]),
  startedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  finishedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  expectedSeconds: Type.Integer({ minimum: 1 }),
  basis: ReviewBasis,
  headline: Type.Union([Type.String(), Type.Null()]),
  summary: Type.Union([Type.String(), Type.Null()]),
  /** 这一版比上一版多达到了什么；第一版为 null。 */
  gain: Type.Union([Type.String(), Type.Null()]),
  /** 这一版的材料和这个 Task 对不上时的一句话（像是哪个 Task 的就点名）；对得上为 null。 */
  mismatch: Type.Union([Type.String(), Type.Null()]),
  score: Type.Union([Type.Integer({ minimum: 0, maximum: 100 }), Type.Null()]),
  met: Type.Integer({ minimum: 0 }),
  total: Type.Integer({ minimum: 0 }),
  ready: Type.Boolean(),
  criteria: Type.Array(ReviewCriterion),
  beyondScope: Type.Array(Type.String()),
  error: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });

/** 交付以后伙伴写的这一版说明：达成了什么、这一版多做到的、为什么变了、经验。本人可以改，可以不要。 */
export const DeliverableNote = Type.Object({
  status: Type.Union([Type.Literal("writing"), Type.Literal("done"), Type.Literal("failed")]),
  achieved: Type.Union([Type.String(), Type.Null()]),
  gain: Type.Union([Type.String(), Type.Null()]),
  why: Type.Union([Type.String(), Type.Null()]),
  lesson: Type.Union([Type.String(), Type.Null()]),
  edited: Type.Boolean(),
  dismissed: Type.Boolean(),
}, { additionalProperties: false });

export const DeliverableVersion = Type.Object({
  id: Type.String({ format: "uuid" }),
  number: Type.Integer({ minimum: 1 }),
  /** 附的一句话，或「说说现状」写下的现状说明。 */
  statement: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String({ format: "date-time" }),
  items: Type.Array(DeliverableItem),
  review: DeliverableReview,
  deliveredAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  note: Type.Union([DeliverableNote, Type.Null()]),
}, { additionalProperties: false });

/**
 * 一个 Task 的交付物：criteria 是这次按哪几条评（basis 说明来源）；responsibleId 是本体登记的负责人（没登记时为 null）。
 * canEdit：本人能不能传新版本、交付（负责人本人；本体没登记负责人时是这个 Mission 的负责人）。versions 新的在前。
 */
export const TaskDeliverableResponse = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  responsibleId: Type.Union([Type.String(), Type.Null()]),
  /** 负责人的名字，没登记时为 null。 */
  responsibleName: Type.Union([Type.String(), Type.Null()]),
  canEdit: Type.Boolean(),
  basis: ReviewBasis,
  criteria: Type.Array(Type.String()),
  versions: Type.Array(DeliverableVersion),
}, { additionalProperties: false });

/** 首页 Task 列表上的状态：未开始、评审中、迭代中（带达标度）、可以交付、已交付；version 是最新一版的编号，没有版本时为 null。 */
export const TaskDeliverableStatus = Type.Object({
  status: Type.Union([Type.Literal("none"), Type.Literal("reviewing"), Type.Literal("iterating"), Type.Literal("ready"), Type.Literal("delivered")]),
  score: Type.Union([Type.Integer({ minimum: 0, maximum: 100 }), Type.Null()]),
  version: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
}, { additionalProperties: false });

export const DeliverableDissentRequest = Type.Object({ reason: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false });

/** 改版本说明：改其中几句，或者不要这段（dismissed）。 */
export const DeliverableNotePatch = Type.Object({
  achieved: Type.Optional(Type.String({ maxLength: 120 })),
  gain: Type.Optional(Type.String({ maxLength: 200 })),
  why: Type.Optional(Type.String({ maxLength: 300 })),
  lesson: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  dismissed: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export type TDeliverableItem = Static<typeof DeliverableItem>;
export type TCriterionVerdict = Static<typeof CriterionVerdict>;
export type TReviewCriterion = Static<typeof ReviewCriterion>;
export type TReviewBasis = Static<typeof ReviewBasis>;
export type TDeliverableReview = Static<typeof DeliverableReview>;
export type TDeliverableNote = Static<typeof DeliverableNote>;
export type TDeliverableVersion = Static<typeof DeliverableVersion>;
export type TTaskDeliverableResponse = Static<typeof TaskDeliverableResponse>;
export type TTaskDeliverableStatus = Static<typeof TaskDeliverableStatus>;
export type TDeliverableDissentRequest = Static<typeof DeliverableDissentRequest>;
export type TDeliverableNotePatch = Static<typeof DeliverableNotePatch>;
