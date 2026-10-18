import { Type, type Static } from "@sinclair/typebox";
import { RequestStep } from "./requests.js";

/**
 * 影响卡：某个触发（会上确认的一条决定；文档的修订、取代）对某个人手上的哪件事有什么影响、要他做什么。
 * - 卡面：impact（对他正在做或即将做的事有什么影响，落到具体的 Task / Mission / 验收项）+ action（要做什么、什么时候；没有要做的就是「知悉即可」）。
 * - 点开：why（前因后果）、sources（原话出处）、askWho（可以问谁）。
 * - 卡下：追问（Agent 回答，绑定在这张卡上）、「和我无关」（回流成质量信号）。
 * - 推送走送达通道：delivered 的卡对应一条 kind = impact 的请求，通知栏和飞书通知都复用它。
 */
export const ImpactCardStatus = Type.Union([Type.Literal("shadow"), Type.Literal("delivered"), Type.Literal("irrelevant")]);
export const ImpactTriggerKind = Type.Union([Type.Literal("meeting_decision"), Type.Literal("doc_change")]);
export const ImpactConfidence = Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]);

/** 影响落到的具体对象；acceptance 是某个 Task 完成标准的第 index 条（从 0 数）。 */
export const ImpactTarget = Type.Object(
  {
    type: Type.Union([Type.Literal("task"), Type.Literal("mission"), Type.Literal("acceptance")]),
    id: Type.String({ minLength: 1 }),
    index: Type.Optional(Type.Integer({ minimum: 0 })),
    title: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** do：要他做的事和时间点；know：知悉即可（text 写「知悉即可」之外还可以补一句为什么不用动）。 */
export const ImpactAction = Type.Object(
  {
    kind: Type.Union([Type.Literal("do"), Type.Literal("know")]),
    text: Type.String({ minLength: 1, maxLength: 300 }),
    /** YYYY-MM-DD；说不出具体日期时为 null。 */
    due: Type.Union([Type.String({ minLength: 10, maxLength: 10 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const ImpactSource = Type.Object(
  {
    meetingId: Type.String({ minLength: 1 }),
    meetingTitle: Type.String({ minLength: 1 }),
    turnId: Type.Union([Type.String(), Type.Null()]),
    speakerName: Type.Union([Type.String(), Type.Null()]),
    quote: Type.String({ minLength: 1 }),
    /** 原话的时刻（ISO 8601）。 */
    at: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

export const ImpactAskWho = Type.Object(
  {
    personId: Type.String({ minLength: 1 }),
    displayName: Type.String({ minLength: 1 }),
    role: Type.Union([Type.Literal("host"), Type.Literal("ceo"), Type.Literal("author")]),
  },
  { additionalProperties: false },
);

/** 写进计划（10/30）：activity 由 Agent 直接写进 Task 全景；formal 由对象的 DRI 在卡上一键确认。这一版只留结构，不写。 */
export const ImpactPlanWrite = Type.Object(
  {
    kind: Type.Union([Type.Literal("activity"), Type.Literal("formal")]),
    /** 本体对象或组件引用。 */
    objectRef: Type.String({ minLength: 1 }),
    component: Type.Union([Type.String(), Type.Null()]),
    patch: Type.String({ minLength: 1 }),
    status: Type.Union([Type.Literal("proposed"), Type.Literal("written"), Type.Literal("confirmed")]),
  },
  { additionalProperties: false },
);

export const ImpactMeetingTrigger = Type.Object(
  {
    kind: Type.Literal("meeting_decision"),
    id: Type.String({ minLength: 1 }),
    revision: Type.Integer({ minimum: 0 }),
    meetingId: Type.String({ minLength: 1 }),
    meetingTitle: Type.String({ minLength: 1 }),
    /** 会上定了什么（生效的说法）。 */
    statement: Type.String({ minLength: 1 }),
    tier: Type.Union([Type.Literal("strategic"), Type.Literal("host")]),
    /** 谁拍的板：host 主持人、ceo、agent 代判。 */
    decidedBy: Type.Union([Type.Literal("host"), Type.Literal("ceo"), Type.Literal("agent")]),
  },
  { additionalProperties: false },
);

const ImpactDoc = Type.Object(
  { title: Type.String({ minLength: 1 }), url: Type.Union([Type.String(), Type.Null()]) },
  { additionalProperties: false },
);

/** 文档变更（⑧）：作者发布的新文档修订或取代了这个人依据的旧文档。 */
export const ImpactDocTrigger = Type.Object(
  {
    kind: Type.Literal("doc_change"),
    id: Type.String({ minLength: 1 }),
    relation: Type.Union([Type.Literal("revision"), Type.Literal("supersede")]),
    newDoc: ImpactDoc,
    /** 他依据的那份；revision / revisedAt 是他确认依据时的版本。 */
    oldDoc: Type.Object(
      {
        title: Type.String({ minLength: 1 }),
        url: Type.Union([Type.String(), Type.Null()]),
        revision: Type.Union([Type.String(), Type.Null()]),
        revisedAt: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    authorName: Type.String({ minLength: 1 }),
    /** 谁确认的：作者，或作者确认不了时旧文档的负责人。 */
    decidedByName: Type.String({ minLength: 1 }),
    effectiveOn: Type.Union([Type.String(), Type.Null()]),
    transitionUntil: Type.Union([Type.String(), Type.Null()]),
    keepExisting: Type.Union([Type.Boolean(), Type.Null()]),
  },
  { additionalProperties: false },
);

export const ImpactTrigger = Type.Union([ImpactMeetingTrigger, ImpactDocTrigger]);

/** 文档变更卡上本人的选择，选完更新他的工作依据清单。 */
export const ImpactBasisChoice = Type.Object(
  {
    choice: Type.Union([Type.Literal("switch"), Type.Literal("keep")]),
    until: Type.Union([Type.String(), Type.Null()]),
    reason: Type.Union([Type.String(), Type.Null()]),
    at: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** 更正卡：指向原卡，写明改了什么。 */
export const ImpactCorrection = Type.Object(
  { of: Type.String({ minLength: 1 }), note: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const ImpactQuestion = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    question: Type.String({ minLength: 1 }),
    answer: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const ImpactCardView = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    status: ImpactCardStatus,
    /** 通知栏一行：落到哪件事、怎么变。 */
    title: Type.String({ minLength: 1 }),
    impact: Type.String({ minLength: 1 }),
    action: ImpactAction,
    targets: Type.Array(ImpactTarget),
    why: Type.String(),
    sources: Type.Array(ImpactSource),
    askWho: Type.Array(ImpactAskWho),
    trigger: ImpactTrigger,
    /** 这条决定现在还是 Agent 代判、主持人尚未确认。 */
    agentJudged: Type.Boolean(),
    correction: Type.Union([ImpactCorrection, Type.Null()]),
    /** 已经有更正卡替代了这张。 */
    superseded: Type.Boolean(),
    confidence: ImpactConfidence,
    planWrite: Type.Union([ImpactPlanWrite, Type.Null()]),
    basisChoice: Type.Union([ImpactBasisChoice, Type.Null()]),
    questions: Type.Array(ImpactQuestion),
    /** 对应的送达请求（delivered 才有）。 */
    requestId: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export const ImpactCardResponse = Type.Object({ card: ImpactCardView }, { additionalProperties: false });

export const ImpactAskRequest = Type.Object({ question: Type.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false });
export const ImpactAskResponse = Type.Object(
  { steps: Type.Array(RequestStep), card: ImpactCardView },
  { additionalProperties: false },
);
export const ImpactIrrelevantRequest = Type.Object(
  { reason: Type.Optional(Type.String({ maxLength: 500 })) },
  { additionalProperties: false },
);

export type TImpactCardStatus = Static<typeof ImpactCardStatus>;
export type TImpactTriggerKind = Static<typeof ImpactTriggerKind>;
export type TImpactConfidence = Static<typeof ImpactConfidence>;
export type TImpactTarget = Static<typeof ImpactTarget>;
export type TImpactAction = Static<typeof ImpactAction>;
export type TImpactSource = Static<typeof ImpactSource>;
export type TImpactAskWho = Static<typeof ImpactAskWho>;
export type TImpactPlanWrite = Static<typeof ImpactPlanWrite>;
export type TImpactTrigger = Static<typeof ImpactTrigger>;
export type TImpactMeetingTrigger = Static<typeof ImpactMeetingTrigger>;
export type TImpactDocTrigger = Static<typeof ImpactDocTrigger>;
export type TImpactBasisChoice = Static<typeof ImpactBasisChoice>;
export type TImpactCorrection = Static<typeof ImpactCorrection>;
export type TImpactQuestion = Static<typeof ImpactQuestion>;
export type TImpactCardView = Static<typeof ImpactCardView>;
export type TImpactCardResponse = Static<typeof ImpactCardResponse>;
export type TImpactAskRequest = Static<typeof ImpactAskRequest>;
export type TImpactAskResponse = Static<typeof ImpactAskResponse>;
export type TImpactIrrelevantRequest = Static<typeof ImpactIrrelevantRequest>;
