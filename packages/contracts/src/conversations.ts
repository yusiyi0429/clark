import { Type, type Static } from "@sinclair/typebox";

export const ConversationScope = Type.String({
  pattern: "^(global|(issue|signal|meeting|monthly-plan):[A-Za-z0-9][A-Za-z0-9_-]{0,127}|mission:.{1,128})$",
  description: "global 或稳定对象 scope",
});

export const ConversationSessionId = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  description: "scope 内的 Conversation 会话 id",
});

export const CardReference = Type.Object(
  { cardId: Type.String({ minLength: 1 }), version: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);

export const ReferenceSnapshot = Type.Object(
  {
    cardId: Type.String(),
    version: Type.Integer({ minimum: 1 }),
    kind: Type.String(),
    title: Type.String(),
    objectRef: Type.Object(
      { type: Type.String(), id: Type.String(), version: Type.Integer({ minimum: 1 }) },
      { additionalProperties: false },
    ),
    payload: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const ConversationAttachmentRef = Type.Object(
  { id: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

/** 会话内已上传附件的可见信息；不含抽取文本与存储键。 */
export const ConversationAttachmentInfo = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    fileName: Type.String({ minLength: 1 }),
    mimeType: Type.Union([
      Type.Literal("application/pdf"),
      Type.Literal("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
      Type.Literal("text/markdown"),
    ]),
    sizeBytes: Type.Integer({ minimum: 1 }),
    pageCount: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

/** 持久化在 user 消息行 attachments jsonb 内的完整元数据；原件只留在 API 卷。 */
export const ConversationAttachment = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    fileName: Type.String({ minLength: 1 }),
    mimeType: Type.Union([
      Type.Literal("application/pdf"),
      Type.Literal("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
      Type.Literal("text/markdown"),
    ]),
    sizeBytes: Type.Integer({ minimum: 1 }),
    pageCount: Type.Optional(Type.Integer({ minimum: 1 })),
    storageKey: Type.String({ minLength: 1 }),
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    extractedText: Type.String({ minLength: 1, maxLength: 100000 }),
  },
  { additionalProperties: false },
);

export const ConversationAttachmentUploadResponse = Type.Object(
  { attachments: Type.Array(ConversationAttachmentInfo, { maxItems: 10 }) },
  { additionalProperties: false },
);

export const ConversationMessageRequest = Type.Object(
  {
    message: Type.String({ minLength: 1, maxLength: 20_000 }),
    references: Type.Optional(Type.Array(CardReference, { maxItems: 20 })),
    attachments: Type.Optional(Type.Array(ConversationAttachmentRef, { maxItems: 10 })),
  },
  { additionalProperties: false },
);

export const ConversationMessage = Type.Object(
  {
    sequence: Type.Integer({ minimum: 1 }),
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    content: Type.String(),
    referencesSnapshot: Type.Array(ReferenceSnapshot),
    attachments: Type.Array(ConversationAttachmentInfo),
    runId: Type.String(),
    createdAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

export const ConversationHistory = Type.Object(
  { scope: ConversationScope, messages: Type.Array(ConversationMessage) },
  { additionalProperties: false },
);

/** 会话摘要：默认会话是 scope 内最早未删除的会话，legacy /messages 路由读写它。 */
export const ConversationSessionSummary = Type.Object(
  {
    id: ConversationSessionId,
    scope: ConversationScope,
    title: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
    isDefault: Type.Boolean(),
    messageCount: Type.Integer({ minimum: 0 }),
    lastMessageAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    createdAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

export const ConversationSessionList = Type.Object(
  { scope: ConversationScope, sessions: Type.Array(ConversationSessionSummary) },
  { additionalProperties: false },
);

export const CreateConversationSessionRequest = Type.Object(
  { title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) },
  { additionalProperties: false },
);

const StreamBase = {
  runId: Type.String(),
  scope: ConversationScope,
  sequence: Type.Integer({ minimum: 1 }),
};

export const ConversationSseEvent = Type.Union([
  Type.Object({ ...StreamBase, type: Type.Literal("message"), delta: Type.String() }, { additionalProperties: false }),
  Type.Object(
    {
      ...StreamBase,
      type: Type.Literal("tool"),
      phase: Type.Union([Type.Literal("started"), Type.Literal("completed")]),
      toolCallId: Type.String(),
      name: Type.String(),
      isError: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...StreamBase,
      type: Type.Literal("usage"),
      input: Type.Integer({ minimum: 0 }),
      output: Type.Integer({ minimum: 0 }),
      cacheRead: Type.Integer({ minimum: 0 }),
      cacheWrite: Type.Integer({ minimum: 0 }),
      totalTokens: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...StreamBase,
      type: Type.Literal("compaction"),
      phase: Type.Union([Type.Literal("started"), Type.Literal("completed")]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...StreamBase,
      type: Type.Literal("warning"),
      code: Type.Literal("RUNTIME_RECREATED"),
      message: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...StreamBase, type: Type.Literal("error"), code: Type.String(), message: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...StreamBase,
      type: Type.Literal("done"),
      status: Type.Union([Type.Literal("completed"), Type.Literal("aborted")]),
    },
    { additionalProperties: false },
  ),
]);

export type TConversationScope = Static<typeof ConversationScope>;
export type TConversationSessionId = Static<typeof ConversationSessionId>;
export type TCardReference = Static<typeof CardReference>;
export type TReferenceSnapshot = Static<typeof ReferenceSnapshot>;
export type TConversationAttachmentRef = Static<typeof ConversationAttachmentRef>;
export type TConversationAttachmentInfo = Static<typeof ConversationAttachmentInfo>;
export type TConversationAttachment = Static<typeof ConversationAttachment>;
export type TConversationAttachmentUploadResponse = Static<typeof ConversationAttachmentUploadResponse>;
export type TConversationMessageRequest = Static<typeof ConversationMessageRequest>;
export type TConversationMessage = Static<typeof ConversationMessage>;
export type TConversationHistory = Static<typeof ConversationHistory>;
export type TConversationSessionSummary = Static<typeof ConversationSessionSummary>;
export type TConversationSessionList = Static<typeof ConversationSessionList>;
export type TCreateConversationSessionRequest = Static<typeof CreateConversationSessionRequest>;
export type TConversationSseEvent = Static<typeof ConversationSseEvent>;
