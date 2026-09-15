import { Type, type Static } from "@sinclair/typebox";

/** MVP 唯一接受的逐字稿版本；WarMap 不做录音、ASR、格式转换或说话人映射。 */
export const TranscriptSchemaVersion = Type.Literal("warmap-transcript.v1");

/** 单个发言段。speakerId 必须匹配 Meeting participant；姓名与角色不复制进 Transcript。 */
export const TranscriptTurn = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200 }),
    speakerId: Type.String({ minLength: 1, maxLength: 200 }),
    startedAt: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    text: Type.String({ maxLength: 20000 }),
  },
  { additionalProperties: false },
);

/** 外部提交的整份逐字稿；任一项不合法都整份拒绝，不保存部分 turns。 */
export const WarmapTranscript = Type.Object(
  {
    schemaVersion: TranscriptSchemaVersion,
    meetingId: Type.String({ minLength: 1, maxLength: 200 }),
    turns: Type.Array(TranscriptTurn, { minItems: 1, maxItems: 2000 }),
  },
  { additionalProperties: false },
);

/** 已落库的 Transcript：原始 turns 加导入时间，不复制 participant。 */
export const StoredTranscript = Type.Object(
  {
    schemaVersion: TranscriptSchemaVersion,
    meetingId: Type.String({ minLength: 1, maxLength: 200 }),
    turns: Type.Array(TranscriptTurn, { minItems: 1 }),
    importedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const OutcomeItemKind = Type.Union([
  Type.Literal("decision"),
  Type.Literal("todo"),
  Type.Literal("ceoJudgment"),
  Type.Literal("reopenWhen"),
  Type.Literal("open"),
]);

/** CEO 判断只允许五类权限，模型不能自造类别。 */
export const CeoJudgmentKind = Type.Union([
  Type.Literal("company_direction"),
  Type.Literal("resource_allocation"),
  Type.Literal("external_commitment"),
  Type.Literal("major_risk"),
  Type.Literal("mission_boundary"),
]);

/** PostMeeting Agent 的严格输出项；speaker 与 owner 由 turn 确定性校验，不采信自由文本身份。 */
export const PostMeetingItem = Type.Object(
  {
    kind: OutcomeItemKind,
    text: Type.String({ minLength: 1, maxLength: 4000 }),
    turnId: Type.String({ minLength: 1, maxLength: 200 }),
    quote: Type.String({ minLength: 1, maxLength: 2000 }),
    ownerPersonId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    issueId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    judgmentKind: Type.Optional(CeoJudgmentKind),
    /** reopenWhen 指向同一候选内父 decision 的下标。 */
    parentIndex: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const PostMeetingCandidate = Type.Object(
  {
    summary: Type.String({ minLength: 1, maxLength: 4000 }),
    items: Type.Array(PostMeetingItem, { maxItems: 200 }),
  },
  { additionalProperties: false },
);

export const OutcomeReviewStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("confirmed"),
  Type.Literal("dismissed"),
]);

/** 逐项 Review：open 条目没有 Review（Ticket 11 处理 confirm/dismiss/revoke）。 */
export const OutcomeReview = Type.Object(
  {
    status: OutcomeReviewStatus,
    effectRef: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

export const MeetingOutcomeItem = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    kind: OutcomeItemKind,
    text: Type.String({ minLength: 1 }),
    turnId: Type.String({ minLength: 1 }),
    quote: Type.String({ minLength: 1 }),
    speakerId: Type.String({ minLength: 1 }),
    ownerPersonId: Type.Union([Type.String(), Type.Null()]),
    issueId: Type.Union([Type.String(), Type.Null()]),
    judgmentKind: Type.Union([CeoJudgmentKind, Type.Null()]),
    parentItemId: Type.Union([Type.String(), Type.Null()]),
    review: Type.Union([OutcomeReview, Type.Null()]),
  },
  { additionalProperties: false },
);

/** 未通过确定性校验的候选只留在 warnings，不进入可审阅 items。 */
export const OutcomeWarning = Type.Object(
  {
    candidate: Type.Unknown(),
    reason: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const OutcomeError = Type.Object(
  { code: Type.String(), message: Type.String(), at: Type.String() },
  { additionalProperties: false },
);

/** MeetingOutcome 抽取生命周期；处理进度由 Ticket 11 的逐项 Review 派生。 */
export const MeetingOutcomeState = Type.Object(
  {
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("running"),
      Type.Literal("ready"),
      Type.Literal("failed"),
    ]),
    pendingSince: Type.Union([Type.String(), Type.Null()]),
    startedAt: Type.Union([Type.String(), Type.Null()]),
    runId: Type.Union([Type.String(), Type.Null()]),
    previousRunIds: Type.Array(Type.String()),
    error: Type.Union([OutcomeError, Type.Null()]),
    summary: Type.String(),
    items: Type.Array(MeetingOutcomeItem),
    warnings: Type.Array(OutcomeWarning),
    extractedAt: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

/** 危险 Action 的二次确认载荷：`confirmReplace: true` 是服务端可验证的二次确认。 */
export const ReplaceTranscriptRequest = Type.Object(
  { transcript: WarmapTranscript, confirmReplace: Type.Literal(true) },
  { additionalProperties: false },
);

export type TTranscriptSchemaVersion = Static<typeof TranscriptSchemaVersion>;
export type TTranscriptTurn = Static<typeof TranscriptTurn>;
export type TWarmapTranscript = Static<typeof WarmapTranscript>;
export type TStoredTranscript = Static<typeof StoredTranscript>;
export type TOutcomeItemKind = Static<typeof OutcomeItemKind>;
export type TCeoJudgmentKind = Static<typeof CeoJudgmentKind>;
export type TPostMeetingItem = Static<typeof PostMeetingItem>;
export type TPostMeetingCandidate = Static<typeof PostMeetingCandidate>;
export type TOutcomeReviewStatus = Static<typeof OutcomeReviewStatus>;
export type TOutcomeReview = Static<typeof OutcomeReview>;
export type TMeetingOutcomeItem = Static<typeof MeetingOutcomeItem>;
export type TOutcomeWarning = Static<typeof OutcomeWarning>;
export type TOutcomeError = Static<typeof OutcomeError>;
export type TMeetingOutcomeState = Static<typeof MeetingOutcomeState>;
export type TReplaceTranscriptRequest = Static<typeof ReplaceTranscriptRequest>;
