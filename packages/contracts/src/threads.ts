import { Type, type Static } from "@sinclair/typebox";

/** 有群组的对象：议题、信号、执行事项、会议（月度计划、Mission 没有群组）。 */
export const ThreadObjectType = Type.Union([
  Type.Literal("issue"),
  Type.Literal("signal"),
  Type.Literal("task"),
  Type.Literal("meeting"),
]);

export const ThreadObjectId = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" });

/** 名字与身份现查人员目录，不落库。 */
export const ThreadMember = Type.Object(
  {
    personId: Type.String({ minLength: 1 }),
    displayName: Type.String({ minLength: 1 }),
    title: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

/** 从左边材料引用的片段；消息本身只是纯文字。 */
export const ThreadQuote = Type.Object(
  { text: Type.String({ minLength: 1, maxLength: 2000 }) },
  { additionalProperties: false },
);

/** Co-Agent 同步消息没有作者（authorId、authorName 为空）。 */
export const ThreadMessage = Type.Object(
  {
    id: Type.Integer({ minimum: 1 }),
    kind: Type.Union([Type.Literal("member"), Type.Literal("co-agent")]),
    authorId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    authorName: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    content: Type.String({ minLength: 1, maxLength: 4000 }),
    quote: Type.Union([ThreadQuote, Type.Null()]),
    createdAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

/** 打开群组：成员、消息与看的人读到哪里；未读不计自己发的。 */
export const ThreadView = Type.Object(
  {
    members: Type.Array(ThreadMember),
    messages: Type.Array(ThreadMessage),
    lastReadId: Type.Integer({ minimum: 0 }),
    unread: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const ThreadMessageList = Type.Object(
  { messages: Type.Array(ThreadMessage) },
  { additionalProperties: false },
);

export const PostThreadMessageRequest = Type.Object(
  {
    content: Type.String({ minLength: 1, maxLength: 4000 }),
    quote: Type.Optional(ThreadQuote),
  },
  { additionalProperties: false },
);

export const MarkThreadReadRequest = Type.Object(
  { lastReadId: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);

export const MarkThreadReadResponse = Type.Object(
  { lastReadId: Type.Integer({ minimum: 0 }), unread: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);

export type TThreadObjectType = Static<typeof ThreadObjectType>;
export type TThreadMember = Static<typeof ThreadMember>;
export type TThreadQuote = Static<typeof ThreadQuote>;
export type TThreadMessage = Static<typeof ThreadMessage>;
export type TThreadView = Static<typeof ThreadView>;
export type TThreadMessageList = Static<typeof ThreadMessageList>;
export type TPostThreadMessageRequest = Static<typeof PostThreadMessageRequest>;
export type TMarkThreadReadRequest = Static<typeof MarkThreadReadRequest>;
export type TMarkThreadReadResponse = Static<typeof MarkThreadReadResponse>;
