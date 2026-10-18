import { Type, type Static } from "@sinclair/typebox";
import { ActionDescriptor } from "./cards.js";

/**
 * 送达通道（⑨ 传话）：发起人一句话 → Agent 起草并自查歧义 → 预览 → 发出；接收人收到待办卡，卡上问答，完成由人标记。
 * kind 先只用 relay；collection / impact / supplement 留给 ③ 信息收集、影响卡和补充请求。
 */
export const RequestKind = Type.Union([Type.Literal("relay"), Type.Literal("collection"), Type.Literal("impact"), Type.Literal("supplement")]);
export const RequestStatus = Type.Union([Type.Literal("draft"), Type.Literal("open"), Type.Literal("done")]);

/** Agent 多步处理的一步：做完打勾、当前高亮、没开始置灰；某一步有结果就写在 result 里，流程停在那里。 */
export const RequestStep = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 20 }),
    status: Type.Union([Type.Literal("done"), Type.Literal("current"), Type.Literal("pending")]),
    result: Type.Union([Type.String({ minLength: 1, maxLength: 300 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const RequestPerson = Type.Object(
  { personId: Type.String({ minLength: 1 }), displayName: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const RequestRecipientView = Type.Object(
  {
    personId: Type.String({ minLength: 1 }),
    displayName: Type.String({ minLength: 1 }),
    status: Type.Union([Type.Literal("pending"), Type.Literal("done")]),
    doneByName: Type.Union([Type.String(), Type.Null()]),
    /** ISO 8601 */
    doneAt: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

export const RequestQuestionView = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    askerId: Type.String({ minLength: 1 }),
    askerName: Type.String({ minLength: 1 }),
    question: Type.String({ minLength: 1 }),
    answer: Type.Union([Type.String(), Type.Null()]),
    /** 发起人的 Agent 起草、还没确认的回答；只给发起人看。 */
    answerDraft: Type.Union([Type.String(), Type.Null()]),
    answeredAt: Type.Union([Type.String(), Type.Null()]),
    mergedIntoBody: Type.Boolean(),
    createdAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const RequestClarification = Type.Object(
  { question: Type.String({ minLength: 1, maxLength: 300 }), answer: Type.Union([Type.String({ minLength: 1, maxLength: 1000 }), Type.Null()]) },
  { additionalProperties: false },
);

/** 只给发起人和（发出后的）接收人看；其他人一律 404。 */
export const RequestView = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    kind: RequestKind,
    status: RequestStatus,
    version: Type.Integer({ minimum: 1 }),
    title: Type.String({ minLength: 1 }),
    body: Type.String({ minLength: 1 }),
    /** 发起人的原话。 */
    prompt: Type.String({ minLength: 1 }),
    initiator: RequestPerson,
    createdAt: Type.String({ minLength: 1 }),
    sentAt: Type.Union([Type.String(), Type.Null()]),
    recipients: Type.Array(RequestRecipientView),
    /** 草稿：Agent 建议的接收人（发起人在预览里勾选最终名单）。 */
    candidates: Type.Array(RequestPerson),
    /** 草稿：发起人可以选的人（真实人员目录，去掉自己）；其他时候为空。 */
    directory: Type.Array(RequestPerson),
    /** 发出前问发起人的歧义问题；answer 为 null 的是还没回答的。 */
    clarifications: Type.Array(RequestClarification, { maxItems: 10 }),
    questions: Type.Array(RequestQuestionView),
    viewer: Type.Object(
      {
        isInitiator: Type.Boolean(),
        isRecipient: Type.Boolean(),
        myStatus: Type.Union([Type.Literal("pending"), Type.Literal("done"), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    actions: Type.Array(ActionDescriptor),
  },
  { additionalProperties: false },
);

export const RequestResponse = Type.Object({ request: RequestView }, { additionalProperties: false });

/** 起草：第一次只给 prompt；带 requestId 时按回答和改过的原话重写同一份草稿（version 加一）。 */
export const DraftRequestRequest = Type.Object(
  {
    prompt: Type.String({ minLength: 1, maxLength: 2000 }),
    requestId: Type.Optional(Type.String({ minLength: 1 })),
    clarifications: Type.Optional(Type.Array(RequestClarification, { maxItems: 10 })),
  },
  { additionalProperties: false },
);
export const DraftRequestResponse = Type.Object(
  { request: RequestView, steps: Type.Array(RequestStep) },
  { additionalProperties: false },
);

export const RequestBox = Type.Union([Type.Literal("inbox"), Type.Literal("sent")]);
export const RequestListQuery = Type.Object({ box: RequestBox }, { additionalProperties: false });
export const RequestListItem = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    status: RequestStatus,
    initiatorName: Type.String({ minLength: 1 }),
    createdAt: Type.String({ minLength: 1 }),
    sentAt: Type.Union([Type.String(), Type.Null()]),
    /** 收到的：我自己的状态；发出的：null。 */
    myStatus: Type.Union([Type.Literal("pending"), Type.Literal("done"), Type.Null()]),
    recipientNames: Type.Array(Type.String()),
    recipientsDone: Type.Integer({ minimum: 0 }),
    /** 还没回答的问题数。 */
    openQuestions: Type.Integer({ minimum: 0 }),
    /** 这条请求上有给我的未读通知（收到、有人回答、有人完成）；打开请求即读。 */
    unread: Type.Boolean(),
  },
  { additionalProperties: false },
);
export const RequestListResponse = Type.Object({ items: Type.Array(RequestListItem, { maxItems: 100 }) }, { additionalProperties: false });

/** 接收人提问前：先在说明和已有问答里找答案，找到就直接给，不打扰发起人；找不到就整理成一个问题等本人确认。 */
export const PrepareRequestQuestionRequest = Type.Object(
  { question: Type.String({ minLength: 1, maxLength: 1000 }) },
  { additionalProperties: false },
);
export const PrepareRequestQuestionResponse = Type.Object(
  {
    steps: Type.Array(RequestStep),
    /** 已有答案：source=body 时 text 是说明里的原文，source=question 时是那条问答的答案。 */
    answer: Type.Union([
      Type.Object(
        {
          source: Type.Union([Type.Literal("body"), Type.Literal("question")]),
          text: Type.String({ minLength: 1 }),
          questionId: Type.Union([Type.String(), Type.Null()]),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    /** 整理好的问题（预览里显示，本人确认才发）；找到答案时也给，本人仍可以选择发问。 */
    question: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const DraftRequestAnswerResponse = Type.Object(
  { steps: Type.Array(RequestStep), answer: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const RequestSendInput = Type.Object(
  { recipientIds: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 30 }) },
  { additionalProperties: false },
);
export const RequestAskInput = Type.Object({ question: Type.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false });
export const RequestAnswerInput = Type.Object({ answer: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false });

export const ExecuteRequestActionRequest = Type.Object(
  { actionId: Type.String({ minLength: 1 }), input: Type.Optional(Type.Unknown()) },
  { additionalProperties: false },
);

export type TRequestKind = Static<typeof RequestKind>;
export type TRequestStatus = Static<typeof RequestStatus>;
export type TRequestStep = Static<typeof RequestStep>;
export type TRequestPerson = Static<typeof RequestPerson>;
export type TRequestRecipientView = Static<typeof RequestRecipientView>;
export type TRequestQuestionView = Static<typeof RequestQuestionView>;
export type TRequestClarification = Static<typeof RequestClarification>;
export type TRequestView = Static<typeof RequestView>;
export type TRequestResponse = Static<typeof RequestResponse>;
export type TDraftRequestRequest = Static<typeof DraftRequestRequest>;
export type TDraftRequestResponse = Static<typeof DraftRequestResponse>;
export type TRequestBox = Static<typeof RequestBox>;
export type TRequestListItem = Static<typeof RequestListItem>;
export type TRequestListResponse = Static<typeof RequestListResponse>;
export type TPrepareRequestQuestionRequest = Static<typeof PrepareRequestQuestionRequest>;
export type TPrepareRequestQuestionResponse = Static<typeof PrepareRequestQuestionResponse>;
export type TDraftRequestAnswerResponse = Static<typeof DraftRequestAnswerResponse>;
export type TRequestSendInput = Static<typeof RequestSendInput>;
export type TRequestAskInput = Static<typeof RequestAskInput>;
export type TRequestAnswerInput = Static<typeof RequestAnswerInput>;
export type TExecuteRequestActionRequest = Static<typeof ExecuteRequestActionRequest>;
