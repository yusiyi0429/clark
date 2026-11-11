import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { SourceWords } from "./cardSplits.js";
import { Budget } from "./budget.js";
import { LocalHandbackCriterion } from "./localRunner.js";
import { LocalOutputView, LocalRunView } from "./localDevices.js";
import { TaskPerson, TaskView } from "./tasks.js";
import { CardCriterion, CardCriterionVerdict, CardExecutor, CardFixBy, CardGit, CardHandbackBrief, CardModel, TaskCard } from "./taskCardView.js";
import { RoleBrief, RoleRef } from "./roles.js";
import { NullableInteger } from "./nullable.js";

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
  /**
   * 谁拆的（第 21 节）：local 是本人电脑上的规划员（经同步条目 card_plan 报上来，到了就是 done），cloud 是云端拆卡作业（开关 BOARD_CLOUD_AGENTS，默认关）。
   * 本机规划员出的还带计划：summary 一句话，steps 几步（数组顺序就是先后），risks 风险，revision 是第几次出（以最新一次为准）；云端拆的这几样是空的。
   */
  source: Type.Union([Type.Literal("cloud"), Type.Literal("local")]),
  summary: Nullable(Type.String()),
  steps: Type.Array(Type.Object({ title: Type.String({ minLength: 1 }), detail: Nullable(Type.String()) }, strict)),
  risks: Type.Array(Type.String()),
  revision: NullableInteger({ minimum: 1 }),
  /**
   * 项目对话里按序号插（17.2 第 29 条，项目对话的消息从 Chat 读回来不带时间，网页按它把这一块插在那条消息后面（同 ProjectTransfer.afterSequence））：
   * afterSequence 是开拆（登记拆卡）那一下本人看到的最后一条，派活单、拆卡失败插在它后面；
   * startedAfterSequence 是开工（派活单放进看板、第一张卡建出来）那一下的，「开了哪几个子会话」插在它后面。还没开工、读不到、老记录为 null，网页走兜底。
   */
  afterSequence: NullableInteger({ minimum: 1 }),
  startedAfterSequence: NullableInteger({ minimum: 1 }),
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
  doneDefinition: Type.String({ minLength: 1, maxLength: 2000 }),
  criterionIndex: NullableInteger({ minimum: 1 }),
  role: Nullable(RoleRef),
  suggestPresetKey: Nullable(Type.String()),
  executor: CardExecutor,
  modelTier: CardModelTier,
  why: Nullable(Type.String({ maxLength: 200 })),
  /** 本人原话（16.8）：云端核对过的原文片段，或整条原话；登记时什么都没说为空。 */
  sourceWords: SourceWords,
}, strict);

/**
 * 准备中的一样东西（等进下一版交付物）：kind=card 是一张 Agent 验收通过的卡（cardId 是执行事项 id），
 * kind=topic 是调研专题的一版（topicId、topicVersionId）。title 是卡的标题，或「专题标题 · 第 N 版」。
 * git：卡在工作树里做时，验收通过的那次交回的分支、提交和验的提交；专题和在文件夹里做的卡为 null。
 */
export const PendingDeliverableItem = Type.Object({
  id: Type.String({ format: "uuid" }),
  kind: Type.Union([Type.Literal("card"), Type.Literal("topic")]),
  title: Type.String({ minLength: 1 }),
  cardId: Nullable(Type.String({ minLength: 1 })),
  topicId: Nullable(Type.String({ format: "uuid" })),
  topicVersionId: Nullable(Type.String({ format: "uuid" })),
  addedAt: Instant,
  git: Nullable(CardGit),
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
    doneDefinition: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
    executor: Type.Optional(CardExecutor),
    roleId: Type.Optional(Nullable(Type.String({ format: "uuid" }))),
  }, strict), { minItems: 1, maxItems: 8 }),
  /**
   * 新首页第 4.4 节：Task 管线里定了计划（派活单上选了「就按这个开始」）。true 时交给 Agent 做的卡（执行方 claude_code）放进看板的同时登记要开工，
   * 不用再点开工：配对的电脑上开着的网页认领后交给本机程序（POST /api/me/session-starts/claim），手机上确认的排着「等本机上线」。不带或 false 照旧只放进看板。
   */
  start: Type.Optional(Type.Boolean()),
  /** 开工框上方选的预算（设计 11.3）：带了就存成这件 Task 的预算（同 PUT /api/me/tasks/:taskId/budget）；不带不动。 */
  budget: Type.Optional(Budget),
  /** 本人在项目对话里看到的最后一条消息的 sequence（17.2 第 29 条），存成派活单的 startedAfterSequence；不带时云端读那条对话现在最后一条。 */
  afterSequence: Type.Optional(Type.Integer({ minimum: 1 })),
}, strict);
export const AcceptCardDraftsResponse = Type.Object({ cards: Type.Array(CardTaskView) }, strict);

/**
 * 一条完成标准（主循环第 60 条）：卡上存成 doneDefinition 一行一条，这里按条给。限制见 DONE_DEFINITION_LIMITS：每条不超过 300 字，整份不超过 2000 字。
 */
export const CardStandard = Type.String({ minLength: 1, maxLength: 300, pattern: "^[^\\r\\n]+$" });

/**
 * 改卡上卡的那几样（只有推进人）：执行方、岗位（本人没归档的岗位，null 不配）、模型、交代、对哪条标准。标题照旧用 PATCH /api/me/tasks/:id。
 * version 不一致 409 VERSION_CONFLICT（带 latestTask）。除 version、reason 外至少带一个字段。
 * 卡的约定（主循环第 60 条，交代 + 完成标准，依据只有云端卡上这一份）：本人在子会话的会话详情里改，网页带 brief、standards（整份新的，按顺序）、reason（可选，一句话）。
 * - 交代或完成标准真的变了，存了就生效：约定的版本号加 1，记一条修改记录（by person，见 CardAgreementChange）。和原来一样的不记。
 * - 这张卡有本机会话时，云端顺手登记一条转话（SessionCommand message，带 agreementRevision），那台电脑上开着的网页认领后把新的完成标准全文说给执行方。
 * - 交回时本机还会向云端取最新的约定（LocalCardAgreementResponse）再核一遍，所以网页没开着也不会对着旧标准交回。
 * 老路 PATCH /api/me/tasks/:id 改 doneDefinition 照旧能用，同样记修改记录、登记转话。
 */
export const PatchCardRequest = Type.Object({
  version: Type.Integer({ minimum: 1 }),
  executor: Type.Optional(CardExecutor),
  roleId: Type.Optional(Nullable(Type.String({ format: "uuid" }))),
  model: Type.Optional(Nullable(CardModel)),
  brief: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 4000 }))),
  criterionIndex: Type.Optional(NullableInteger({ minimum: 1 })),
  standards: Type.Optional(Type.Array(CardStandard, { minItems: 1, maxItems: 20 })),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
}, strict);

/** 卡的约定在某一刻的样子：交代（没写为 null）和完成标准（按条）。 */
export const CardAgreement = Type.Object({
  brief: Nullable(Type.String()),
  standards: Type.Array(Type.String()),
}, strict);

/**
 * 约定的一次修改（主循环第 60 条）。revision 是改完以后的版本号（卡建出来是 1）；at 什么时候；
 * by.kind：person 本人直接改的；pipeline 项目管线用 update_card 改的；worker 执行方提议（propose_agreement_change）、本人点了「改成这样」的。
 * by.name 给人看（本人的名字、「管线」、执行方的名字），读不到为 null。
 * before、after 是改前改后（只列不比对）；reason 是原因（管线、执行方必有，本人没写为 null）。
 */
export const CardAgreementChange = Type.Object({
  id: Type.String({ format: "uuid" }),
  revision: Type.Integer({ minimum: 2 }),
  at: Instant,
  by: Type.Object({ kind: Type.Union([Type.Literal("person"), Type.Literal("pipeline"), Type.Literal("worker")]), name: Nullable(Type.String()) }, strict),
  before: CardAgreement,
  after: CardAgreement,
  reason: Nullable(Type.String()),
}, strict);
/** GET /api/me/cards/:id/agreement-changes（只有推进人）：这张卡约定的修改记录，新的在前。没改过为空数组。 */
export const CardAgreementChangeListResponse = Type.Object({ changes: Type.Array(CardAgreementChange) }, strict);

/**
 * 执行方提的改约定（主循环第 60 条，本机同步条目 agreement_proposal，见 LocalAgreementProposal）。不直接生效：在子会话里钉一个框，本人选「改成这样（推荐）」「不改」。
 * standards 是提议的完成标准全文；brief 是提议的新交代（不改交代为 null）；reason 是执行方写的原因；at 是本机报上来的时间。
 * 同一张卡同时只有一个在等：新的到了，旧的作废（不再列）。
 */
export const CardAgreementProposalView = Type.Object({
  id: Type.String({ format: "uuid" }),
  standards: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  brief: Nullable(Type.String()),
  reason: Type.String({ minLength: 1 }),
  at: Instant,
}, strict);

/**
 * 卡的约定的现状（CardDetailResponse.agreement）：revision 现在是第几版（没改过是 1）；changes 改过几次（会话详情「约定改过 N 次」，0 不画）；
 * proposal 是执行方提的、在等本人定的那一个（见 CardAgreementProposalView），没有为 null。
 */
export const CardAgreementView = Type.Object({
  revision: Type.Integer({ minimum: 1 }),
  changes: Type.Integer({ minimum: 0 }),
  proposal: Nullable(CardAgreementProposalView),
}, strict);

/**
 * POST /api/me/cards/:id/agreement-proposals/:proposalId/decision（只有推进人，手机上也能，回卡的详情）：本人对执行方提的改约定拍板。
 * accept「改成这样」：照提议改卡的约定（记一条修改记录，by worker，原因是执行方写的），登记一条转话告诉执行方约定改了、附新的完成标准全文；
 * reject「不改」：约定不动，登记一条转话告诉执行方本人不改约定、照原来的做。
 * 已经定过、已经作废的 409 PROPOSAL_CLOSED；没有的 404。
 */
export const DecideAgreementProposalRequest = Type.Object({ decision: Type.Union([Type.Literal("accept"), Type.Literal("reject")]) }, strict);

/**
 * Agent 验收里的一条：对照卡的第几条完成标准（从 1 起）、判定、理由、依据、怎么补。
 * verdict 多一种 needs_person（见 CardCriterionVerdict）；fixBy 是没达到时谁来补（见 CardFixBy），met 的、老结论为 null 或不带。
 */
export const CardAcceptanceCriterion = Type.Object({
  index: Type.Integer({ minimum: 1 }),
  text: Type.String({ minLength: 1 }),
  verdict: CardCriterionVerdict,
  reason: Type.String(),
  evidence: Nullable(Type.String()),
  fix: Nullable(Type.String()),
  fixBy: Type.Optional(Nullable(CardFixBy)),
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
  /** 谁验的（第 21 节）：local 是本人电脑上的验收员（同步条目 verdict），cloud 是云端验收作业；记模型和验收员岗位的版本。还没结论时为 null。 */
  verifier: Nullable(Type.Object({
    source: Type.Union([Type.Literal("cloud"), Type.Literal("local")]),
    modelLabel: Nullable(Type.String()),
    roleId: Nullable(Type.String({ format: "uuid" })),
    roleVersion: NullableInteger({ minimum: 1 }),
  }, strict)),
}, strict);

/**
 * GET /api/me/cards/:id：卡的详情（只有推进人）。standards 是完成标准按行拆开；runs 是最近 5 次本机执行（新的在前）；
 * handbacks 是各次交回和验收（新的在前）；outputs 是本机传上来的产出和证据（新的在前）。
 */
export const CardDetailResponse = Type.Object({
  task: CardTaskView,
  /** 卡在所属项目里的字母（18 节第 10 条，同 SubSession.letter，页头写在标题前）；不在项目里为 null。 */
  letter: Nullable(Type.String({ pattern: "^[A-Z]{1,3}$" })),
  brief: Nullable(Type.String()),
  standards: Type.Array(Type.String()),
  runs: Type.Array(LocalRunView, { maxItems: 5 }),
  handbacks: Type.Array(CardHandbackView),
  outputs: Type.Array(LocalOutputView),
  /** 卡的约定的现状（主循环第 60 条，见 CardAgreementView）。云端都带；可选只为兼容。 */
  agreement: Type.Optional(CardAgreementView),
}, strict);

/**
 * GET /api/me/cards/:id/brief：开工时交给本机的交代。markdown 原样作为本机会话的第一句话（≤ 20000 字）：
 * Mission、Task、对的那条标准和约定里它「用什么证明」、Task 的「这次不包括」、卡的交代和完成标准、Task 最新一版评审里这条还差什么、上一次验收没过的改法。
 * role 是卡的岗位（职责、做法、验收口径、工具、模型档位、版本），本机开工时按它注入；没配岗位为 null。
 * 工作规矩（怎么交回、产出写在哪）在本机程序的提示词里，这里不重复。
 * sourceWords（16.8）：卡上的本人原话；不为空时 markdown 最前面（目标和完成标准之前）有一段「本人原话」。
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
  sourceWords: SourceWords,
}, strict);

/**
 * 推翻 Agent 验收（只有推进人）：通过的推翻后卡回进行中、从准备中拿掉（已经进了某一版的不能推翻，409）；
 * 没过的、等本人补的推翻就是「就到这里」（主循环第 62 条，替换原来的「仍然通过」，所有设备一样）：reason 是本人写的一句原因
 * （网页预填没达到那几条的短标题 CardGapItem.short），卡完成、进准备中，记成有缺口通过（CardHandbackBrief.passedWithGap），验收记录写本人和原因。
 */
export const OverruleCardHandbackRequest = Type.Object({ reason: Type.String({ minLength: 1, maxLength: 200 }) }, strict);

/**
 * POST /api/me/cards/:id/handbacks/:handbackId/relay（只有推进人；手机上、别的电脑上也能，回卡的详情）：登记「再改一轮」「我来补」，见 CardRelayView。
 * - return 再改一轮：只对最近一次交回、结论 fail（受阻或没过）、改法还没送到的；送的是这次交回的 returnText。
 * - supply 我来补：只对最近一次交回、结论 needs_person 的；text 是本人写的（每条要补的一段）。
 * 这张卡没有本机会话 409 NOT_STARTED；条件不对 409 NOTHING_TO_RELAY；这次交回已经有一条 pending 的 409 RELAY_PENDING。
 * 在跑这个会话的那台电脑上也走这条：登记完马上认领（POST /api/me/session-commands/claim）就送出去了，送达照样回写。
 * 送到以后：return 记 returnedAt（同 /returned），卡不再是 blocked、review_failed；supply 卡不再是 needs_person，执行方接着做、再交回。
 */
export const CardRelayRequest = Type.Union([
  Type.Object({ kind: Type.Literal("return") }, strict),
  Type.Object({ kind: Type.Literal("supply"), text: Type.String({ minLength: 1, maxLength: 3000 }) }, strict),
]);

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
export type TCardAgreement = Static<typeof CardAgreement>;
export type TCardAgreementChange = Static<typeof CardAgreementChange>;
export type TCardAgreementChangeListResponse = Static<typeof CardAgreementChangeListResponse>;
export type TCardAgreementProposalView = Static<typeof CardAgreementProposalView>;
export type TCardAgreementView = Static<typeof CardAgreementView>;
export type TDecideAgreementProposalRequest = Static<typeof DecideAgreementProposalRequest>;
export type TCardRelayRequest = Static<typeof CardRelayRequest>;
export type TCardAcceptanceCriterion = Static<typeof CardAcceptanceCriterion>;
export type TCardOverrule = Static<typeof CardOverrule>;
export type TCardHandbackView = Static<typeof CardHandbackView>;
export type TCardDetailResponse = Static<typeof CardDetailResponse>;
export type TCardBriefResponse = Static<typeof CardBriefResponse>;
export type TOverruleCardHandbackRequest = Static<typeof OverruleCardHandbackRequest>;
export type TAddPendingDeliverableRequest = Static<typeof AddPendingDeliverableRequest>;
export type TCreateVersionFromPendingRequest = Static<typeof CreateVersionFromPendingRequest>;
