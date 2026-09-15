import { Type, type Static } from "@sinclair/typebox";

export const ConversationScope = Type.String({
  pattern: "^(global|(issue|signal|meeting|monthly-plan):[A-Za-z0-9][A-Za-z0-9_-]{0,127})$",
  description: "global 或稳定对象 scope",
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

export const ConversationMessageRequest = Type.Object(
  {
    message: Type.String({ minLength: 1, maxLength: 20_000 }),
    references: Type.Optional(Type.Array(CardReference, { maxItems: 20 })),
  },
  { additionalProperties: false },
);

export const ConversationMessage = Type.Object(
  {
    sequence: Type.Integer({ minimum: 1 }),
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    content: Type.String(),
    referencesSnapshot: Type.Array(ReferenceSnapshot),
    runId: Type.String(),
    createdAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

export const ConversationHistory = Type.Object(
  { scope: ConversationScope, messages: Type.Array(ConversationMessage) },
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
export type TCardReference = Static<typeof CardReference>;
export type TReferenceSnapshot = Static<typeof ReferenceSnapshot>;
export type TConversationMessageRequest = Static<typeof ConversationMessageRequest>;
export type TConversationMessage = Static<typeof ConversationMessage>;
export type TConversationHistory = Static<typeof ConversationHistory>;
export type TConversationSseEvent = Static<typeof ConversationSseEvent>;
