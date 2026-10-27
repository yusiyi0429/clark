import { Type, type Static } from "@sinclair/typebox";

/**
 * 会议卡（FR-4、FR-5）：会议 Card 与会议 Event 共用一份 MeetingCardV1Payload（schemaVersion meeting-card.v1）。
 *   规格里叫 MeetingCardPayload；这个名字已被 Card 信封里会议卡的 payload（meetings.ts）占用，这里带上版本号区分。
 * - 草稿（MeetingCardDraft = payload 去掉 revision）存天枢，主持人或创建人带 draftVersion 编辑；整卡确认后冻结成确认版本、写进本体。
 * - 模型只填摘要、正文段落、拟修改内容和行动项；身份、ID、版本、来源摘要值、时间和对象原内容由服务填写或核验。
 * - 行动项是天枢本地的：不进 payload、不写本体、不参与 payloadHash（拍板 4）。
 */
export const MeetingCardSchemaVersion = Type.Literal("meeting-card.v1");
/** 服务生成的稳定 ID（sec-N、chg-N、act-N、src-N；用户新加的项由前端给）。也用在对象修改的幂等键里，只收安全字符。 */
const CardItemId = Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" });
const NullableString = (options: { minLength?: number; maxLength?: number; pattern?: string } = {}) => Type.Union([Type.String(options), Type.Null()]);

/** 来源：飞书妙记或天枢会议页的逐字稿。contentHash 是原文全文的摘要值（只统一换行，UTF-8 SHA-256 hex）。 */
export const MeetingSource = Type.Object(
  {
    id: CardItemId,
    url: Type.String({ minLength: 1, maxLength: 2000 }),
    title: Type.String({ minLength: 1, maxLength: 300 }),
    contentHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    sourceVersion: NullableString({ minLength: 1, maxLength: 200 }),
    capturedAt: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { additionalProperties: false },
);
/** 段落出处：sourceId 必须在 sources 里；locator 是逐字稿发言段区间（如 turn-0012..turn-0015），定位不了时为 null。 */
export const MeetingCardSourceRef = Type.Object(
  { sourceId: Type.String({ minLength: 1, maxLength: 64 }), locator: NullableString({ minLength: 1, maxLength: 500 }) },
  { additionalProperties: false },
);
/** 按议题组织的一段正文；用户补充而无原文时 sourceRefs 为空数组。 */
export const MeetingCardSection = Type.Object(
  {
    id: CardItemId,
    heading: Type.String({ minLength: 1, maxLength: 200 }),
    body: Type.String({ minLength: 1, maxLength: 20000 }),
    sourceRefs: Type.Array(MeetingCardSourceRef, { maxItems: 50 }),
  },
  { additionalProperties: false },
);
/**
 * 对本体对象的一处修改：只支持文本组件（拍板 5）。targetRef 是「<对象 id>#<块 id>/<组件 id>」，null 表示目标未定（不能提交）；
 * before、expectedVersion、targetTitle 由服务按对象当前内容填。冻结 payload 里的修改就是这些字段（MeetingConfirmedObjectChange）。
 */
const objectChangeFields = {
  id: CardItemId,
  targetRef: NullableString({ minLength: 1, maxLength: 500 }),
  targetTitle: NullableString({ maxLength: 500 }),
  expectedVersion: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  before: Type.Union([Type.Object({ text: Type.String() }, { additionalProperties: false }), Type.Null()]),
  after: Type.Object({ text: Type.String({ minLength: 1, maxLength: 20000 }) }, { additionalProperties: false }),
  basisSectionIds: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 50 }),
};
export const MeetingConfirmedObjectChange = Type.Object(objectChangeFields, { additionalProperties: false });
/** 草稿里的修改多一个 stale：读卡时发现目标变过、差异已刷新（确认时清掉，不进冻结 payload）。 */
export const MeetingObjectChange = Type.Object({ ...objectChangeFields, stale: Type.Boolean() }, { additionalProperties: false });
export const MeetingCardParticipant = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 200 }), personRef: NullableString({ minLength: 1, maxLength: 200 }) },
  { additionalProperties: false },
);
const payloadFields = {
  schemaVersion: MeetingCardSchemaVersion,
  meetingId: Type.String({ minLength: 1, maxLength: 200 }),
  title: Type.String({ minLength: 1, maxLength: 300 }),
  /** 会议实际开始（ISO，带时区）；没有就 null，确认前要填。 */
  occurredAt: NullableString({ minLength: 1, maxLength: 100 }),
  participants: Type.Array(MeetingCardParticipant, { maxItems: 200 }),
  /** 挂点对象的本体 id。 */
  relatedObjectRefs: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 50 }),
  summary: Type.String({ maxLength: 4000 }),
  sections: Type.Array(MeetingCardSection, { minItems: 1, maxItems: 100 }),
  sources: Type.Array(MeetingSource, { minItems: 1, maxItems: 20 }),
};
/** 冻结的确认版本：relatedObjectRefs 是确认时的 <对象 id>@<版本>，修改不带 stale。 */
export const MeetingCardV1Payload = Type.Object(
  { ...payloadFields, objectChanges: Type.Array(MeetingConfirmedObjectChange, { maxItems: 50 }), revision: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
export const MeetingCardDraft = Type.Object({ ...payloadFields, objectChanges: Type.Array(MeetingObjectChange, { maxItems: 50 }) }, { additionalProperties: false });

/** 天枢本地的行动项（拍板 4）：会上明确分给某人的待办；整卡确认后没推过的推成执行事项，taskId 回填（只由服务改）。 */
export const MeetingActionItem = Type.Object(
  {
    id: CardItemId,
    text: Type.String({ minLength: 1, maxLength: 300 }),
    ownerPersonId: NullableString({ minLength: 1, maxLength: 200 }),
    dueDate: NullableString({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    basisSectionIds: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 50 }),
    taskId: NullableString({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);
/** 挂点对象里有文字的组件（修改只能定到这些上）。 */
export const MeetingCardTargetOption = Type.Object(
  {
    targetRef: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    componentType: Type.String({ minLength: 1 }),
    text: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
/** 确认版本的类别：首次写入、更正原记录、会后新决定。 */
export const MeetingCardKind = Type.Union([Type.Literal("first"), Type.Literal("correction"), Type.Literal("followup")]);
export const MeetingCardConfirmation = Type.Object(
  {
    revision: Type.Integer({ minimum: 1 }),
    confirmedBy: Type.String({ minLength: 1 }),
    confirmedAt: Type.String({ minLength: 1 }),
    payloadHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  },
  { additionalProperties: false },
);
export const MeetingObjectResult = Type.Object(
  {
    changeId: Type.String({ minLength: 1 }),
    title: Type.String(),
    status: Type.Union([
      Type.Literal("pending"), Type.Literal("updated"), Type.Literal("failed"), Type.Literal("not_allowed"),
      Type.Literal("conflict"), Type.Literal("superseded"), Type.Literal("blocked"),
    ]),
    actualVersion: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    error: NullableString(),
  },
  { additionalProperties: false },
);
/** 同步回执：会议事件和对象修改各自的结果；状态变化不改写已冻结的 payload。 */
export const MeetingCardSync = Type.Object(
  {
    revision: Type.Integer({ minimum: 1 }),
    writeToWorld: Type.Boolean(),
    event: Type.Object(
      {
        status: Type.Union([Type.Literal("pending"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("skipped")]),
        eventId: NullableString(),
        error: NullableString(),
      },
      { additionalProperties: false },
    ),
    objects: Type.Array(MeetingObjectResult),
  },
  { additionalProperties: false },
);
/** 草稿和当前确认版比：content 会议内容改了（确认出新版本、要选修改原因）；items 只改了行动项（确认不出新版本）；none 没改或还没有确认版。 */
export const MeetingDraftChange = Type.Union([Type.Literal("none"), Type.Literal("items"), Type.Literal("content")]);
export const MeetingCardDraftStatus = Type.Union([Type.Literal("created"), Type.Literal("draft_ready")]);

/** GET /api/meetings/:id/card：主持人、创建人、CEO、实际参会人能读；targetOptions 只给能编辑的人。 */
export const MeetingCardView = Type.Object(
  {
    draft: Type.Union([MeetingCardDraft, Type.Null()]),
    draftVersion: Type.Integer({ minimum: 0 }),
    draftStatus: MeetingCardDraftStatus,
    actionItems: Type.Array(MeetingActionItem),
    confirmed: Type.Union([
      Type.Object(
        // actionItems：这次确认时的行动项快照（不进 payload，推成执行事项后带 taskId）。
        { payload: MeetingCardV1Payload, confirmation: MeetingCardConfirmation, kind: MeetingCardKind, actionItems: Type.Array(MeetingActionItem) },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    sync: Type.Union([MeetingCardSync, Type.Null()]),
    targetOptions: Type.Array(MeetingCardTargetOption),
    canEdit: Type.Boolean(),
    draftChange: MeetingDraftChange,
    /** 逐字稿里还没对上人的说话人（只给主持人和创建人；选过「不是天枢里的人」的不列）：在会议卡上指定是谁。 */
    unmappedSpeakers: Type.Array(Type.Object({ id: Type.String(), name: Type.String() }, { additionalProperties: false })),
  },
  { additionalProperties: false },
);

/** 在会议卡上指定说话人：personId 是对到的人；null 是「不是天枢里的人」，保留原名。 */
export const MeetingCardSpeakerRequest = Type.Object(
  {
    draftVersion: Type.Integer({ minimum: 0 }),
    speakerId: Type.String({ pattern: "^speaker:\\d+$", maxLength: 50 }),
    personId: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
  },
  { additionalProperties: false },
);

/**
 * PUT /api/meetings/:id/card/draft：整份替换草稿（只有主持人或创建人）。服务按挂点对象重读每处修改的 before、expectedVersion、targetTitle，
 * 来源、挂点、meetingId 以服务为准；前端传的 stale、taskId 忽略。draftVersion 不是当前的 409 DRAFT_CHANGED（带 view）；校验不过 400，fieldErrors 按字段路径。
 */
export const MeetingCardDraftRequest = Type.Object(
  {
    draftVersion: Type.Integer({ minimum: 0 }),
    draft: MeetingCardDraft,
    actionItems: Type.Optional(Type.Array(MeetingActionItem, { maxItems: 100 })),
  },
  { additionalProperties: false },
);

/**
 * POST /api/meetings/:id/card/confirm：主持人或创建人整卡确认。draftVersion 不是当前的 409 DRAFT_CHANGED（带 view）；
 * 同一草稿版本再确认不出新版本。已有确认版时 kind 必填（correction 更正原记录 / followup 会后新决定），第一次确认忽略 kind。
 */
export const MeetingCardConfirmRequest = Type.Object(
  {
    draftVersion: Type.Integer({ minimum: 0 }),
    writeToWorld: Type.Boolean(),
    kind: Type.Optional(Type.Union([Type.Literal("correction"), Type.Literal("followup")])),
    reason: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);

/**
 * 会后生成卡片的模型输出（只能调用 submit_candidate）：模型只填摘要、按议题的正文段落（带引用的发言段 turnId）、
 * 从候选目标里选的修改（after 文字和依据段落序号，从 1 开始）、会上明确分给某人的行动项。
 */
export const MeetingCardCandidate = Type.Object(
  {
    summary: Type.String({ minLength: 1, maxLength: 4000 }),
    sections: Type.Array(
      Type.Object(
        {
          heading: Type.String({ minLength: 1, maxLength: 200 }),
          body: Type.String({ minLength: 1, maxLength: 20000 }),
          turnIds: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 200 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 100 },
    ),
    objectChanges: Type.Array(
      Type.Object(
        {
          targetRef: Type.String({ minLength: 1, maxLength: 500 }),
          after: Type.Object({ text: Type.String({ minLength: 1, maxLength: 20000 }) }, { additionalProperties: false }),
          basisSections: Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 50 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 50 },
    ),
    actionItems: Type.Array(
      Type.Object(
        {
          text: Type.String({ minLength: 1, maxLength: 300 }),
          ownerPersonId: NullableString({ minLength: 1, maxLength: 200 }),
          dueDate: NullableString({ maxLength: 20 }),
          basisSections: Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 50 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 100 },
    ),
  },
  { additionalProperties: false },
);

export type TMeetingSource = Static<typeof MeetingSource>;
export type TMeetingCardSourceRef = Static<typeof MeetingCardSourceRef>;
export type TMeetingCardSection = Static<typeof MeetingCardSection>;
export type TMeetingObjectChange = Static<typeof MeetingObjectChange>;
export type TMeetingConfirmedObjectChange = Static<typeof MeetingConfirmedObjectChange>;
export type TMeetingCardV1Payload = Static<typeof MeetingCardV1Payload>;
export type TMeetingCardDraft = Static<typeof MeetingCardDraft>;
export type TMeetingActionItem = Static<typeof MeetingActionItem>;
export type TMeetingCardTargetOption = Static<typeof MeetingCardTargetOption>;
export type TMeetingCardKind = Static<typeof MeetingCardKind>;
export type TMeetingCardConfirmation = Static<typeof MeetingCardConfirmation>;
export type TMeetingObjectResult = Static<typeof MeetingObjectResult>;
export type TMeetingCardSync = Static<typeof MeetingCardSync>;
export type TMeetingCardView = Static<typeof MeetingCardView>;
export type TMeetingDraftChange = Static<typeof MeetingDraftChange>;
export type TMeetingCardDraftRequest = Static<typeof MeetingCardDraftRequest>;
export type TMeetingCardSpeakerRequest = Static<typeof MeetingCardSpeakerRequest>;
export type TMeetingCardConfirmRequest = Static<typeof MeetingCardConfirmRequest>;
export type TMeetingCardCandidate = Static<typeof MeetingCardCandidate>;
