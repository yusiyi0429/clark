import { Type, type Static } from "@sinclair/typebox";

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

export const MeetingPreflightEntryKind = Type.Union([
  Type.Literal("agenda"),
  Type.Literal("evidence"),
  Type.Literal("open_question"),
]);

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
    entries: Type.Array(
      Type.Object(
        {
          kind: MeetingPreflightEntryKind,
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
  },
  { additionalProperties: false },
);

export type TMeetingStatus = Static<typeof MeetingStatus>;
export type TMeetingParticipant = Static<typeof MeetingParticipant>;
export type TMeetingPreflightEntryKind = Static<typeof MeetingPreflightEntryKind>;
export type TMeetingPreflightEntry = Static<typeof MeetingPreflightEntry>;
export type TMeetingPreflight = Static<typeof MeetingPreflight>;
export type TSupplementExportStatus = Static<typeof SupplementExportStatus>;
export type TSupplementRequest = Static<typeof SupplementRequest>;
export type TMeetingDraft = Static<typeof MeetingDraft>;
export type TMeetingCardPayload = Static<typeof MeetingCardPayload>;
export type TCreateMeetingRequest = Static<typeof CreateMeetingRequest>;
export type TJoinMeetingRequest = Static<typeof JoinMeetingRequest>;
export type TUpdateMeetingDraftRequest = Static<typeof UpdateMeetingDraftRequest>;
export type TRequestSupplementRequest = Static<typeof RequestSupplementRequest>;
export type TDriMeetingImportRequest = Static<typeof DriMeetingImportRequest>;
export type TPreflightCandidate = Static<typeof PreflightCandidate>;
