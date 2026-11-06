import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { CriterionVerdict } from "./deliverables.js";
import { LocalHandbackCriterion } from "./localRunner.js";
import { LocalOutputView, LocalRunView } from "./localDevices.js";
import { TaskPerson, TaskView } from "./tasks.js";
import { CardCriterion, CardExecutor, CardHandbackBrief, CardModel, TaskCard } from "./taskCardView.js";
import { RoleBrief, RoleRef } from "./roles.js";

/**
 * 执行看板（V2 设计第 3–8 节）：Task 页右边的四列加交付物、拆卡、卡的详情、Agent 验收和推翻、准备中的交付物和「出下一版」。
 * 「Task 负责人」照交付物的规则：本人 Mission 下的 Task，本体登记了负责人时只有他；「推进人」是这张卡（执行事项）的推进人。
 * V2 只有本人看得到卡的细节。
 */

const strict = { additionalProperties: false } as const;
const Instant = Type.String({ format: "date-time" });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** 带上卡的执行事项：TaskView 的全部字段加 card。看板和卡的详情里每一项都有 card。 */
export const CardTaskView = Type.Object({ ...TaskView.properties, card: TaskCard }, strict);

/** 一次拆卡（后台作业）：同一个 Task 同时只跑一次。expectedSeconds 是预计用时，网页显示「已用 / 预计」。 */
export const CardPlanView = Type.Object({
  id: Type.String({ format: "uuid" }),
  status: Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("done"), Type.Literal("failed")]),
  hint: Nullable(Type.String()),
  error: Nullable(Type.String()),
  createdAt: Instant,
  startedAt: Nullable(Instant),
  finishedAt: Nullable(Instant),
  expectedSeconds: Type.Integer({ minimum: 1 }),
}, strict);

/** 伙伴建议的模型档位，本人开工时再落到具体模型。 */
export const CardModelTier = Type.Union([Type.Literal("strong"), Type.Literal("normal"), Type.Literal("light")]);

/**
 * 草稿卡：还不是执行事项，在「待开始」里画成虚线。doneDefinition 每行一条完成标准；criterionIndex 对 Task 的第几条标准（从 1 起），对「其他」为 null。
 * role 是伙伴给它配的岗位（本人的岗位之一）；本人没有合适的岗位时为 null，suggestPresetKey 是建议从哪个预设加一个。
 * executor、modelTier 是配岗位以前的建议，留着兼容。why 是伙伴一句话说为什么这么拆。只列还没处理的（放进看板或不要以后就不在了）。
 */
export const CardDraftView = Type.Object({
  id: Type.String({ format: "uuid" }),
  planId: Type.String({ format: "uuid" }),
  position: Type.Integer({ minimum: 0 }),
  title: Type.String({ minLength: 1, maxLength: 120 }),
  brief: Type.String({ maxLength: 4000 }),
  doneDefinition: Type.String({ minLength: 1, maxLength: 500 }),
  criterionIndex: Nullable(Type.Integer({ minimum: 1 })),
  role: Nullable(RoleRef),
  suggestPresetKey: Nullable(Type.String()),
  executor: CardExecutor,
  modelTier: CardModelTier,
  why: Nullable(Type.String({ maxLength: 200 })),
}, strict);

/**
 * 准备中的一样东西（等进下一版交付物）：kind=card 是一张 Agent 验收通过的卡（cardId 是执行事项 id），
 * kind=topic 是调研专题的一版（topicId、topicVersionId）。title 是卡的标题，或「专题标题 · 第 N 版」。
 */
export const PendingDeliverableItem = Type.Object({
  id: Type.String({ format: "uuid" }),
  kind: Type.Union([Type.Literal("card"), Type.Literal("topic")]),
  title: Type.String({ minLength: 1 }),
  cardId: Nullable(Type.String({ minLength: 1 })),
  topicId: Nullable(Type.String({ format: "uuid" })),
  topicVersionId: Nullable(Type.String({ format: "uuid" })),
  addedAt: Instant,
}, strict);

/**
 * GET /api/plan-tasks/:taskId/cards：Task 页看板一次给全。
 * criteria 是这个 Task 的标准（卡上圆圈数字对的就是它；没有验收标准时是完成定义那一条）；cards 是本人挂在这个 Task 下的执行事项（不含退回的）；
 * drafts 是还没处理的草稿；plan 是最近一次拆卡（没拆过为 null）；pending 是准备中的；nextVersion 是下一版交付物的号。
 */
export const CardBoardResponse = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  criteria: Type.Array(CardCriterion),
  cards: Type.Array(CardTaskView),
  drafts: Type.Array(CardDraftView),
  plan: Nullable(CardPlanView),
  pending: Type.Array(PendingDeliverableItem),
  nextVersion: Type.Integer({ minimum: 1 }),
}, strict);

/** 拆卡：hint 是本人说的「想怎么拆」。已经有一次在排队或在跑时，直接返回那一次（200），不另起。 */
export const CreateCardPlanRequest = Type.Object({
  hint: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
}, strict);

/**
 * 放进看板：每张可以顺手改标题、交代、完成标准、执行方、岗位（roleId 是本人没归档的岗位，null 不配）。建出来的执行事项挂这个 Task 和它的 Mission，来源记「自己建」。
 * 已经放进过或不要了的草稿 409。返回建出来的卡，顺序同请求。
 */
export const AcceptCardDraftsRequest = Type.Object({
  drafts: Type.Array(Type.Object({
    id: Type.String({ format: "uuid" }),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    brief: Type.Optional(Type.String({ maxLength: 4000 })),
    doneDefinition: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    executor: Type.Optional(CardExecutor),
    roleId: Type.Optional(Nullable(Type.String({ format: "uuid" }))),
  }, strict), { minItems: 1, maxItems: 8 }),
}, strict);
export const AcceptCardDraftsResponse = Type.Object({ cards: Type.Array(CardTaskView) }, strict);

/**
 * 改卡上卡的那几样（只有推进人）：执行方、岗位（本人没归档的岗位，null 不配）、模型、交代、对哪条标准。标题和完成标准照旧用 PATCH /api/me/tasks/:id。
 * version 不一致 409 VERSION_CONFLICT（带 latestTask）。除 version 外至少带一个字段。
 */
export const PatchCardRequest = Type.Object({
  version: Type.Integer({ minimum: 1 }),
  executor: Type.Optional(CardExecutor),
  roleId: Type.Optional(Nullable(Type.String({ format: "uuid" }))),
  model: Type.Optional(Nullable(CardModel)),
  brief: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 4000 }))),
  criterionIndex: Type.Optional(Nullable(Type.Integer({ minimum: 1 }))),
}, strict);

/** Agent 验收里的一条：对照卡的第几条完成标准（从 1 起）、判定、理由、依据、怎么补。 */
export const CardAcceptanceCriterion = Type.Object({
  index: Type.Integer({ minimum: 1 }),
  text: Type.String({ minLength: 1 }),
  verdict: CriterionVerdict,
  reason: Type.String(),
  evidence: Nullable(Type.String()),
  fix: Nullable(Type.String()),
}, strict);

/** 推翻：本人、时间、原因。 */
export const CardOverrule = Type.Object({ by: TaskPerson, at: Instant, reason: Type.String({ minLength: 1, maxLength: 200 }) }, strict);

/**
 * 一次交回和它的 Agent 验收。criteria 是交回那一刻卡的完成标准（快照）；claims 是执行方逐条写的（照本机的交回）；
 * outputIds 是这次交回算进去的产出和证据；result 是验收结论（没出结论为 null），beyondScope 是标准以外的建议，不算进没达到。
 * expectedSeconds 是验收预计用时；error 是验收本身出错的原因（status=failed 时）。
 */
export const CardHandbackView = Type.Object({
  ...CardHandbackBrief.properties,
  runId: Nullable(Type.String({ format: "uuid" })),
  criteria: Type.Array(Type.String()),
  claims: Type.Array(LocalHandbackCriterion),
  summary: Nullable(Type.String()),
  outputIds: Type.Array(Type.String({ format: "uuid" })),
  result: Nullable(Type.Object({
    criteria: Type.Array(CardAcceptanceCriterion),
    beyondScope: Type.Array(Type.String()),
  }, strict)),
  error: Nullable(Type.String()),
  startedAt: Nullable(Instant),
  expectedSeconds: Type.Integer({ minimum: 1 }),
  overrule: Nullable(CardOverrule),
}, strict);

/**
 * GET /api/me/cards/:id：卡的详情（只有推进人）。standards 是完成标准按行拆开；runs 是最近 5 次本机执行（新的在前）；
 * handbacks 是各次交回和验收（新的在前）；outputs 是本机传上来的产出和证据（新的在前）。
 */
export const CardDetailResponse = Type.Object({
  task: CardTaskView,
  brief: Nullable(Type.String()),
  standards: Type.Array(Type.String()),
  runs: Type.Array(LocalRunView, { maxItems: 5 }),
  handbacks: Type.Array(CardHandbackView),
  outputs: Type.Array(LocalOutputView),
}, strict);

/**
 * GET /api/me/cards/:id/brief：开工时交给本机的交代。markdown 原样作为本机会话的第一句话（≤ 20000 字）：
 * Mission、Task、对的那条标准和约定里它「用什么证明」、Task 的「这次不包括」、卡的交代和完成标准、Task 最新一版评审里这条还差什么、上一次验收没过的改法。
 * role 是卡的岗位（职责、做法、验收口径、工具、模型档位、版本），本机开工时按它注入；没配岗位为 null。
 * 工作规矩（怎么交回、产出写在哪）在本机程序的提示词里，这里不重复。
 */
export const CardBriefResponse = Type.Object({
  markdown: Type.String({ minLength: 1, maxLength: 20000 }),
  role: Nullable(RoleBrief),
  mission: Nullable(Type.Object({ missionId: Type.String({ minLength: 1 }), title: Type.String() }, strict)),
  task: Nullable(Type.Object({ taskId: Type.String({ minLength: 1 }), name: Type.String() }, strict)),
  criterion: Nullable(Type.Object({ index: Type.Integer({ minimum: 1 }), text: Type.String(), proof: Nullable(Type.String()) }, strict)),
  exclusions: Type.Array(Type.String()),
  reviewGap: Nullable(Type.String()),
  lastReturn: Nullable(Type.String()),
}, strict);

/**
 * 推翻 Agent 验收（只有推进人）：通过的推翻后卡回进行中、从准备中拿掉（已经进了某一版的不能推翻，409）；
 * 没过的推翻就是「仍然通过」，卡完成、进准备中，验收记录写本人。
 */
export const OverruleCardHandbackRequest = Type.Object({ reason: Type.String({ minLength: 1, maxLength: 200 }) }, strict);

/** 把调研专题的一版放进下一版交付物（专题要挂在这个 Task 上）。 */
export const AddPendingDeliverableRequest = Type.Object({ topicVersionId: Type.String({ format: "uuid" }) }, strict);

/**
 * 出下一版：准备中的各样，连同上一版的全部材料，建成新一版交付物，评审照常自动开始。statement 不填就用这几张卡的标题拼一句。
 * 准备中没有东西 409 NOTHING_PENDING；超过一版的上限（10 份文件、5 个链接）400 DELIVERABLE_LIMIT，什么都不写。
 */
export const CreateVersionFromPendingRequest = Type.Object({
  statement: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
}, strict);

export type TCardTaskView = Static<typeof CardTaskView>;
export type TCardPlanView = Static<typeof CardPlanView>;
export type TCardModelTier = Static<typeof CardModelTier>;
export type TCardDraftView = Static<typeof CardDraftView>;
export type TPendingDeliverableItem = Static<typeof PendingDeliverableItem>;
export type TCardBoardResponse = Static<typeof CardBoardResponse>;
export type TCreateCardPlanRequest = Static<typeof CreateCardPlanRequest>;
export type TAcceptCardDraftsRequest = Static<typeof AcceptCardDraftsRequest>;
export type TAcceptCardDraftsResponse = Static<typeof AcceptCardDraftsResponse>;
export type TPatchCardRequest = Static<typeof PatchCardRequest>;
export type TCardAcceptanceCriterion = Static<typeof CardAcceptanceCriterion>;
export type TCardOverrule = Static<typeof CardOverrule>;
export type TCardHandbackView = Static<typeof CardHandbackView>;
export type TCardDetailResponse = Static<typeof CardDetailResponse>;
export type TCardBriefResponse = Static<typeof CardBriefResponse>;
export type TOverruleCardHandbackRequest = Static<typeof OverruleCardHandbackRequest>;
export type TAddPendingDeliverableRequest = Static<typeof AddPendingDeliverableRequest>;
export type TCreateVersionFromPendingRequest = Static<typeof CreateVersionFromPendingRequest>;
