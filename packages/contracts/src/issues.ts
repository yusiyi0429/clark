import { Type, type Static } from "@sinclair/typebox";

export const IssueLocation = Type.Union([
  Type.Object({
    level: Type.Literal("company"),
    relatedBattlefieldIds: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 20, uniqueItems: true }),
  }, { additionalProperties: false }),
  Type.Object({
    level: Type.Literal("battlefield"),
    battlefieldId: Type.String({ minLength: 1, maxLength: 100 }),
  }, { additionalProperties: false }),
  Type.Object({
    level: Type.Literal("capability"),
    capabilityId: Type.String({ minLength: 1, maxLength: 100 }),
  }, { additionalProperties: false }),
]);

export const IssueUrgencyLevel = Type.Union([
  Type.Literal("red"),
  Type.Literal("yellow"),
  Type.Literal("gray"),
]);

export const DriIssueImportRequest = Type.Object({
  externalId: Type.String({ minLength: 1, maxLength: 200 }),
  submitterPersonId: Type.String({ minLength: 1, maxLength: 200 }),
  title: Type.String({ minLength: 1, maxLength: 500 }),
  whyNow: Type.String({ minLength: 1, maxLength: 2000 }),
  sourceRef: Type.String({ minLength: 1, maxLength: 2000 }),
  location: IssueLocation,
  urgency: Type.Optional(Type.Object({
    level: IssueUrgencyLevel,
    /** 时间窗口由代码解析校验（Date.parse），schema 只约束形状。 */
    decisionBy: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export const ResearchStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("running"),
  Type.Literal("ready"),
  Type.Literal("failed"),
]);

/** 唯一预研深度：判断、选择、后果、证据、未知和来源只存在 ResearchDoc。 */
export const ResearchDocOption = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 100 }),
  label: Type.String({ minLength: 1, maxLength: 500 }),
  consequences: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 10 }),
}, { additionalProperties: false });

export const ResearchDocEvidence = Type.Object({
  quote: Type.String({ minLength: 1, maxLength: 2000 }),
  sourceTitle: Type.String({ minLength: 1, maxLength: 500 }),
  sourceUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
}, { additionalProperties: false });

export const ResearchDocSource = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 500 }),
  url: Type.String({ minLength: 1, maxLength: 2000 }),
}, { additionalProperties: false });

/** 严格 candidate schema：Agent 只能通过 submit_candidate 提交这一整份结构。 */
export const ResearchDoc = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 2000 }),
  options: Type.Array(ResearchDocOption, { minItems: 2, maxItems: 4 }),
  evidence: Type.Array(ResearchDocEvidence, { maxItems: 10 }),
  unknowns: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 10 }),
  sources: Type.Array(ResearchDocSource, { maxItems: 10 }),
}, { additionalProperties: false });

export const IssueDecideInput = Type.Object({
  decisionText: Type.String({ minLength: 1, maxLength: 5000 }),
  optionId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
}, { additionalProperties: false });

/** `confirmOverride: true` 是 Research Override 的服务端二次确认；预研未完成时没有建议选项可选。 */
export const IssueDecideOverrideInput = Type.Object({
  decisionText: Type.String({ minLength: 1, maxLength: 5000 }),
  confirmOverride: Type.Literal(true),
}, { additionalProperties: false });

export const IssueDismissInput = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 500 }),
}, { additionalProperties: false });

export const IssueRetryResearchInput = Type.Object({}, { additionalProperties: false });

export const IssueRevokeReceiptInput = Type.Object({
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
}, { additionalProperties: false });

/** Receipt 是 Issue 内嵌结构：保存 CEO 最终文本、决定时预研状态与 override 事实。 */
export const IssueReceipt = Type.Object({
  id: Type.String(),
  actionType: Type.String(),
  effectRef: Type.String(),
  decisionText: Type.String(),
  optionId: Type.Optional(Type.String()),
  researchStatusAtDecision: ResearchStatus,
  researchRunId: Type.Optional(Type.String()),
  override: Type.Boolean(),
  createdAt: Type.String(),
  revokedAt: Type.Optional(Type.String()),
  revokeReason: Type.Optional(Type.String()),
}, { additionalProperties: false });

export type TIssueLocation = Static<typeof IssueLocation>;
export type TIssueUrgencyLevel = Static<typeof IssueUrgencyLevel>;
export type TDriIssueImportRequest = Static<typeof DriIssueImportRequest>;
export type TResearchStatus = Static<typeof ResearchStatus>;
export type TResearchDoc = Static<typeof ResearchDoc>;
export type TIssueDecideInput = Static<typeof IssueDecideInput>;
export type TIssueDecideOverrideInput = Static<typeof IssueDecideOverrideInput>;
export type TIssueDismissInput = Static<typeof IssueDismissInput>;
export type TIssueRevokeReceiptInput = Static<typeof IssueRevokeReceiptInput>;
export type TIssueReceipt = Static<typeof IssueReceipt>;
