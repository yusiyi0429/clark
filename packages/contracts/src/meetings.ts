import { Type, type Static } from "@sinclair/typebox";
import { MeetingOutcomeState, StoredTranscript } from "./transcript.js";

export const MeetingStatus = Type.Union([
  Type.Literal("scheduled"),
  Type.Literal("held"),
  Type.Literal("reviewed"),
  Type.Literal("cancelled"),
]);

/** 创建时保存的身份快照：personId 稳定，展示名和角色只是当时属性。 */
export const MeetingParticipant = Type.Object(
  {
    personId: Type.String({ minLength: 1 }),
    displayName: Type.String({ minLength: 1 }),
    roles: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    sourceRef: Type.String({ minLength: 1 }),
    updatedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** advisor-review 后端场景的七段会前预审；旧三类保留用于历史 Meeting 展示。 */
export const PreflightReviewEntryKind = Type.Union([
  Type.Literal("core_judgment"),
  Type.Literal("strategic_alignment"),
  Type.Literal("positive_signal"),
  Type.Literal("risk_calibration"),
  Type.Literal("meeting_question"),
  Type.Literal("next_step"),
  Type.Literal("leader_lens"),
]);

export const MeetingPreflightEntryKind = Type.Union([
  Type.Literal("agenda"),
  Type.Literal("evidence"),
  Type.Literal("open_question"),
  Type.Literal("core_judgment"),
  Type.Literal("strategic_alignment"),
  Type.Literal("positive_signal"),
  Type.Literal("risk_calibration"),
  Type.Literal("meeting_question"),
  Type.Literal("next_step"),
  Type.Literal("leader_lens"),
]);

export const PreflightReadiness = Type.Union([
  Type.Literal("ready"),
  Type.Literal("revise"),
  Type.Literal("blocked"),
]);

export const PreflightInputState = Type.Union([
  Type.Literal("available"),
  Type.Literal("derived"),
  Type.Literal("missing"),
]);

export const PreflightInputCoverage = Type.Object(
  {
    background: PreflightInputState,
    purpose: PreflightInputState,
    sourceMaterial: PreflightInputState,
    relatedMeeting: PreflightInputState,
  },
  { additionalProperties: false },
);

export const PreflightMaterialRole = Type.Union([
  Type.Literal("strategic_judgment"),
  Type.Literal("standard_method"),
  Type.Literal("client_proposal"),
  Type.Literal("project_plan"),
  Type.Literal("commercial_terms"),
  Type.Literal("owner_status"),
  Type.Literal("research_analysis"),
  Type.Literal("meeting_record"),
  Type.Literal("daily_communication"),
]);

export const PreflightMaturity = Type.Union([
  Type.Literal("exploration"),
  Type.Literal("modeling"),
  Type.Literal("internal_alignment"),
  Type.Literal("client_discussion"),
  Type.Literal("commercial_decision"),
  Type.Literal("signing"),
  Type.Literal("implementation"),
  Type.Literal("retrospective"),
]);

export const PreflightTaskDefinition = Type.Object(
  {
    materialPurpose: Type.String({ minLength: 1, maxLength: 1000 }),
    reviewPurpose: Type.String({ minLength: 1, maxLength: 1000 }),
    primaryRole: PreflightMaterialRole,
    secondaryRole: Type.Union([PreflightMaterialRole, Type.Null()]),
    maturity: PreflightMaturity,
    readerAction: Type.String({ minLength: 1, maxLength: 1000 }),
    nonGoal: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  { additionalProperties: false },
);

export const PreflightSummary = Type.Object(
  {
    criticalIssue: Type.String({ minLength: 1, maxLength: 1000 }),
    priorityAction: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  { additionalProperties: false },
);

export const MeetingPreflightEntry = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    kind: MeetingPreflightEntryKind,
    title: Type.String({ minLength: 1 }),
    body: Type.String({ minLength: 1 }),
    sourceRefs: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const MeetingPreflightError = Type.Object(
  { code: Type.String(), message: Type.String(), at: Type.String() },
  { additionalProperties: false },
);

export const MeetingPreflight = Type.Object(
  {
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("running"),
      Type.Literal("ready"),
      Type.Literal("failed"),
    ]),
    pendingSince: Type.Union([Type.String(), Type.Null()]),
    runId: Type.Union([Type.String(), Type.Null()]),
    entries: Type.Array(MeetingPreflightEntry),
    basis: Type.String(),
    brief: Type.String(),
    error: Type.Union([MeetingPreflightError, Type.Null()]),
    generatedAt: Type.Union([Type.String(), Type.Null()]),
    /** 新版 advisor-review 场景字段；Optional 保证旧 Meeting JSONB 继续可读。 */
    inputCoverage: Type.Optional(PreflightInputCoverage),
    taskDefinition: Type.Optional(PreflightTaskDefinition),
    readiness: Type.Optional(PreflightReadiness),
    summary: Type.Optional(PreflightSummary),
  },
  { additionalProperties: false },
);

/** 没有真实渠道回执时只能停在 pending_export，不得显示 delivered。 */
export const SupplementExportStatus = Type.Union([
  Type.Literal("recorded"),
  Type.Literal("pending_export"),
  Type.Literal("delivered"),
  Type.Literal("failed"),
]);

export const SupplementRequest = Type.Object(
  {
    id: Type.String(),
    entryId: Type.Union([Type.String(), Type.Null()]),
    targetDriId: Type.String(),
    text: Type.String(),
    exportStatus: SupplementExportStatus,
    exportRef: Type.Union([Type.String(), Type.Null()]),
    error: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String(),
  },
  { additionalProperties: false },
);

export const MeetingDraft = Type.Object(
  {
    readIssueIds: Type.Array(Type.String()),
    carriedIssueIds: Type.Array(Type.String()),
    checkedEntryIds: Type.Array(Type.String()),
    editsByEntryId: Type.Record(Type.String(), Type.String()),
    supplementRequests: Type.Array(SupplementRequest),
    note: Type.String(),
  },
  { additionalProperties: false },
);

export const MeetingMaterial = Type.Object(
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
    receivedBy: Type.String({ minLength: 1 }),
    providedBy: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    uploadedAt: Type.String({ minLength: 1 }),
    /** 补充材料文件组：缺省 = primary（旧 JSONB 行即 primary，无迁移）；supplement 必须指向已记录的外发请求。 */
    kind: Type.Optional(Type.Union([Type.Literal("primary"), Type.Literal("supplement")])),
    supplementFor: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const MeetingCardPayload = Type.Object(
  {
    status: MeetingStatus,
    scheduledAt: Type.String(),
    leadDriId: Type.String(),
    ceoParticipantId: Type.String(),
    participants: Type.Array(MeetingParticipant),
    issueIds: Type.Array(Type.String()),
    originRef: Type.Unknown(),
    preflight: MeetingPreflight,
    draft: MeetingDraft,
    materials: Type.Array(MeetingMaterial, { maxItems: 10 }),
    transcript: Type.Union([StoredTranscript, Type.Null()]),
    outcome: Type.Union([MeetingOutcomeState, Type.Null()]),
  },
  { additionalProperties: false },
);

const PersonId = Type.String({ minLength: 1, maxLength: 200 });
const IsoDateTime = Type.String({ minLength: 1, maxLength: 100 });
const IssueIdList = Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20 });
const ParticipantIds = Type.Array(PersonId, { minItems: 1, maxItems: 50 });

/** Issue Action：从 Issue 新建 scheduled Meeting。 */
export const CreateMeetingRequest = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    scheduledAt: IsoDateTime,
    leadDriId: PersonId,
    ceoParticipantId: PersonId,
    participants: ParticipantIds,
    issueIds: IssueIdList,
  },
  { additionalProperties: false },
);

/** Issue Action：把当前 Issue 加入已有 scheduled Meeting。 */
export const JoinMeetingRequest = Type.Object(
  { meetingId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

/** CEO 端只读人员目录：Meeting 创建表单选择 personId；单 CEO 产品，ceo 角色唯一。 */
export const PeopleDirectoryResponse = Type.Object(
  {
    people: Type.Array(
      Type.Object({
        personId: Type.String({ minLength: 1, maxLength: 200 }),
        displayName: Type.String({ minLength: 1, maxLength: 200 }),
        roles: Type.Array(Type.String({ minLength: 1, maxLength: 50 }), { maxItems: 10 }),
      }),
      { maxItems: 200 },
    ),
  },
  { additionalProperties: false },
);

export const UpdateMeetingDraftRequest = Type.Object(
  {
    readIssueIds: Type.Optional(Type.Array(Type.String())),
    carriedIssueIds: Type.Optional(Type.Array(Type.String())),
    checkedEntryIds: Type.Optional(Type.Array(Type.String())),
    editsByEntryId: Type.Optional(Type.Record(Type.String(), Type.String())),
    note: Type.Optional(Type.String({ maxLength: 5000 })),
  },
  { additionalProperties: false },
);

/** Meeting Action：编辑会议基本字段（至少一项）；仅 scheduled 可执行，换 lead 时同步 participants。 */
export const EditMeetingDetailsRequest = Type.Object(
  {
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    scheduledAt: Type.Optional(IsoDateTime),
    leadDriId: Type.Optional(PersonId),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const RequestSupplementRequest = Type.Object(
  {
    entryId: Type.Optional(Type.String({ minLength: 1 })),
    targetDriId: PersonId,
    text: Type.String({ minLength: 1, maxLength: 2000 }),
  },
  { additionalProperties: false },
);

/** DRI 服务导入 Meeting 元数据；issueIds 必须是已存在的 Issue。 */
export const DriMeetingImportRequest = Type.Object(
  {
    externalId: Type.String({ minLength: 1, maxLength: 200 }),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    scheduledAt: IsoDateTime,
    leadDriId: PersonId,
    ceoParticipantId: PersonId,
    participants: ParticipantIds,
    issueIds: IssueIdList,
  },
  { additionalProperties: false },
);

/** Preflight Agent 的唯一结构化输出；散文不进入 Meeting。 */
export const PreflightCandidate = Type.Object(
  {
    taskDefinition: PreflightTaskDefinition,
    readiness: PreflightReadiness,
    entries: Type.Array(
      Type.Object(
        {
          kind: PreflightReviewEntryKind,
          title: Type.String({ minLength: 1, maxLength: 200 }),
          body: Type.String({ minLength: 1, maxLength: 4000 }),
          sourceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 10 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 20 },
    ),
    basis: Type.String({ minLength: 1, maxLength: 4000 }),
    brief: Type.String({ minLength: 1, maxLength: 4000 }),
    summary: PreflightSummary,
  },
  { additionalProperties: false },
);

export type TMeetingStatus = Static<typeof MeetingStatus>;
export type TMeetingParticipant = Static<typeof MeetingParticipant>;
export type TPreflightReviewEntryKind = Static<typeof PreflightReviewEntryKind>;
export type TMeetingPreflightEntryKind = Static<typeof MeetingPreflightEntryKind>;
export type TPreflightInputCoverage = Static<typeof PreflightInputCoverage>;
export type TPreflightTaskDefinition = Static<typeof PreflightTaskDefinition>;
export type TPreflightSummary = Static<typeof PreflightSummary>;
export type TMeetingPreflightEntry = Static<typeof MeetingPreflightEntry>;
export type TMeetingPreflight = Static<typeof MeetingPreflight>;
export type TSupplementExportStatus = Static<typeof SupplementExportStatus>;
export type TSupplementRequest = Static<typeof SupplementRequest>;
export type TMeetingDraft = Static<typeof MeetingDraft>;
export type TMeetingMaterial = Static<typeof MeetingMaterial>;
export type TMeetingCardPayload = Static<typeof MeetingCardPayload>;
export type TCreateMeetingRequest = Static<typeof CreateMeetingRequest>;
export type TJoinMeetingRequest = Static<typeof JoinMeetingRequest>;
export type TUpdateMeetingDraftRequest = Static<typeof UpdateMeetingDraftRequest>;
export type TRequestSupplementRequest = Static<typeof RequestSupplementRequest>;
export type TDriMeetingImportRequest = Static<typeof DriMeetingImportRequest>;
export type TPreflightCandidate = Static<typeof PreflightCandidate>;
