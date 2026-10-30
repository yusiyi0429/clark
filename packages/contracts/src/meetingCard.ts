import { Type, type Static } from "@sinclair/typebox";

/**
 * 会议卡（FR-4、FR-5）：会议 Card 与会议 Event 共用一份冻结 payload（MeetingCardFrozenPayload）。
 * - 草稿（MeetingCardDraft = payload 去掉 revision）存天枢，主持人或创建人带 draftVersion 编辑。
 * - 模型只填摘要、正文段落、决策、拟修改内容和行动项；身份、ID、版本、来源摘要值、时间和对象原内容由服务填写或核验。
 * - 10/28 起（meeting-card.v2）：记录正文不用确认；会上提取的决策和行动项逐条只由责任人本人确认，不能代确认。没有负责人的行动项由主持人确认；
 *   没有责任人的决策由主持人在参会人里补归属，再由那个人确认（10/29）。
 *   决策都有了结果或会议卡生成满 48 小时，冻结一版：只放已确认的决策和行动项（各带确认人），不带对象修改，写一条会议事件。
 * - v1（10/28 之前）：主持人整卡确认，行动项不进 payload。
 */
export const MeetingCardSchemaVersion = Type.Literal("meeting-card.v1");
export const MeetingCardFrozenSchemaVersion = Type.Union([Type.Literal("meeting-card.v1"), Type.Literal("meeting-card.v2")]);
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
/**
 * 逐条确认（决策和行动项共用，只由服务改）：pending 待确认、confirmed 确认（行动项是「接下」）、rejected 不对（行动项是「退回」，reason 必填）。
 * by 是点的人（personId），就是责任人本人（没有负责人的行动项是主持人）。
 */
export const MeetingItemReview = Type.Object(
  {
    status: Type.Union([Type.Literal("pending"), Type.Literal("confirmed"), Type.Literal("rejected")]),
    by: NullableString({ minLength: 1, maxLength: 200 }),
    at: NullableString({ minLength: 1, maxLength: 100 }),
    reason: NullableString({ maxLength: 200 }),
  },
  { additionalProperties: false },
);
/**
 * 会上提取的一条决策（天枢本地，存在会议卡上）：text 是决策本身（一句话）；ownerPersonId 是会上明确的责任人（这场会的人），
 * 没有就由主持人确认；basisSectionIds 是出处段落。
 */
export const MeetingCardDecision = Type.Object(
  {
    id: CardItemId,
    text: Type.String({ minLength: 1, maxLength: 300 }),
    ownerPersonId: NullableString({ minLength: 1, maxLength: 200 }),
    basisSectionIds: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 50 }),
    review: MeetingItemReview,
  },
  { additionalProperties: false },
);
/** 冻结进 payload 的一条（只有已确认的）：确认人、确认时刻；sourceRefs 是出处段落在原文里的位置（不带正文时也能找到出处）。 */
const frozenReviewFields = {
  confirmedBy: Type.String({ minLength: 1, maxLength: 200 }),
  confirmedAt: Type.String({ minLength: 1, maxLength: 100 }),
  sourceRefs: Type.Array(MeetingCardSourceRef, { maxItems: 100 }),
};
export const MeetingFrozenDecision = Type.Object(
  {
    id: CardItemId,
    text: Type.String({ minLength: 1, maxLength: 300 }),
    ownerPersonId: NullableString({ minLength: 1, maxLength: 200 }),
    basisSectionIds: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 50 }),
    ...frozenReviewFields,
  },
  { additionalProperties: false },
);
export const MeetingFrozenActionItem = Type.Object(
  {
    id: CardItemId,
    text: Type.String({ minLength: 1, maxLength: 300 }),
    ownerPersonId: NullableString({ minLength: 1, maxLength: 200 }),
    dueDate: NullableString({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    basisSectionIds: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 50 }),
    ...frozenReviewFields,
  },
  { additionalProperties: false },
);
/**
 * 冻结的确认版本：relatedObjectRefs 是确认时的 <对象 id>@<版本>，修改不带 stale。
 * v2 多出 decisions、actionItems（只有已确认的），objectChanges 只留已确认决策的修改；v1 没有这两项。
 */
export const MeetingCardFrozenPayload = Type.Object(
  {
    ...payloadFields,
    schemaVersion: MeetingCardFrozenSchemaVersion,
    objectChanges: Type.Array(MeetingConfirmedObjectChange, { maxItems: 50 }),
    revision: Type.Integer({ minimum: 1 }),
    decisions: Type.Optional(Type.Array(MeetingFrozenDecision, { maxItems: 50 })),
    actionItems: Type.Optional(Type.Array(MeetingFrozenActionItem, { maxItems: 100 })),
  },
  { additionalProperties: false },
);
export const MeetingCardDraft = Type.Object({ ...payloadFields, objectChanges: Type.Array(MeetingObjectChange, { maxItems: 50 }) }, { additionalProperties: false });

/** 天枢本地的行动项（拍板 4）：会上明确分给某人的待办；负责人本人「接下」才推成执行事项，taskId 回填（taskId、review 只由服务改）。 */
export const MeetingActionItem = Type.Object(
  {
    id: CardItemId,
    text: Type.String({ minLength: 1, maxLength: 300 }),
    ownerPersonId: NullableString({ minLength: 1, maxLength: 200 }),
    dueDate: NullableString({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    basisSectionIds: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 50 }),
    taskId: NullableString({ minLength: 1, maxLength: 200 }),
    /** 10/28 之前生成的行动项没有（随整卡确认推出去）。 */
    review: Type.Optional(MeetingItemReview),
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
/** confirmedBy：整卡确认的人（personId）；v2 由决策逐条确认凑齐或 48 小时到了自动冻结时为 null（确认人在每一条上）。 */
export const MeetingCardConfirmation = Type.Object(
  {
    revision: Type.Integer({ minimum: 1 }),
    confirmedBy: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
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
    /** 会上提取的决策和逐条确认状态；10/28 之前生成的会议卡为 null（照旧由主持人整卡确认）。 */
    decisions: Type.Union([Type.Array(MeetingCardDecision), Type.Null()]),
    /** 主持人：没有负责人的行动项由他确认；没有责任人的决策由他补归属。 */
    hostId: Type.String({ minLength: 1 }),
    /** 读卡的人：和责任人是同一个人时能确认（没有负责人的行动项看主持人）。 */
    viewerId: Type.String({ minLength: 1 }),
    /** 冻结时写不写进本体（主持人或创建人在冻结前定；冻结后看 sync.writeToWorld）。 */
    writeToWorld: Type.Boolean(),
    confirmed: Type.Union([
      Type.Object(
        // actionItems：这次确认时的行动项快照（推成执行事项后带 taskId）。
        { payload: MeetingCardFrozenPayload, confirmation: MeetingCardConfirmation, kind: MeetingCardKind, actionItems: Type.Array(MeetingActionItem) },
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
 * 逐条确认的会议卡（decisions 不为 null）冻结前不能整卡确认：409 REVIEW_PER_ITEM。
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
 * POST /api/meetings/:id/card/reviews：逐条确认一条决策（kind decision）或行动项（kind action）。
 * 只有责任人本人能点（没有负责人的行动项由主持人点），别人 404；没有责任人的决策要先补归属（主持人点 409 OWNER_REQUIRED）。
 * reject 要写原因。冻结后决策不能再点（409 CARD_FROZEN），已处理过的 409 ALREADY_REVIEWED。
 */
export const MeetingCardReviewRequest = Type.Object(
  {
    kind: Type.Union([Type.Literal("decision"), Type.Literal("action")]),
    id: CardItemId,
    verdict: Type.Union([Type.Literal("confirm"), Type.Literal("reject")]),
    reason: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);
/**
 * POST /api/meetings/:id/card/owners：冻结前主持人给一条没有责任人的决策补归属（斯一第 3 条），只能选参会人；补上后由那个人确认。
 * 别人 404；不是参会人 400 NOT_PARTICIPANT；已有责任人 409 OWNER_SET；已处理过 409 ALREADY_REVIEWED；冻结后 409 CARD_FROZEN。
 */
export const MeetingCardOwnerRequest = Type.Object(
  { id: CardItemId, ownerPersonId: Type.String({ minLength: 1, maxLength: 200 }) },
  { additionalProperties: false },
);
/** 逐条确认的结果：处理后的会议卡；点的人读不了这场会的会议卡（会上点名、没实际参会的责任人）时为 null。 */
export const MeetingCardReviewResponse = Type.Object({ view: Type.Union([MeetingCardView, Type.Null()]) }, { additionalProperties: false });
/** PUT /api/meetings/:id/card/world：冻结前主持人或创建人改「不写进本体」（冻结后 409 CARD_FROZEN，走修改确认）。 */
export const MeetingCardWorldChoiceRequest = Type.Object({ writeToWorld: Type.Boolean() }, { additionalProperties: false });

/**
 * 会后生成卡片的模型输出（只能调用 submit_candidate）：模型只填摘要、按议题的正文段落（带引用的发言段 turnId）、会上拍板的决策、
 * 从候选目标里选的修改（after 文字、依据段落序号和所属决策序号，都从 1 开始）、会上明确分给某人的行动项。
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
    decisions: Type.Array(
      Type.Object(
        {
          text: Type.String({ minLength: 1, maxLength: 300 }),
          ownerPersonId: NullableString({ minLength: 1, maxLength: 200 }),
          basisSections: Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 50 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 50 },
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
export type TMeetingCardFrozenPayload = Static<typeof MeetingCardFrozenPayload>;
export type TMeetingCardDraft = Static<typeof MeetingCardDraft>;
export type TMeetingActionItem = Static<typeof MeetingActionItem>;
export type TMeetingItemReview = Static<typeof MeetingItemReview>;
export type TMeetingCardDecision = Static<typeof MeetingCardDecision>;
export type TMeetingFrozenDecision = Static<typeof MeetingFrozenDecision>;
export type TMeetingFrozenActionItem = Static<typeof MeetingFrozenActionItem>;
export type TMeetingCardReviewRequest = Static<typeof MeetingCardReviewRequest>;
export type TMeetingCardReviewResponse = Static<typeof MeetingCardReviewResponse>;
export type TMeetingCardOwnerRequest = Static<typeof MeetingCardOwnerRequest>;
export type TMeetingCardWorldChoiceRequest = Static<typeof MeetingCardWorldChoiceRequest>;
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
