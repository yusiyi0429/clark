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

/** Transcript 来源元数据：只用于追溯，不参与会后抽取；旧 JSON/历史行缺省即合法。 */
export const TranscriptSourceFormat = Type.Union([
  Type.Literal("miaoji_markdown"),
  Type.Literal("warmap_json"),
  /** 会议录音经火山录音文件识别（说话人分离）生成；fileName/sizeBytes/sha256 指规整后的 mp3。 */
  Type.Literal("volc_asr"),
]);

export const TranscriptSource = Type.Object(
  {
    format: TranscriptSourceFormat,
    fileName: Type.String({ minLength: 1, maxLength: 300 }),
    sizeBytes: Type.Integer({ minimum: 1, maximum: 1024 * 1024 * 1024 }),
    sha256: Type.String({ minLength: 1, maxLength: 200 }),
    parserVersion: Type.String({ minLength: 1, maxLength: 50 }),
    /** 绝对时间锚点：妙记为生成 turns 时的 Meeting scheduledAt，volc_asr 为录音开始时刻；无锚点时为 null。 */
    timeAnchor: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
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
    /** 来源留痕；原始 Markdown 不落库，只看正文已进入 turns。 */
    source: Type.Optional(TranscriptSource),
  },
  { additionalProperties: false },
);

/** 候选内单个 turn：只在服务端保存，确认 Action 不回传全量 turns。 */
export const TranscriptCandidateTurn = Type.Object(
  {
    speakerName: Type.String({ minLength: 1, maxLength: 200 }),
    offsetSeconds: Type.Integer({ minimum: 0 }),
    text: Type.String({ minLength: 1, maxLength: 20000 }),
  },
  { additionalProperties: false },
);

/** speaker 映射建议：唯一精确命中人员目录时给出 personId，0 或 ≥2 命中为 null 由 CEO 手选。 */
export const TranscriptCandidateSpeaker = Type.Object(
  {
    speakerName: Type.String({ minLength: 1, maxLength: 200 }),
    turnCount: Type.Integer({ minimum: 1 }),
    suggestedPersonId: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
    suggestedDisplayName: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
  },
  { additionalProperties: false },
);

/** Meeting 内嵌 Candidate Material：完整 turns 只存服务端 JSONB，不是新实体。 */
export const StoredTranscriptCandidate = Type.Object(
  {
    source: TranscriptSource,
    createdAt: Type.String({ minLength: 1 }),
    speakers: Type.Array(TranscriptCandidateSpeaker, { minItems: 1, maxItems: 50 }),
    turns: Type.Array(TranscriptCandidateTurn, { minItems: 1, maxItems: 2000 }),
    warnings: Type.Array(Type.String({ minLength: 1, maxLength: 500 })),
  },
  { additionalProperties: false },
);

/** Card 投影：只给摘要、抽样与映射建议，不含完整 turns。 */
export const TranscriptCandidateProjection = Type.Object(
  {
    source: TranscriptSource,
    createdAt: Type.String({ minLength: 1 }),
    turnCount: Type.Integer({ minimum: 1 }),
    speakerCount: Type.Integer({ minimum: 1 }),
    durationSeconds: Type.Integer({ minimum: 0 }),
    firstOffsetSeconds: Type.Integer({ minimum: 0 }),
    lastOffsetSeconds: Type.Integer({ minimum: 0 }),
    speakers: Type.Array(TranscriptCandidateSpeaker, { minItems: 1, maxItems: 50 }),
    sampleTurns: Type.Array(TranscriptCandidateTurn, { maxItems: 8 }),
    warnings: Type.Array(Type.String({ minLength: 1, maxLength: 500 })),
  },
  { additionalProperties: false },
);

/** CEO 确认候选时的 speaker 映射：覆盖全部唯一 speakerName，personId 必须命中人员目录。 */
export const TranscriptSpeakerMapping = Type.Object(
  {
    speakerName: Type.String({ minLength: 1, maxLength: 200 }),
    personId: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

export const ConfirmTranscriptCandidateRequest = Type.Object(
  {
    speakerMappings: Type.Array(TranscriptSpeakerMapping, { minItems: 1, maxItems: 50 }),
    confirmAddParticipants: Type.Literal(true),
  },
  { additionalProperties: false },
);

export const DiscardTranscriptCandidateRequest = Type.Object({}, { additionalProperties: false });

export const OutcomeItemKind = Type.Union([
  Type.Literal("decision"),
  Type.Literal("todo"),
  Type.Literal("ceoJudgment"),
  Type.Literal("reopenWhen"),
  Type.Literal("open"),
  /** 提给 CEO 拍板的战略议题：CEO 确认后交给本体更新，不同意则通知主持人。 */
  Type.Literal("strategic"),
]);

/** CEO 判断与战略议题只允许五类权限，模型不能自造类别。 */
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
    /** strategic 必填：标题不超过 40 字，说明一两句不超过 120 字。 */
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
    brief: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    /** todo 可选截止日期（YYYY-MM-DD）。 */
    dueDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
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

/** 逐项 Review：open 条目没有 Review。confirmed 记录精确 effectRef 与外发状态。 */
export const HandoffExportStatus = Type.Union([
  Type.Literal("pending_export"),
  Type.Literal("delivered"),
  Type.Literal("failed"),
]);

/** todo 的 DRI Handoff：没有真实渠道回执时只能停在 pending_export，不得显示 delivered。 */
export const OutcomeHandoff = Type.Object(
  {
    exportStatus: HandoffExportStatus,
    exportRef: Type.Union([Type.String(), Type.Null()]),
    error: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

export const OutcomeReview = Type.Object(
  {
    status: OutcomeReviewStatus,
    /** 已推送的 todo 为 `task:<taskId>`，已确认的 strategic 为 `ontology:<requestId>`，其余为 `meeting:<id>:<kind>:<itemId>`。 */
    effectRef: Type.Union([Type.String(), Type.Null()]),
    /** 旧版已确认 todo 的 DRI Handoff；会后推送改为执行事项后不再写入。 */
    handoff: Type.Optional(Type.Union([OutcomeHandoff, Type.Null()])),
    /** reopenWhen 写入的 Radar anchor id。 */
    anchorId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    /** dismiss 原因（含父 decision 被忽略时的 parent_dismissed）。 */
    reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
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
    /** 只有 strategic 带标题与说明；Optional 保证旧 Meeting JSONB 继续可读。 */
    title: Type.Optional(Type.String({ minLength: 1 })),
    brief: Type.Optional(Type.String({ minLength: 1 })),
    /** todo 的截止日期（YYYY-MM-DD）。 */
    dueDate: Type.Optional(Type.String({ minLength: 1 })),
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

/** 逐项处理 Action 的输入；itemId 由确定性 actionId 携带，不重复提交。 */
export const MeetingConfirmItemInput = Type.Object({}, { additionalProperties: false });
export const MeetingDismissItemInput = Type.Object(
  { reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })) },
  { additionalProperties: false },
);
export const MeetingRevokeEffectInput = Type.Object(
  { reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })) },
  { additionalProperties: false },
);

export type TTranscriptSchemaVersion = Static<typeof TranscriptSchemaVersion>;
export type TTranscriptTurn = Static<typeof TranscriptTurn>;
export type TWarmapTranscript = Static<typeof WarmapTranscript>;
export type TTranscriptSourceFormat = Static<typeof TranscriptSourceFormat>;
export type TTranscriptSource = Static<typeof TranscriptSource>;
export type TStoredTranscript = Static<typeof StoredTranscript>;
export type TTranscriptCandidateTurn = Static<typeof TranscriptCandidateTurn>;
export type TTranscriptCandidateSpeaker = Static<typeof TranscriptCandidateSpeaker>;
export type TStoredTranscriptCandidate = Static<typeof StoredTranscriptCandidate>;
export type TTranscriptCandidateProjection = Static<typeof TranscriptCandidateProjection>;
export type TTranscriptSpeakerMapping = Static<typeof TranscriptSpeakerMapping>;
export type TConfirmTranscriptCandidateRequest = Static<typeof ConfirmTranscriptCandidateRequest>;
export type TDiscardTranscriptCandidateRequest = Static<typeof DiscardTranscriptCandidateRequest>;
export type TOutcomeItemKind = Static<typeof OutcomeItemKind>;
export type TCeoJudgmentKind = Static<typeof CeoJudgmentKind>;
export type TPostMeetingItem = Static<typeof PostMeetingItem>;
export type TPostMeetingCandidate = Static<typeof PostMeetingCandidate>;
export type TOutcomeReviewStatus = Static<typeof OutcomeReviewStatus>;
export type THandoffExportStatus = Static<typeof HandoffExportStatus>;
export type TOutcomeHandoff = Static<typeof OutcomeHandoff>;
export type TOutcomeReview = Static<typeof OutcomeReview>;
export type TMeetingConfirmItemInput = Static<typeof MeetingConfirmItemInput>;
export type TMeetingDismissItemInput = Static<typeof MeetingDismissItemInput>;
export type TMeetingRevokeEffectInput = Static<typeof MeetingRevokeEffectInput>;
export type TMeetingOutcomeItem = Static<typeof MeetingOutcomeItem>;
export type TOutcomeWarning = Static<typeof OutcomeWarning>;
export type TOutcomeError = Static<typeof OutcomeError>;
export type TMeetingOutcomeState = Static<typeof MeetingOutcomeState>;
export type TReplaceTranscriptRequest = Static<typeof ReplaceTranscriptRequest>;
