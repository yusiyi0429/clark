import { Type, type Static } from '@sinclair/typebox';

/** 个人记忆的一条：只有本人可见，不写进本体。anchor 是「关于什么」，reference 是「依据在哪」。 */
export const PersonalMemoryAnchor = Type.Object({
  target: Type.String({ description: '对象 id（如 issue:<id>）或 topic:<主题>' }),
  pinnedVersion: Type.Optional(Type.Integer({ minimum: 0, description: '写入时钉住的对象版本' })),
  title: Type.Optional(Type.String({ description: '对象现在的标题（列表接口按 target 查出来，只读，不存）' })),
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
  q: Type.Optional(Type.String({ maxLength: 200, description: '按标题、正文、原话搜索（不分大小写的子串）' })),
}, { additionalProperties: false });
export const DeletePersonalMemoryItemQuery = Type.Object({
  purge: Type.Optional(Type.Literal('1', { description: '1 = 彻底删除（删掉这一行，不能恢复）；不给 = 忘掉' })),
}, { additionalProperties: false });
export const UpdatePersonalMemoryItemRequest = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
}, { additionalProperties: false, minProperties: 1 });
/** 首页伙伴（独立 Chat 服务）记住的一条：Chat 自己存、自己用，天枢只读来显示，不能改。 */
export const PartnerMemoryCategory = Type.Union([Type.Literal('preference'), Type.Literal('project_background'), Type.Literal('research_decision'), Type.Literal('feedback_instruction')],
  { description: '偏好、项目背景、研究与决策、反馈指令' });
export const PartnerMemoryItem = Type.Object({
  id: Type.String(),
  category: PartnerMemoryCategory,
  text: Type.String(),
  project: Type.Union([Type.String(), Type.Null()]),
  tentative: Type.Boolean({ description: '伙伴推测的，本人没有明说' }),
  updatedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false });
export const PartnerMemoryList = Type.Object({
  available: Type.Boolean({ description: '首页对话走独立 Chat 时为 true；没接 Chat 时为 false、items 为空' }),
  items: Type.Array(PartnerMemoryItem, { description: '现行的，最近更新的在前，最多 100 条' }),
}, { additionalProperties: false });
export type TPersonalMemoryItem = Static<typeof PersonalMemoryItem>;
export type TPartnerMemoryItem = Static<typeof PartnerMemoryItem>;
export type TUpdatePersonalMemoryItemRequest = Static<typeof UpdatePersonalMemoryItemRequest>;
