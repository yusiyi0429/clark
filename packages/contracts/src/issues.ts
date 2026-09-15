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

export type TIssueLocation = Static<typeof IssueLocation>;
export type TIssueUrgencyLevel = Static<typeof IssueUrgencyLevel>;
export type TDriIssueImportRequest = Static<typeof DriIssueImportRequest>;
