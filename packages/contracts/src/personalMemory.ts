import { Type, type Static } from '@sinclair/typebox';

/** 个人记忆的一条：只有本人可见，不写进本体。anchor 是「关于什么」，reference 是「依据在哪」。 */
export const PersonalMemoryAnchor = Type.Object({
  target: Type.String({ description: '对象 id（如 issue:<id>）或 topic:<主题>' }),
  pinnedVersion: Type.Optional(Type.Integer({ minimum: 0, description: '写入时钉住的对象版本' })),
}, { additionalProperties: false });
export const PersonalMemoryReference = Type.Object({
  ref: Type.String({ description: '依据，沿用 cite: 语法去掉前缀，如 chat:<会话 id>#<消息序号>' }),
  quote: Type.Optional(Type.String()),
  at: Type.String({ format: 'date-time' }),
}, { additionalProperties: false });
export const PersonalMemoryStatus = Type.Union([Type.Literal('active'), Type.Literal('superseded'), Type.Literal('forgotten')]);
export const PersonalMemoryKind = Type.Union([Type.Literal('idea'), Type.Literal('stance'), Type.Literal('open_question'), Type.Literal('reason'), Type.Literal('preference'), Type.Literal('practice')],
  { description: '想法、立场、未决问题、理由、偏好与表达方式、做法' });
export const PersonalMemoryItem = Type.Object({
  id: Type.String(),
  kind: PersonalMemoryKind,
  title: Type.String(),
  text: Type.String(),
  status: PersonalMemoryStatus,
  supersededBy: Type.Union([Type.String(), Type.Null()]),
  anchors: Type.Array(PersonalMemoryAnchor),
  references: Type.Array(PersonalMemoryReference),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false });
export const PersonalMemoryList = Type.Object({ items: Type.Array(PersonalMemoryItem) }, { additionalProperties: false });
export const PersonalMemoryListQuery = Type.Object({
  status: Type.Optional(Type.Union([PersonalMemoryStatus, Type.Literal('all')])),
}, { additionalProperties: false });
export const UpdatePersonalMemoryItemRequest = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
}, { additionalProperties: false, minProperties: 1 });
export type TPersonalMemoryItem = Static<typeof PersonalMemoryItem>;
export type TUpdatePersonalMemoryItemRequest = Static<typeof UpdatePersonalMemoryItemRequest>;
