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
 * review_failed 验收未过（改法还没送到执行方）、blocked 受阻（连续两次验收没过，或本机连着两次异常退出）。
 * 前四种算「待处理」。同时有几种时只给一种，次序：blocked、review_failed、approval、reply、paused。
 */
export const CardWait = Type.Union([
  Type.Literal("approval"), Type.Literal("reply"), Type.Literal("paused"), Type.Literal("review_failed"), Type.Literal("blocked"),
]);

/** 对的是本体 Task 的第几条标准（从 1 起，和评审编号一致）和那条当时的原文；卡对「其他」时整项为 null。 */
export const CardCriterion = Type.Object({
  index: Type.Integer({ minimum: 1 }),
  text: Type.String({ minLength: 1 }),
}, strict);

/** 交回的 Agent 验收走到哪：queued、running、done（有结论）、failed（验收本身出错，可重试）。 */
export const CardHandbackStatus = Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("done"), Type.Literal("failed")]);

/**
 * 最近一次交回的摘要。outcome：pass 通过、fail 没过，没出结论为 null；met / total 是几条达到。
 * returnText 是没过时发回执行方的那段话（固定格式），returnedAt 是网页已经把它送到本机的时间。
 * overruled：本人推翻过这次验收。
 */
export const CardHandbackBrief = Type.Object({
  id: Type.String({ format: "uuid" }),
  attempt: Type.Integer({ minimum: 1 }),
  status: CardHandbackStatus,
  outcome: Nullable(Type.Union([Type.Literal("pass"), Type.Literal("fail")])),
  met: Type.Integer({ minimum: 0 }),
  total: Type.Integer({ minimum: 0 }),
  headline: Nullable(Type.String()),
  returnText: Nullable(Type.String()),
  returnedAt: Nullable(Instant),
  overruled: Type.Boolean(),
  createdAt: Instant,
  finishedAt: Nullable(Instant),
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
}, strict);

export type TCardExecutor = Static<typeof CardExecutor>;
export type TCardModel = Static<typeof CardModel>;
export type TCardStage = Static<typeof CardStage>;
export type TCardWait = Static<typeof CardWait>;
export type TCardCriterion = Static<typeof CardCriterion>;
export type TCardHandbackStatus = Static<typeof CardHandbackStatus>;
export type TCardHandbackBrief = Static<typeof CardHandbackBrief>;
export type TDeliverableInclusion = Static<typeof DeliverableInclusion>;
export type TTaskCard = Static<typeof TaskCard>;
