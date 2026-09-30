import { Type, type Static } from "@sinclair/typebox";
import { MissionCardField } from "./missionCards.js";

/** 批注独立于群聊、私聊和修改建议；选区坐标只是渲染后纯文字中的定位提示。 */
const Anchor = {
  missionId: Type.String({ minLength: 1 }),
  field: MissionCardField,
  sourceVersion: Type.Integer({ minimum: 1 }),
  /** 当前看到的原始字段快照，包括候选版本叠加后的文字。 */
  sourceText: Type.String({ maxLength: 12000 }),
  quote: Type.String({ minLength: 1, maxLength: 2000 }),
  prefix: Type.String({ maxLength: 200 }),
  suffix: Type.String({ maxLength: 200 }),
  /** 对 DOM textContent 规范化空白后的 UTF-16 字符偏移，不是 Markdown 源码偏移。 */
  startOffset: Type.Integer({ minimum: 0 }),
};

export const MissionCardClarificationView = Type.Object({
  question: Type.String(), answer: Type.String(), authorId: Type.String(), authorName: Type.String(),
  createdAt: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const MissionCardAnnotationView = Type.Object({
  id: Type.String({ minLength: 1 }),
  cardId: Type.String({ minLength: 1 }),
  ...Anchor,
  body: Type.String({ minLength: 1, maxLength: 4000 }),
  authorId: Type.String({ minLength: 1 }),
  authorName: Type.String(),
  status: Type.Union([Type.Literal("saved"), Type.Literal("queued"), Type.Literal("applying"), Type.Literal("needs_clarification"),
    Type.Literal("applied"), Type.Literal("no_change"), Type.Literal("failed")]),
  question: Type.Union([Type.String(), Type.Null()]),
  options: Type.Array(Type.String(), { maxItems: 4 }),
  answer: Type.Union([Type.String(), Type.Null()]),
  note: Type.Union([Type.String(), Type.Null()]),
  appliedVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  canAnswer: Type.Boolean(),
  canRetry: Type.Boolean(),
  canResolve: Type.Boolean(),
  clarifications: Type.Array(MissionCardClarificationView),
  /** 原始字段已变更；保留批注，由阅读页谨慎尝试重新定位。 */
  stale: Type.Boolean(),
  createdAt: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const MissionCardRevisionView = Type.Object({
  id: Type.String({ minLength: 1 }), cardId: Type.String({ minLength: 1 }), missionId: Type.String({ minLength: 1 }), field: MissionCardField,
  before: Type.String(), after: Type.String(), reason: Type.String(),
  source: Type.Union([Type.Literal("annotation"), Type.Literal("agent")]),
  authorId: Type.String(), authorName: Type.String(), annotationId: Type.Union([Type.String(), Type.Null()]),
  beforeVersion: Type.Integer({ minimum: 1 }), afterVersion: Type.Integer({ minimum: 1 }),
  createdAt: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const MissionCardAnnotationsResponse = Type.Object({
  annotations: Type.Array(MissionCardAnnotationView),
  revisions: Type.Array(MissionCardRevisionView),
}, { additionalProperties: false });

export const CreateMissionCardAnnotationRequest = Type.Object({
  clientId: Type.String({ format: "uuid" }),
  sourceRound: Type.Integer({ minimum: 1 }),
  ...Anchor,
  body: Type.String({ minLength: 1, maxLength: 4000 }),
}, { additionalProperties: false });

export const CreateMissionCardAnnotationResponse = Type.Object({
  annotation: MissionCardAnnotationView,
}, { additionalProperties: false });

export const AnswerMissionCardAnnotationRequest = Type.Object({
  answer: Type.String({ minLength: 1, maxLength: 4000 }),
}, { additionalProperties: false });
export const RetryMissionCardAnnotationRequest = Type.Object({}, { additionalProperties: false });
export const ResolveMissionCardAnnotationRequest = Type.Object({ reason: Type.String({ minLength: 1, maxLength: 1000, pattern: "\\S" }) }, { additionalProperties: false });
export const MissionCardRevisionsResponse = Type.Object({ revisions: Type.Array(MissionCardRevisionView) }, { additionalProperties: false });

export type TMissionCardAnnotationView = Static<typeof MissionCardAnnotationView>;
export type TMissionCardAnnotationsResponse = Static<typeof MissionCardAnnotationsResponse>;
export type TCreateMissionCardAnnotationRequest = Static<typeof CreateMissionCardAnnotationRequest>;
export type TCreateMissionCardAnnotationResponse = Static<typeof CreateMissionCardAnnotationResponse>;
export type TMissionCardRevisionView = Static<typeof MissionCardRevisionView>;
export type TAnswerMissionCardAnnotationRequest = Static<typeof AnswerMissionCardAnnotationRequest>;
export type TMissionCardClarificationView = Static<typeof MissionCardClarificationView>;
