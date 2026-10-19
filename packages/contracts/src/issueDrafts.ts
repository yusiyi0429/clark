import { Type, type Static } from "@sinclair/typebox";

/**
 * 一号位深聊转议题（已定设计第 2 节）：首页对话里 Agent 提出的议题建议与初稿。只有 CEO 看得到。
 * 初稿：标题、为什么现在要议、已形成的想法、可选方案、未定的问题。一号位确认或修改后才建成议题。
 */
export const IssueDraftContent = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 25 }),
    whyNow: Type.String({ minLength: 1, maxLength: 1000 }),
    formedIdeas: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 8 }),
    options: Type.Array(Type.Object(
      { label: Type.String({ minLength: 1, maxLength: 60 }), tradeoff: Type.String({ maxLength: 500 }) },
      { additionalProperties: false },
    ), { maxItems: 5 }),
    openQuestions: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 8 }),
  },
  { additionalProperties: false },
);

/** 挂在哪：某个战场下，或作为全局战略议题。 */
export const IssueDraftLocation = Type.Union([
  Type.Object({ level: Type.Literal("battlefield"), battlefieldId: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }),
  Type.Object({ level: Type.Literal("company") }, { additionalProperties: false }),
]);

const IssueLink = Type.Object(
  { id: Type.String(), title: Type.String(), href: Type.String() },
  { additionalProperties: false },
);

export const IssueDraftView = Type.Object(
  {
    id: Type.String(),
    status: Type.Union([Type.Literal("proposed"), Type.Literal("accepted"), Type.Literal("declined")]),
    draft: IssueDraftContent,
    suggestedLocation: Type.Union([IssueDraftLocation, Type.Null()]),
    /** 能对上的已有议题：有时主选项是「接到议题 X 继续」。 */
    matchedIssue: Type.Union([IssueLink, Type.Null()]),
    /** 已接受：转到的议题。 */
    issue: Type.Union([IssueLink, Type.Null()]),
    battlefields: Type.Array(Type.Object({ id: Type.String(), name: Type.String() }, { additionalProperties: false })),
    /** 带过去的那一段对话有几轮。 */
    turns: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const AcceptIssueDraftRequest = Type.Union([
  Type.Object({ mode: Type.Literal("new"), draft: IssueDraftContent, location: IssueDraftLocation }, { additionalProperties: false }),
  Type.Object({ mode: Type.Literal("existing"), issueId: Type.String({ format: "uuid" }) }, { additionalProperties: false }),
]);

export const IssueDraftResponse = Type.Object({ draft: IssueDraftView }, { additionalProperties: false });

export type TIssueDraftContent = Static<typeof IssueDraftContent>;
export type TIssueDraftLocation = Static<typeof IssueDraftLocation>;
export type TIssueDraftView = Static<typeof IssueDraftView>;
export type TAcceptIssueDraftRequest = Static<typeof AcceptIssueDraftRequest>;
export type TIssueDraftResponse = Static<typeof IssueDraftResponse>;
