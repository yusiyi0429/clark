import { Type, type Static } from "@sinclair/typebox";

export const ObjectRef = Type.Object(
  {
    type: Type.String({ description: "业务对象类型，如 issue、meeting、home" }),
    id: Type.String(),
    version: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const ActionDescriptor = Type.Object(
  {
    actionId: Type.String({
      description: "HMAC 签名的确定性动作令牌，Web 不解析",
    }),
    actionType: Type.String(),
    label: Type.String(),
    itemId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const CardNavigation = Type.Object(
  { href: Type.String(), label: Type.String() },
  { additionalProperties: false },
);

export const CardConversation = Type.Object(
  {
    scope: Type.String({ description: "对话范围：global 或对象类型:id" }),
  },
  { additionalProperties: false },
);

export const Card = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    id: Type.String(),
    version: Type.Integer({ minimum: 1 }),
    kind: Type.String(),
    objectRef: ObjectRef,
    title: Type.String(),
    badge: Type.Optional(Type.String()),
    urgency: Type.Optional(Type.Union([Type.Literal("normal"), Type.Literal("red")])),
    payload: Type.Unknown(),
    navigation: Type.Optional(Type.Array(CardNavigation)),
    conversation: Type.Optional(CardConversation),
    actions: Type.Array(ActionDescriptor),
  },
  { additionalProperties: false, $id: "Card" },
);

export const CardCollection = Type.Object(
  { cards: Type.Array(Card) },
  { additionalProperties: false },
);

export type TObjectRef = Static<typeof ObjectRef>;
export type TActionDescriptor = Static<typeof ActionDescriptor>;
export type TCard = Static<typeof Card>;
export type TCardCollection = Static<typeof CardCollection>;
