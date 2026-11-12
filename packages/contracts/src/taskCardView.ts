import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { LocalRunBrief } from "./localDevices.js";
import { RoleRef } from "./roles.js";

/**
 * 看板上的卡（V2 设计第 3 节）：卡就是执行事项，这里是它身上「卡」的那部分（TaskView.card）。
 * 这个文件不引用 tasks.ts，免得 TaskView 以后挂上 card 时循环引用。
 */

const strict = { additionalProperties: false } as const;
const Instant = Type.String({ format: "date-time" });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** 执行方：claude_code 在本机由 Claude Code 干、交回后 Agent 验收；self 本人自己做，照现有规则本人验收。 */
export const CardExecutor = Type.Union([Type.Literal("claude_code"), Type.Literal("self")]);

/**
 * 卡选的模型，只存名字不存钥匙。id 是本机模型配置的 id（本机 GET /v1/models 的 LocalModelProfile.id），
 * kind 照本机的 source：subscription 是本人订阅，gateway 是 TokenHub 等网关。
 */
export const CardModel = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9_-]+$" }),
  label: Type.String({ minLength: 1, maxLength: 40 }),
  kind: Type.Union([Type.Literal("subscription"), Type.Literal("gateway")]),
}, strict);

/**
 * 看板四列，由 api 算好：todo 待开始（not_started）、doing 进行中、review 验收中（最近一次交回在排队或验收中）、done 已完成。
 * 会后分派被退回（returned）的事项不上看板。
 */
export const CardStage = Type.Union([Type.Literal("todo"), Type.Literal("doing"), Type.Literal("review"), Type.Literal("done")]);

/**
 * 卡身上的标记，不成列，卡留在原来那一列（都在进行中）、排在格子最上面：
 * approval 等你批准（本机有权限请求没答）、reply 等你回复（一轮结束等人说话）、paused 已暂停（停下了）、
 * review_failed 验收未过（改法还没送到执行方）、blocked 受阻（连续两次验收没过，或本机连着两次异常退出）、
 * needs_person 等你补（主循环第 61 条：最近一次交回的结论是 needs_person，本人还没「我来补」送到、也没「就到这里」）。
 * needs_person 不自动送回执行方（老网页的自动送回只认 review_failed，碰不到它）。「再改一轮」送到以后（returnedAt 有值）不再是 blocked。
 * 前四种算「待处理」。同时有几种时只给一种，次序：needs_person、blocked、review_failed、approval、reply、paused。
 */
export const CardWait = Type.Union([
  Type.Literal("approval"), Type.Literal("reply"), Type.Literal("paused"), Type.Literal("review_failed"), Type.Literal("blocked"), Type.Literal("needs_person"),
]);

/**
 * 卡的验收对一条完成标准的判定（主循环第 61 条）：met 达到、partial 部分、unmet 没达到，同交付物评审的 CriterionVerdict；
 * 多一种 needs_person 要本人补：执行方标了「要本人补」、而且确实只有本人能做（要登录、验证码、人工查询、网站拦自动访问、要本人的权限或判断）。
 * 执行方其实能做的，验收员照旧判 unmet。交付物评审那边不用这个值。
 */
export const CardCriterionVerdict = Type.Union([Type.Literal("met"), Type.Literal("partial"), Type.Literal("unmet"), Type.Literal("needs_person")]);

/** 没达到的那条该谁补（主循环第 61 条）：worker 执行方能补，person 要本人补。needs_person 的一定是 person。 */
export const CardFixBy = Type.Union([Type.Literal("worker"), Type.Literal("person")]);

/**
 * 一次交回的结论（主循环第 61 条）：pass 通过、fail 没过、needs_person 等本人补。云端按验收员逐条的判定算，不看本机的 passed：
 * - 每条都 met、没有和本人原话对不上的 → pass；
 * - 否则，有一条 needs_person 或 fixBy = person → needs_person（第一次验收就是这样也直接进「等你补」，不再白跑第二轮）；
 * - 其余 → fail。
 * needs_person 不算没过：不计入连续没过的次数（failStreak 数的时候跳过它，也不打断前后的连续），不自动送回。
 */
export const CardHandbackOutcome = Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("needs_person")]);

/**
 * 交回里没达到的一条（主循环第 61、62 条，等你补和受阻两个框逐条列的就是它）：index 第几条完成标准（从 1 起）；
 * short 是这条的短标题（云端从标准原文截：到第一个逗号、句号或 20 字为止，「就到这里」「我来补」预填用）；verdict 是验收员的判定（不会是 met）；
 * fixBy 谁来补（老结论没写的按 worker）；fix 是验收员写的改法——fixBy = person 的就是要本人做什么、给回什么（执行方交回时写的 need 也在这里，验收员没写时用它）。
 */
export const CardGapItem = Type.Object({
  index: Type.Integer({ minimum: 1 }),
  short: Type.String({ minLength: 1, maxLength: 40 }),
  verdict: CardCriterionVerdict,
  fixBy: CardFixBy,
  fix: Nullable(Type.String()),
}, strict);

/**
 * 从手机或别的电脑登记的「再改一轮」「我来补」（主循环第 61、62 条，POST /api/me/cards/:id/handbacks/:handbackId/relay）。
 * 走现有的转话那条路：云端记一条 SessionCommand（message），这张卡会话所在那台电脑上开着的网页认领后说给执行方，报 done 后云端回写这里。
 * kind：return 再改一轮（送的是 returnText），supply 我来补（送的是本人写的，后面附上执行方能补的那几条改法）。
 * state：pending 等那台电脑上线（框上写「电脑在线后送到」「电脑在线后执行」）；delivered 送到了（doneAt）；failed 没送成（message 写本机回的原因，可以再登记一次）。
 * text 是要送给执行方的原文。
 */
export const CardRelayView = Type.Object({
  id: Type.String({ format: "uuid" }),
  kind: Type.Union([Type.Literal("return"), Type.Literal("supply")]),
  state: Type.Union([Type.Literal("pending"), Type.Literal("delivered"), Type.Literal("failed")]),
  text: Type.String({ minLength: 1 }),
  requestedAt: Instant,
  doneAt: Nullable(Instant),
  message: Nullable(Type.String()),
}, strict);

/** 有缺口通过（主循环第 62 条「就到这里」）：没过或等本人补的那次交回，本人写了原因算通过。reason 是本人写的原因，at 是什么时候。 */
export const CardGapPass = Type.Object({ reason: Type.String({ minLength: 1 }), at: Instant }, strict);

/** 对的是本体 Task 的第几条标准（从 1 起，和评审编号一致）和那条当时的原文；卡对「其他」时整项为 null。 */
export const CardCriterion = Type.Object({
  index: Type.Integer({ minimum: 1 }),
  text: Type.String({ minLength: 1 }),
}, strict);

/** 交回的 Agent 验收走到哪：queued、running、done（有结论）、failed（验收本身出错，可重试）。 */
export const CardHandbackStatus = Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("done"), Type.Literal("failed")]);

/**
 * 卡在自己的 git 工作树里做时（ADR 0038），这次交回在哪个分支、哪个提交：branch 从 baseBranch 的 baseCommit 开出来，commit 是交回那一刻分支上的提交；
 * verifiedCommit 是本机验收员验的那个提交（还没验、或云端验的为 null）。合回主文件夹是本机的事，云端不记。
 */
export const CardGit = Type.Object({
  branch: Type.String(),
  baseBranch: Type.String(),
  baseCommit: Type.String(),
  commit: Type.String(),
  verifiedCommit: Nullable(Type.String()),
}, strict);

/**
 * 最近一次交回的摘要。outcome：pass 通过、fail 没过，没出结论为 null；met / total 是几条达到。
 * git：卡在工作树里做时交回的分支和提交、验的提交；在文件夹里做的为 null。
 * returnText 是没过时发回执行方的那段话（固定格式），returnedAt 是网页已经把它送到本机的时间。
 * overruled：本人推翻过这次验收。
 */
/**
 * 产出和本人原话对不上的一处（16.8，本机验收员报的 LocalSourceWordIssue）：quote 原话里的哪一句，kind：missing 漏了原话里明说的、extra 做了原话里没要的；reason 为什么。
 * 有一处这次交回就算没过，标准全达到也一样。
 */
export const CardSourceWordIssue = Type.Object({
  quote: Type.String({ minLength: 1 }),
  kind: Type.Union([Type.Literal("missing"), Type.Literal("extra")]),
  reason: Type.String({ minLength: 1 }),
}, strict);

/**
 * sourceWordIssues：这次交回和本人原话对不上的几处（见 CardSourceWordIssue），和没过的标准一起列；没有、还没验、老的交回为空数组。
 * outcome 见 CardHandbackOutcome（needs_person 是主循环第 61 条加的）。headline 是验收员那一句人话（卡在哪、要谁做什么），等你补和受阻的框第一行写它。
 * 下面三样是主循环第 61、62 条加的，云端都带；标成可选只为老数据：
 * - gaps：没达到的几条（见 CardGapItem，按 index 排）；通过的、还没结论的为空数组。
 * - relay：这次交回最近一次从手机或别的电脑登记的「再改一轮」「我来补」（见 CardRelayView）；没登记过为 null。
 * - passedWithGap：本人「就到这里」了（没过或等本人补的那次被推翻成通过；或本人推翻过的通过又「就到这里」），见 CardGapPass；没有为 null。
 * overruleReason：本人推翻这次验收时写的原因（overruled 为 true 时有，否则 null；老的云端不带）。这次是通过被本人推翻成没过、因此受阻的，
 * 受阻框第一行写它，不写 headline（headline 是验收员判通过时那一句）。
 */
export const CardHandbackBrief = Type.Object({
  id: Type.String({ format: "uuid" }),
  attempt: Type.Integer({ minimum: 1 }),
  status: CardHandbackStatus,
  outcome: Nullable(CardHandbackOutcome),
  met: Type.Integer({ minimum: 0 }),
  total: Type.Integer({ minimum: 0 }),
  headline: Nullable(Type.String()),
  returnText: Nullable(Type.String()),
  returnedAt: Nullable(Instant),
  overruled: Type.Boolean(),
  createdAt: Instant,
  finishedAt: Nullable(Instant),
  git: Nullable(CardGit),
  sourceWordIssues: Type.Array(CardSourceWordIssue),
  gaps: Type.Optional(Type.Array(CardGapItem, { maxItems: 50 })),
  relay: Type.Optional(Nullable(CardRelayView)),
  passedWithGap: Type.Optional(Nullable(CardGapPass)),
  overruleReason: Type.Optional(Nullable(Type.String())),
}, strict);

/**
 * 进交付物到哪了：pending 在下一版的「准备中」，versionNumber 是下一版的号；included 已纳入第 versionNumber 版。
 * 没进交付物为 null。卡和专题的一版都用它。
 */
export const DeliverableInclusion = Type.Object({
  state: Type.Union([Type.Literal("pending"), Type.Literal("included")]),
  versionNumber: Type.Integer({ minimum: 1 }),
}, strict);

/**
 * TaskView.card：卡的那部分。role 是这张卡的岗位（卡上显示岗位名，不再显示执行方）；没配岗位为 null。
 * executor 为 null 是没设执行方的老事项（照旧本人做、本人验收）。
 * run 是最近一次本机执行的摘要（卡在别的电脑上跑时，网页据 run.deviceId 标那台电脑、不给操作按钮）。
 * after 是这张卡要等的卡（执行事项 id，派活单上规划员写的先后，只算交给 Agent 做的卡，本人自己做的不等）：开工时原样作为本机程序开工请求的 after，本机等它们合回再开始；不用等为空。
 * sourceWords 是本人原话（16.8，从派活单带过来；不是从派活单建的卡为空数组）。网页画在完成标准上面，为空不画。
 */
export const TaskCard = Type.Object({
  stage: CardStage,
  wait: Nullable(CardWait),
  role: Nullable(RoleRef),
  executor: Nullable(CardExecutor),
  model: Nullable(CardModel),
  criterion: Nullable(CardCriterion),
  run: Nullable(LocalRunBrief),
  handback: Nullable(CardHandbackBrief),
  deliverable: Nullable(DeliverableInclusion),
  after: Type.Array(Type.String({ format: "uuid" })),
  sourceWords: Type.Array(Type.String(), { maxItems: 10 }),
}, strict);

export type TCardExecutor = Static<typeof CardExecutor>;
export type TCardModel = Static<typeof CardModel>;
export type TCardStage = Static<typeof CardStage>;
export type TCardWait = Static<typeof CardWait>;
export type TCardCriterion = Static<typeof CardCriterion>;
export type TCardHandbackStatus = Static<typeof CardHandbackStatus>;
export type TCardHandbackBrief = Static<typeof CardHandbackBrief>;
export type TCardCriterionVerdict = Static<typeof CardCriterionVerdict>;
export type TCardFixBy = Static<typeof CardFixBy>;
export type TCardHandbackOutcome = Static<typeof CardHandbackOutcome>;
export type TCardGapItem = Static<typeof CardGapItem>;
export type TCardRelayView = Static<typeof CardRelayView>;
export type TCardGapPass = Static<typeof CardGapPass>;
export type TCardSourceWordIssue = Static<typeof CardSourceWordIssue>;
export type TCardGit = Static<typeof CardGit>;
export type TDeliverableInclusion = Static<typeof DeliverableInclusion>;
export type TTaskCard = Static<typeof TaskCard>;
