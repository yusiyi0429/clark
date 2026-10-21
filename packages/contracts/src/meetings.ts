import { Type, type Static } from "@sinclair/typebox";
import { MeetingOutcomeState, StoredTranscript, TranscriptCandidateProjection } from "./transcript.js";
import { MeetingAttendees, MeetingDecisionView, MeetingMinutesFailure, MeetingMinutesStatus, PickedWorldAnchor } from "./meetingDecisions.js";
import { RequestPerson } from "./requests.js";

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

/**
 * 预审实际采用的群材料。state：
 * - used：最新有效版本的正文（或其截断部分）已进入本次预审输入；
 * - link_only：外部链接，只给了标题与地址，不代表读过链接内容；
 * - unreadable：这一版没有可读文字（解析失败或空文字层），没有进入输入。
 */
export const PreflightEvidenceMaterialState = Type.Union([
  Type.Literal("used"),
  Type.Literal("link_only"),
  Type.Literal("unreadable"),
]);

export const PreflightEvidenceMaterial = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    objectType: Type.Union([Type.Literal("meeting"), Type.Literal("issue")]),
    objectId: Type.String({ minLength: 1 }),
    fileName: Type.String({ minLength: 1 }),
    format: Type.String({ minLength: 1 }),
    version: Type.Integer({ minimum: 1 }),
    state: PreflightEvidenceMaterialState,
    truncated: Type.Boolean(),
    /** `material:<id>@v<version>`，与 entries.sourceRefs 同一格式。 */
    sourceRef: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** 旧会前材料（meetings.materials）：与同名或同内容的群材料重复时只留群材料最新版。 */
export const PreflightEvidenceLegacyMaterial = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    fileName: Type.String({ minLength: 1 }),
    state: Type.Union([Type.Literal("used"), Type.Literal("duplicate")]),
    duplicateOf: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

/** 本次预审读取的输入快照：材料版本、讨论消息与历史决定，用于追溯与判断报告是否过期。 */
export const PreflightEvidenceRecord = Type.Object(
  {
    collectedAt: Type.String({ minLength: 1 }),
    /** 按谁的权限读取（会议的 CEO 参会人）。 */
    viewerId: Type.String({ minLength: 1 }),
    materials: Type.Array(PreflightEvidenceMaterial),
    legacyMaterials: Type.Array(PreflightEvidenceLegacyMaterial),
    /** 进入输入的群讨论消息 id（thread_messages.id）。 */
    discussionMessageIds: Type.Array(Type.Integer({ minimum: 1 })),
    /** 读取时可见群讨论的最大消息 id；之后出现更大的 id 即有新讨论。 */
    discussionMaxId: Type.Integer({ minimum: 0 }),
    /** 作为约束提供给预审的仍有效历史决定（decision:<id>）。 */
    decisionRefs: Type.Array(Type.String({ minLength: 1 })),
    /** 已撤回/被替代、只供解释变化的历史决定（decision:<id>）。 */
    inactiveDecisionRefs: Type.Array(Type.String({ minLength: 1 })),
    /** 因无权限未读取的对象数（不暴露对象名）。 */
    skippedObjects: Type.Integer({ minimum: 0 }),
    /** 对照的近期会议：共享议题，或同一战场、单元（v4 起）。 */
    relatedMeetings: Type.Optional(Type.Array(Type.Object(
      {
        id: Type.String({ minLength: 1 }),
        title: Type.String({ minLength: 1 }),
        scheduledAt: Type.String({ minLength: 1 }),
        matchedBy: Type.Array(Type.Union([Type.Literal("shared_issue"), Type.Literal("battlefield"), Type.Literal("unit")]), { minItems: 1 }),
        confirmedDecisions: Type.Integer({ minimum: 0 }),
        pendingDecisions: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ), { maxItems: 10 })),
  },
  { additionalProperties: false },
);

export const PreflightInputCoverage = Type.Object(
  {
    background: PreflightInputState,
    purpose: PreflightInputState,
    sourceMaterial: PreflightInputState,
    relatedMeeting: PreflightInputState,
    /** 以下为 H04/H05 扩展字段；Optional 保证旧 Meeting JSONB 继续可读。 */
    groupMaterials: Type.Optional(PreflightInputState),
    discussions: Type.Optional(PreflightInputState),
    decisionHistory: Type.Optional(PreflightInputState),
    evidence: Type.Optional(PreflightEvidenceRecord),
  },
  { additionalProperties: false },
);

/** 投影时计算：报告生成后群材料或讨论发生了变化。不落库。 */
export const PreflightStaleMaterial = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    fileName: Type.String({ minLength: 1 }),
    objectType: Type.Union([Type.Literal("meeting"), Type.Literal("issue")]),
    objectId: Type.String({ minLength: 1 }),
    usedVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    currentVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    change: Type.Union([Type.Literal("updated"), Type.Literal("added"), Type.Literal("removed")]),
  },
  { additionalProperties: false },
);

export const PreflightStaleInputs = Type.Object(
  {
    materials: Type.Array(PreflightStaleMaterial),
    newDiscussionCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/**
 * CEO 级问题（meeting_question / leader_lens）必须说明：为什么现在、为什么需要 CEO、可选路径与影响（feedback 18）。
 * meeting_question 至少给两个选项；leader_lens 是拍板前要 Owner 回答的追问，选项可为空。
 */
export const PreflightCeoOption = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 300 }),
    impact: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  { additionalProperties: false },
);

export const PreflightCeoDecision = Type.Object(
  {
    whyNow: Type.String({ minLength: 1, maxLength: 1000 }),
    whyCeo: Type.String({ minLength: 1, maxLength: 1000 }),
    options: Type.Array(PreflightCeoOption, { maxItems: 4 }),
    delayCost: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
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
    /** 只在 meeting_question / leader_lens 上出现；旧 JSONB 没有。 */
    ceoDecision: Type.Optional(PreflightCeoDecision),
  },
  { additionalProperties: false },
);

export const MeetingPreflightError = Type.Object(
  { code: Type.String(), message: Type.String(), at: Type.String() },
  { additionalProperties: false },
);

/**
 * 材料里自带的待决题（如原稿「管理层讨论问题」）逐条判断：
 * - ceo：需要一号位判断（跨战场资源、战略方向、重大承诺等）；
 * - owner：负责人职责内可以定，不必上升；
 * - monitor：事实还不够，转监测，不阻塞本次讨论。
 */
export const PreflightMaterialQuestionVerdict = Type.Union([
  Type.Literal("ceo"),
  Type.Literal("owner"),
  Type.Literal("monitor"),
]);

export const PreflightMaterialQuestion = Type.Object(
  {
    question: Type.String({ minLength: 1, maxLength: 500 }),
    verdict: PreflightMaterialQuestionVerdict,
    reason: Type.String({ minLength: 1, maxLength: 1000 }),
    sourceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 6 }),
  },
  { additionalProperties: false },
);

/** total 写在 items 之前：模型边写边判断时，界面能显示「第 2 / 5 题」。 */
export const PreflightMaterialQuestions = Type.Object(
  {
    total: Type.Integer({ minimum: 0, maximum: 20 }),
    items: Type.Array(PreflightMaterialQuestion, { maxItems: 20 }),
  },
  { additionalProperties: false },
);

/**
 * 开放分歧的三类（Decision Brief 会前预审卡）：
 * - fact_gap：事实不足，转监测、不阻塞；
 * - judgment：判断分歧，写明已收敛到哪里、还差什么；
 * - value_tradeoff：价值取舍，是剩下需要一号位选的。
 */
export const PreflightDivergenceType = Type.Union([
  Type.Literal("fact_gap"),
  Type.Literal("judgment"),
  Type.Literal("value_tradeoff"),
]);

export const PreflightDivergence = Type.Object(
  {
    type: PreflightDivergenceType,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    body: Type.String({ minLength: 1, maxLength: 2000 }),
    /** 判断分歧已收敛到哪里；其他两类可省略。 */
    converged: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    sourceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 10 }),
  },
  { additionalProperties: false },
);

/**
 * 预审过程中的一步（系统按实际步骤生成，不是估算的百分比）：读取了哪份材料、对照了哪场会、查了哪一节企业知识、
 * 判断到第几道待决题、形成了哪一条结论。key 相同的一步原地更新（如「第 2 / 5 题」→「第 3 / 5 题」）。
 */
export const PreflightProgressStepKind = Type.Union([
  Type.Literal("input"),
  Type.Literal("history"),
  Type.Literal("knowledge"),
  Type.Literal("thinking"),
  Type.Literal("material_question"),
  Type.Literal("finding"),
  Type.Literal("check"),
]);

export const PreflightProgressStep = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 100 }),
    kind: PreflightProgressStepKind,
    label: Type.String({ minLength: 1, maxLength: 300 }),
    detail: Type.Optional(Type.String({ minLength: 1, maxLength: 600 })),
    state: Type.Union([Type.Literal("active"), Type.Literal("done")]),
    /** 这一步第一次出现的时间。 */
    at: Type.String({ minLength: 1 }),
    /** 最近一次更新的时间。 */
    updatedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const PreflightProgress = Type.Object(
  {
    startedAt: Type.String({ minLength: 1 }),
    updatedAt: Type.String({ minLength: 1 }),
    finishedAt: Type.Optional(Type.String({ minLength: 1 })),
    steps: Type.Array(PreflightProgressStep, { maxItems: 80 }),
    /** 推理摘要里最近一条中文思考要点；没有推理摘要时不出现。 */
    thought: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  },
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
    /** 生成期间所用材料/讨论已变化：这份报告从写入起就不是基于最新资料。 */
    inputsChangedDuringRun: Type.Optional(Type.Boolean()),
    /** 投影时计算的过期提示（不落库）：报告所用材料版本或讨论之后又有变化。 */
    staleInputs: Type.Optional(PreflightStaleInputs),
    /** 材料自带待决题的逐条判断与开放分歧（v4 起）；旧报告没有。 */
    materialQuestions: Type.Optional(PreflightMaterialQuestions),
    divergences: Type.Optional(Type.Array(PreflightDivergence, { maxItems: 8 })),
    /** 预审过程：运行中逐步写入，刷新或离开后回来可以接着看；完成或失败后保留。 */
    progress: Type.Optional(PreflightProgress),
    /** 本次预审所用模型与思考强度（运行记录用）。 */
    model: Type.Optional(Type.Object({ id: Type.String({ minLength: 1 }), thinking: Type.String({ minLength: 1 }) }, { additionalProperties: false })),
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

/**
 * 会议录音状态。实际先后：recording（收分片）→ transcoding（拼接 + ffmpeg 转 mp3）→ uploading（传 TOS）
 * → transcribing（火山识别、轮询）→ done（已写成 transcriptCandidate）；任一步失败为 failed，error 写原因。
 */
export const MeetingRecordingStatus = Type.Union([
  Type.Literal("recording"),
  Type.Literal("uploading"),
  Type.Literal("transcoding"),
  Type.Literal("transcribing"),
  Type.Literal("done"),
  Type.Literal("failed"),
]);

/** Meeting Card 上最近一次录音；没有录过为 null。状态变化不 bump Meeting version，进度请轮询单条录音。 */
export const MeetingRecordingSummary = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    status: MeetingRecordingStatus,
    error: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

/** 单条录音：开始、分片、结束与查询接口共用。finishedAt 是结束录音（停止收分片）的时刻。 */
export const MeetingRecording = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    status: MeetingRecordingStatus,
    chunkCount: Type.Integer({ minimum: 0 }),
    error: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ minLength: 1 }),
    finishedAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const StartMeetingRecordingResponse = Type.Object(
  { recordingId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

/** 成员通知栏「会议安排」：我在群里、还没开完的会，按开始时间排（工单 08）。 */
export const MemberMeetingItem = Type.Object(
  {
    meetingId: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    startsAt: Type.String({ minLength: 1 }),
    endsAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    hostName: Type.String({ minLength: 1 }),
    href: Type.String({ minLength: 1 }),
    followUp: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export const MemberMeetingsResponse = Type.Object(
  { meetings: Type.Array(MemberMeetingItem) },
  { additionalProperties: false },
);

/**
 * 天枢建会后自动在飞书约上（用建会的人本人的授权，他是组织者）：pending 排上了 / booked 约上了 / waiting_auth 等他连飞书 /
 * failed 飞书报错（可重试）/ cancelled 会取消了、日程已删。joinUrl 是进入飞书会议的链接；organizerId 是约的人（天枢 person_id）。
 */
export const MeetingFeishuEventStatus = Type.Union([Type.Literal("pending"), Type.Literal("booked"), Type.Literal("waiting_auth"), Type.Literal("failed"), Type.Literal("cancelled")]);
export const MeetingFeishuEvent = Type.Object(
  { status: MeetingFeishuEventStatus, joinUrl: Type.Union([Type.String(), Type.Null()]), organizerId: Type.String() },
  { additionalProperties: false },
);

export const MeetingCardPayload = Type.Object(
  {
    status: MeetingStatus,
    scheduledAt: Type.String(),
    /** 计划结束时间；创建时缺省为开始后 60 分钟。 */
    endsAt: Type.String(),
    /** 「这场会开完了」的时刻；不改变 status，held 仍只表示已有确认的 Transcript。 */
    endedAt: Type.Union([Type.String(), Type.Null()]),
    hasEnded: Type.Optional(Type.Boolean()),
    leadDriId: Type.String(),
    /** 建会的人（没记时为 null，按主持人算）：和主持人一样能再读妙记、贴妙记链接。 */
    createdBy: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ceoParticipantId: Type.String(),
    participants: Type.Array(MeetingParticipant),
    issueIds: Type.Array(Type.String()),
    originRef: Type.Unknown(),
    preflight: MeetingPreflight,
    draft: MeetingDraft,
    materials: Type.Array(MeetingMaterial, { maxItems: 10 }),
    transcript: Type.Union([StoredTranscript, Type.Null()]),
    /** 妙记 Markdown 候选：未确认或已清除时为 null；完整 turns 不进 Card。 */
    transcriptCandidate: Type.Union([TranscriptCandidateProjection, Type.Null()]),
    outcome: Type.Union([MeetingOutcomeState, Type.Null()]),
    recording: Type.Union([MeetingRecordingSummary, Type.Null()]),
    /** 妙记：开完会后等飞书生成（waiting），拿不到时退回手动上传（manual）。 */
    minutesStatus: Type.Optional(MeetingMinutesStatus),
    /** 妙记读取失败（failed）时的原因；其余为 null。 */
    minutesFailure: Type.Optional(Type.Union([MeetingMinutesFailure, Type.Null()])),
    /** 开始等妙记的时刻（waiting、读取失败时记下）；没等过为 null。 */
    minutesWaitingSince: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    /** 自动同步失败、要手动导入会议记录：manual；读取失败且不是原文还没好；开完超过 48 小时还没有逐字稿和候选。 */
    minutesManualImport: Type.Optional(Type.Boolean()),
    /** 实际参会的人（飞书名单；拿不到时是手填的参会人）。 */
    attendees: Type.Optional(MeetingAttendees),
    /** 会后分层确认的「会上定了 X」。 */
    decisions: Type.Optional(Type.Array(MeetingDecisionView)),
    /** 在飞书约上这场会：没配飞书、旧会为 null。 */
    feishuEvent: Type.Optional(Type.Union([MeetingFeishuEvent, Type.Null()])),
  },
  { additionalProperties: false },
);

const PersonId = Type.String({ minLength: 1, maxLength: 200 });
const IsoDateTime = Type.String({ minLength: 1, maxLength: 100 });
const IssueIdList = Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20 });
const ParticipantIds = Type.Array(PersonId, { minItems: 1, maxItems: 50 });

/** Issue Action：从 Issue 新建 scheduled Meeting；endsAt 缺省为开始后 60 分钟。 */
export const CreateMeetingRequest = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    scheduledAt: IsoDateTime,
    endsAt: Type.Optional(IsoDateTime),
    leadDriId: PersonId,
    ceoParticipantId: PersonId,
    participants: ParticipantIds,
    issueIds: IssueIdList,
  },
  { additionalProperties: false },
);

/**
 * 预约建会（POST /api/meetings）：带起止、挂点（1..10）；只存天枢，不写本体。
 * 成员只能给自己建（leadDriId 缺省或等于本人）；CEO 必须从 DRI 里指定主持人。
 */
export const MeetingBookingRequest = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    scheduledAt: IsoDateTime,
    endsAt: IsoDateTime,
    leadDriId: Type.Optional(PersonId),
    participants: Type.Optional(Type.Array(PersonId, { maxItems: 50 })),
    anchors: Type.Array(PickedWorldAnchor, { minItems: 1, maxItems: 10 }),
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

/** 人员名册（CEO 和成员都能读）：只有真人的 personId 和名字，约会议选参会人用；同传话起草里的 directory。 */
export const PersonDirectoryResponse = Type.Object({ people: Type.Array(RequestPerson, { maxItems: 200 }) }, { additionalProperties: false });

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

/** Meeting Action：编辑会议基本字段（至少一项）；仅 scheduled 可执行，换 lead 时同步 participants；只改 scheduledAt 时保持原时长。 */
export const EditMeetingDetailsRequest = Type.Object(
  {
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    scheduledAt: Type.Optional(IsoDateTime),
    endsAt: Type.Optional(IsoDateTime),
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
    endsAt: Type.Optional(IsoDateTime),
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
    /** 材料自带待决题逐条判断；材料没有自带待决题时 total 为 0、items 为空。写在 entries 之前。 */
    materialQuestions: Type.Optional(PreflightMaterialQuestions),
    entries: Type.Array(
      Type.Object(
        {
          kind: PreflightReviewEntryKind,
          title: Type.String({ minLength: 1, maxLength: 200 }),
          body: Type.String({ minLength: 1, maxLength: 4000 }),
          sourceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 10 }),
          /** meeting_question / leader_lens 必填（服务端校验）；其他类别忽略。 */
          ceoDecision: Type.Optional(PreflightCeoDecision),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 20 },
    ),
    /** 开放分歧按三类写；没有分歧时为空数组或省略。 */
    divergences: Type.Optional(Type.Array(PreflightDivergence, { maxItems: 8 })),
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
export type TPreflightEvidenceMaterial = Static<typeof PreflightEvidenceMaterial>;
export type TPreflightEvidenceLegacyMaterial = Static<typeof PreflightEvidenceLegacyMaterial>;
export type TPreflightEvidenceRecord = Static<typeof PreflightEvidenceRecord>;
export type TPreflightStaleMaterial = Static<typeof PreflightStaleMaterial>;
export type TPreflightStaleInputs = Static<typeof PreflightStaleInputs>;
export type TPreflightCeoOption = Static<typeof PreflightCeoOption>;
export type TPreflightCeoDecision = Static<typeof PreflightCeoDecision>;
export type TPreflightTaskDefinition = Static<typeof PreflightTaskDefinition>;
export type TPreflightSummary = Static<typeof PreflightSummary>;
export type TMeetingPreflightEntry = Static<typeof MeetingPreflightEntry>;
export type TMeetingPreflight = Static<typeof MeetingPreflight>;
export type TPreflightMaterialQuestion = Static<typeof PreflightMaterialQuestion>;
export type TPreflightMaterialQuestions = Static<typeof PreflightMaterialQuestions>;
export type TPreflightDivergence = Static<typeof PreflightDivergence>;
export type TPreflightProgressStep = Static<typeof PreflightProgressStep>;
export type TPreflightProgress = Static<typeof PreflightProgress>;
export type TSupplementExportStatus = Static<typeof SupplementExportStatus>;
export type TSupplementRequest = Static<typeof SupplementRequest>;
export type TMeetingDraft = Static<typeof MeetingDraft>;
export type TMeetingMaterial = Static<typeof MeetingMaterial>;
export type TMeetingRecordingStatus = Static<typeof MeetingRecordingStatus>;
export type TMeetingRecordingSummary = Static<typeof MeetingRecordingSummary>;
export type TMeetingRecording = Static<typeof MeetingRecording>;
export type TStartMeetingRecordingResponse = Static<typeof StartMeetingRecordingResponse>;
export type TMeetingCardPayload = Static<typeof MeetingCardPayload>;
export type TMeetingFeishuEvent = Static<typeof MeetingFeishuEvent>;
export type TCreateMeetingRequest = Static<typeof CreateMeetingRequest>;
export type TMeetingBookingRequest = Static<typeof MeetingBookingRequest>;
export type TPersonDirectoryResponse = Static<typeof PersonDirectoryResponse>;
export type TJoinMeetingRequest = Static<typeof JoinMeetingRequest>;
export type TUpdateMeetingDraftRequest = Static<typeof UpdateMeetingDraftRequest>;
export type TRequestSupplementRequest = Static<typeof RequestSupplementRequest>;
export type TDriMeetingImportRequest = Static<typeof DriMeetingImportRequest>;
export type TPreflightCandidate = Static<typeof PreflightCandidate>;
