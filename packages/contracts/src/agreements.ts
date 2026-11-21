import { Type, type Static } from "@sinclair/typebox";
import { DeliverableItem, DeliverableReview, ReviewBasis } from "./deliverables.js";

/**
 * 约定与对表（V1 设计 v0.2）：本体 Task 的每条验收标准写清「用什么证明、谁来认」，再加「这次不包括什么」。
 * 约定先读本体（12 月起 Task 的 definition 块带 proof / acceptor / exclusions），没有再读天枢 11 月的补充，两样都没有就只有标准原文。
 * 对表不调模型：把约定和最新一版交付物的参考评审摆在一起看，结论只有两种（还不能交 / 可以交），不卡交付。
 */

/** 约定里的一个人（谁来认、谁改的）。 */
export const AgreementPerson = Type.Object({
  personId: Type.String({ minLength: 1 }),
  name: Type.String(),
}, { additionalProperties: false });

/** 约定从哪来：world 本体，tianshu 天枢 11 月的补充，none 两样都没有（只有标准原文）。 */
export const AgreementSource = Type.Union([Type.Literal("world"), Type.Literal("tianshu"), Type.Literal("none")]);

/** 一条标准的约定：text 是本体当前的标准原文（index 从 1 起）；proof 是用什么证明，没写为 null；acceptor 是谁来认，null 表示有对表的证据就算数。 */
export const AgreementCriterion = Type.Object({
  index: Type.Integer({ minimum: 1 }),
  text: Type.String({ minLength: 1 }),
  proof: Type.Union([Type.String(), Type.Null()]),
  acceptor: Type.Union([AgreementPerson, Type.Null()]),
}, { additionalProperties: false });

/**
 * 一个 Task 的约定。basis 是标准从哪来（acceptance 本体验收标准；definition 没有验收标准时按完成定义，算一条；none 两样都没有，criteria 为空）。
 * complete：有标准、每条都写了「用什么证明」（谁来认可以空）。basisChanged：天枢补充写下以后本体里的标准改过。
 * canEdit：本人能不能存 11 月的补充（负责人、Mission 负责人能；约定来自本体或没有标准时为 false）。
 * updatedBy / updatedAt：天枢补充最后一次是谁、什么时候改的；不是天枢补充时为 null。
 */
export const TaskAgreementResponse = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  taskName: Type.String(),
  missionId: Type.String({ minLength: 1 }),
  basis: ReviewBasis,
  source: AgreementSource,
  criteria: Type.Array(AgreementCriterion),
  exclusions: Type.Array(Type.String()),
  complete: Type.Boolean(),
  basisChanged: Type.Boolean(),
  canEdit: Type.Boolean(),
  updatedBy: Type.Union([AgreementPerson, Type.Null()]),
  updatedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  /** 延续来的约定草稿：从哪件 Task 复制来的（跨月延续，taskContinuity.ts）；本人存一次就成了正式的、回到 null。不是草稿为 null。 */
  draftFrom: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
}, { additionalProperties: false });

/**
 * 存 11 月的补充（整份覆盖，留修改记录）：criteria 按当前标准的序号写用什么证明、谁来认（acceptorId 是 personId，可以空）；
 * 没写到的序号算没写。exclusions 是这次不包括什么，每行一条。
 */
export const PutTaskAgreementRequest = Type.Object({
  criteria: Type.Array(Type.Object({
    index: Type.Integer({ minimum: 1 }),
    proof: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
    acceptorId: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
  }, { additionalProperties: false }), { maxItems: 50 }),
  exclusions: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 20 }),
}, { additionalProperties: false });

/** 对表时每一条的结果：evidenced 有证据；gap 差；reviewing 评审中；no_deliverable 还没交付物；needs_acceptor 有证据，但约定写了由别人认。 */
export const CheckCriterionStatus = Type.Union([
  Type.Literal("evidenced"), Type.Literal("gap"), Type.Literal("reviewing"), Type.Literal("no_deliverable"), Type.Literal("needs_acceptor"),
]);

/** 有证据时带出来的：第几版、哪份材料（评审定位里点到名字的；这一版只有一样时就是它）、评审给的定位。 */
export const CheckEvidence = Type.Object({
  versionId: Type.String({ format: "uuid" }),
  versionNumber: Type.Integer({ minimum: 1 }),
  items: Type.Array(Type.Object({
    id: DeliverableItem.properties.id,
    kind: DeliverableItem.properties.kind,
    name: DeliverableItem.properties.name,
    url: DeliverableItem.properties.url,
  }, { additionalProperties: false })),
  locator: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });

/**
 * 对表里的一条：status 见 CheckCriterionStatus；evidence 只在 evidenced / needs_acceptor 时有；gap 是差什么（评审的 fix），只在 gap 时有。
 * notifiedToday：今天已经请认可人看过这一条（「请 X 看」同一条一天一次）。
 */
export const TaskCheckCriterion = Type.Object({
  index: Type.Integer({ minimum: 1 }),
  text: Type.String({ minLength: 1 }),
  status: CheckCriterionStatus,
  proof: Type.Union([Type.String(), Type.Null()]),
  acceptor: Type.Union([AgreementPerson, Type.Null()]),
  evidence: Type.Union([CheckEvidence, Type.Null()]),
  gap: Type.Union([Type.String(), Type.Null()]),
  notifiedToday: Type.Boolean(),
}, { additionalProperties: false });

/** 结论前面的提示：basis_changed 标准改过；agreement_incomplete 约定还没补全。text 是给人看的一句话（网页和 MCP 同一句）。 */
export const CheckNotice = Type.Object({
  code: Type.Union([Type.Literal("basis_changed"), Type.Literal("agreement_incomplete")]),
  text: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

/**
 * 对表结果（不调模型，秒回）。verdict 只有两种：ready（约定的每条都有证据，含要别人确认的）或 not_ready；conclusion 是顶上那一句。
 * notices 放在结论前面；version 是对的哪一版（最新一版，一版都没交时为 null）；
 * beyondScope 是参考评审给的「下次可以做」（约定外的建议），单独附在后面，不进结论。canNotify：本人能不能点「请 X 看」（负责人）。
 */
export const TaskCheckResponse = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  verdict: Type.Union([Type.Literal("ready"), Type.Literal("not_ready")]),
  conclusion: Type.String({ minLength: 1 }),
  notices: Type.Array(CheckNotice),
  source: AgreementSource,
  criteria: Type.Array(TaskCheckCriterion),
  version: Type.Union([Type.Object({
    id: Type.String({ format: "uuid" }),
    number: Type.Integer({ minimum: 1 }),
    reviewStatus: DeliverableReview.properties.status,
    deliveredAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  }, { additionalProperties: false }), Type.Null()]),
  beyondScope: Type.Array(Type.String()),
  canNotify: Type.Boolean(),
}, { additionalProperties: false });

/** 「请 X 看」：给第 index 条约定的认可人（personId 要和约定里的一致）推一条飞书私聊。 */
export const CheckNotifyRequest = Type.Object({
  index: Type.Integer({ minimum: 1 }),
  personId: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

/** sent：这次推了；already_sent：今天已经推过这一条，这次没再推。 */
export const CheckNotifyResponse = Type.Object({
  status: Type.Union([Type.Literal("sent"), Type.Literal("already_sent")]),
}, { additionalProperties: false });

export type TAgreementPerson = Static<typeof AgreementPerson>;
export type TAgreementSource = Static<typeof AgreementSource>;
export type TAgreementCriterion = Static<typeof AgreementCriterion>;
export type TTaskAgreementResponse = Static<typeof TaskAgreementResponse>;
export type TPutTaskAgreementRequest = Static<typeof PutTaskAgreementRequest>;
export type TCheckCriterionStatus = Static<typeof CheckCriterionStatus>;
export type TCheckEvidence = Static<typeof CheckEvidence>;
export type TTaskCheckCriterion = Static<typeof TaskCheckCriterion>;
export type TCheckNotice = Static<typeof CheckNotice>;
export type TTaskCheckResponse = Static<typeof TaskCheckResponse>;
export type TCheckNotifyRequest = Static<typeof CheckNotifyRequest>;
export type TCheckNotifyResponse = Static<typeof CheckNotifyResponse>;
