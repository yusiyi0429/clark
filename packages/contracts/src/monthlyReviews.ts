import { Type, type Static } from "@sinclair/typebox";
import { ActionDescriptor } from "./cards.js";
import { MonthlyPlanPeriod } from "./monthlyPlans.js";

/**
 * 月末复盘（M1B 会议共识）：每月一份，按战场 / 能力域各一项，由负责人自评、co-agent 评估偏差、
 * CEO 逐项确认；全部确认后形成公司复盘，再单独决定 LTCO 是否修订，决定后生成下月计划草案。
 */

const DateTime = Type.String({ description: "ISO 8601" });
const NullableDateTime = Type.Union([DateTime, Type.Null()]);
const NullableText = Type.Union([Type.String(), Type.Null()]);
const Count = Type.Integer({ minimum: 0 });

export const MonthlyReviewStatus = Type.Union([
  /** 复盘项未全部确认。 */
  Type.Literal("collecting"),
  /** 全部确认；公司复盘（关键经营判断）待 CEO 确认。 */
  Type.Literal("summarizing"),
  /** 公司复盘已确认；LTCO 待决定。 */
  Type.Literal("ltco_pending"),
  /** LTCO 已决定，下月计划草案已触发。 */
  Type.Literal("closed"),
]);

export const MonthlyReviewItemStatus = Type.Union([
  /** 本单元的个人复盘还没交齐（全部提交或被 CEO 跳过后自动起草）。 */
  Type.Literal("waiting"),
  Type.Literal("drafting"),
  Type.Literal("draft_failed"),
  Type.Literal("draft"),
  Type.Literal("submitted"),
  Type.Literal("returned"),
  Type.Literal("confirmed"),
]);

export const MonthlyReviewSubjectType = Type.Union([Type.Literal("battlefield"), Type.Literal("capability")]);

/** 已确认项的确认来源：ceo 是 CEO 在天枢逐项确认；import 是导入的复盘（没有确认人，不算 CEO 确认过）。未确认为 null。 */
export const MonthlyReviewConfirmationSource = Type.Union([Type.Literal("ceo"), Type.Literal("import"), Type.Null()]);

/**
 * 战场 / 能力域月度复盘的四部分（与 Co-Agent Design 的 BR 一致）：本周期总体结果、关键经营判断、下周期经营重点、
 * 待上层决策事项。关键经营判断要把结果、证据、对照目标的差距与原因、判断变化和不确定性串起来；待上层决策事项可以写「无」。
 */
export const MonthlyReviewField = Type.Union([
  Type.Literal("overall"),
  Type.Literal("judgments"),
  Type.Literal("nextFocus"),
  Type.Literal("escalations"),
]);

const FieldText = Type.String({ maxLength: 4000 });
const Sources = Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 10 });

export const MonthlyReviewSelfReviewField = Type.Object(
  { text: FieldText, sources: Sources },
  { additionalProperties: false },
);

export const MonthlyReviewSelfReview = Type.Object(
  {
    overall: MonthlyReviewSelfReviewField,
    judgments: MonthlyReviewSelfReviewField,
    nextFocus: MonthlyReviewSelfReviewField,
    escalations: MonthlyReviewSelfReviewField,
  },
  { additionalProperties: false },
);

/** 起草 Agent 的严格输出。 */
export const MonthlyReviewDraftCandidate = MonthlyReviewSelfReview;

/** 偏差评估（co-agent）的严格输出：只评估，不改自评。 */
export const MonthlyReviewAssessment = Type.Object(
  {
    overall: Type.String({ minLength: 1, maxLength: 300 }),
    deviations: Type.Array(
      Type.Object(
        { point: Type.String({ minLength: 1, maxLength: 500 }), evidence: Type.String({ minLength: 1, maxLength: 1000 }) },
        { additionalProperties: false },
      ),
      { maxItems: 8 },
    ),
    questions: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 5 }),
  },
  { additionalProperties: false },
);

export const MonthlyReviewJudgment = Type.Object(
  { title: Type.String({ minLength: 1, maxLength: 60 }), body: Type.String({ minLength: 1, maxLength: 1500 }) },
  { additionalProperties: false },
);

export const MonthlyReviewSubjectRef = Type.Object(
  { subjectType: MonthlyReviewSubjectType, subjectId: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);

/** 某个战场 / 能力域长期目标（六个月目标）的修订建议；只列建议改动的单元。 */
export const MonthlyReviewUnitGoalSuggestion = Type.Object(
  {
    ...MonthlyReviewSubjectRef.properties,
    proposedOutcome: Type.String({ minLength: 1, maxLength: 4000 }),
    rationale: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  { additionalProperties: false },
);

export const MonthlyReviewLtcoSuggestion = Type.Object(
  {
    change: Type.Boolean(),
    /** change=false 时等于当前 LTCO。 */
    proposedLtco: Type.String({ minLength: 1, maxLength: 4000 }),
    rationale: Type.String({ minLength: 1, maxLength: 1500 }),
    /** 战场 / 能力域长期目标的修订建议；没有建议时为空数组。 */
    units: Type.Array(MonthlyReviewUnitGoalSuggestion, { maxItems: 30 }),
  },
  { additionalProperties: false },
);

const FocusList = Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 8 });

/**
 * 公司月度复盘汇总 Agent 的严格输出（四部分，与 Co-Agent Design 的 PR 一致）：
 * 本周期总体结果、关键经营判断（覆盖各份确认版复盘）、下周期经营重点、长期目标修订建议（没有时建议保持）。
 */
export const MonthlyReviewSummaryCandidate = Type.Object(
  {
    overall: Type.String({ minLength: 1, maxLength: 3000 }),
    judgments: Type.Array(MonthlyReviewJudgment, { minItems: 1, maxItems: 8 }),
    nextFocus: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 8 }),
    ltcoSuggestion: MonthlyReviewLtcoSuggestion,
  },
  { additionalProperties: false },
);

export const MonthlyReviewGenerationStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("running"),
  Type.Literal("ready"),
  Type.Literal("failed"),
]);

const GenerationError = Type.Union([
  Type.Object({ code: Type.String(), message: Type.String(), at: DateTime }, { additionalProperties: false }),
  Type.Null(),
]);

/** 对话里 agent 提出的改写建议：负责人点「采用」才写入该栏。每栏最多一条，新的覆盖旧的。 */
export const MonthlyReviewSuggestion = Type.Object(
  {
    field: MonthlyReviewField,
    text: FieldText,
    rationale: Type.String({ maxLength: 500 }),
    createdAt: DateTime,
  },
  { additionalProperties: false },
);

export const MonthlyReviewHistoryEntry = Type.Object(
  {
    at: DateTime,
    by: Type.String(),
    byName: Type.String(),
    action: Type.Union([Type.Literal("submit"), Type.Literal("return"), Type.Literal("confirm")]),
    reason: NullableText,
  },
  { additionalProperties: false },
);

export const MonthlyReviewComment = Type.Object(
  {
    id: Type.String(),
    authorId: Type.String(),
    authorName: Type.String(),
    body: Type.String(),
    createdAt: DateTime,
  },
  { additionalProperties: false },
);

/** 讨论与补充：按 clientId 幂等；不改正文，也不经过版本号（多人同时评论不互相冲突）。 */
export const CreateMonthlyReviewCommentRequest = Type.Object(
  { clientId: Type.String({ format: "uuid" }), body: Type.String({ minLength: 1, maxLength: 2000, pattern: "\\S" }) },
  { additionalProperties: false },
);
export const CreateMonthlyReviewCommentResponse = Type.Object({ comment: MonthlyReviewComment }, { additionalProperties: false });

export const MonthlyReviewItemPayload = Type.Object(
  {
    itemId: Type.String(),
    reviewId: Type.String(),
    period: MonthlyPlanPeriod,
    version: Type.Integer({ minimum: 1 }),
    subjectType: MonthlyReviewSubjectType,
    subjectId: Type.String(),
    subjectCode: Type.String(),
    subjectName: Type.String(),
    ownerId: Type.String(),
    ownerName: Type.String(),
    /** 注册表负责人为空，本项挂在 CEO 名下代复盘。 */
    ownerUnassigned: Type.Boolean(),
    /** 被复盘月份已签发计划里这一项的 PCO；没有签发计划或没有这一项时为 null。 */
    target: NullableText,
    sixMonthOutcome: Type.String(),
    status: MonthlyReviewItemStatus,
    draftError: GenerationError,
    selfReview: Type.Union([MonthlyReviewSelfReview, Type.Null()]),
    suggestions: Type.Array(MonthlyReviewSuggestion),
    returnReason: NullableText,
    assessment: Type.Object(
      {
        status: Type.Union([MonthlyReviewGenerationStatus, Type.Literal("none")]),
        result: Type.Union([MonthlyReviewAssessment, Type.Null()]),
        error: GenerationError,
      },
      { additionalProperties: false },
    ),
    history: Type.Array(MonthlyReviewHistoryEntry),
    /** 讨论与补充：负责人、CEO 和本单元当月 Mission 负责人都能看、都能说；时间正序。 */
    comments: Type.Array(MonthlyReviewComment),
    /** 本单元当月 Mission 负责人（参与讨论的人），不含负责人本人。 */
    participantNames: Type.Array(Type.String()),
    submittedAt: NullableDateTime,
    confirmedAt: NullableDateTime,
    confirmationSource: MonthlyReviewConfirmationSource,
    /** isParticipant：本单元当月 Mission 负责人；canComment：确认前负责人、CEO、参与者都能评论。 */
    viewer: Type.Object({ isOwner: Type.Boolean(), isCeo: Type.Boolean(), isParticipant: Type.Boolean(), canComment: Type.Boolean() }, { additionalProperties: false }),
    conversationScope: Type.String(),
    /**
     * 按看的人和状态投影：
     * 负责人 update / submit / resolve_suggestion / retry_draft；CEO confirm / return / retry_assessment / retry_draft。
     */
    actions: Type.Array(ActionDescriptor),
  },
  { additionalProperties: false },
);

/** 总览里的一行；actions 是 CEO 可以在总览里直接做的 confirm / return。 */
export const MonthlyReviewItemRow = Type.Object(
  {
    itemId: Type.String(),
    subjectType: MonthlyReviewSubjectType,
    subjectId: Type.String(),
    subjectCode: Type.String(),
    subjectName: Type.String(),
    ownerName: Type.String(),
    ownerUnassigned: Type.Boolean(),
    status: MonthlyReviewItemStatus,
    confirmationSource: MonthlyReviewConfirmationSource,
    /** 本周期总体结果的第一句；还没有自评时为 null。 */
    lead: NullableText,
    assessmentStatus: Type.Union([MonthlyReviewGenerationStatus, Type.Literal("none")]),
    assessmentOverall: NullableText,
    deviationCount: Count,
    actions: Type.Array(ActionDescriptor),
  },
  { additionalProperties: false },
);

export const MonthlyReviewPayload = Type.Object(
  {
    reviewId: Type.String(),
    period: MonthlyPlanPeriod,
    /** 下月 period，LTCO 决定后生成的计划就在这个月。 */
    nextPeriod: MonthlyPlanPeriod,
    version: Type.Integer({ minimum: 1 }),
    status: MonthlyReviewStatus,
    counts: Type.Object(
      { total: Count, submitted: Count, confirmed: Count, returned: Count },
      { additionalProperties: false },
    ),
    items: Type.Array(MonthlyReviewItemRow),
    summary: Type.Object(
      {
        status: Type.Union([MonthlyReviewGenerationStatus, Type.Literal("none")]),
        error: GenerationError,
        /** 公司复盘四部分：本周期总体结果、关键经营判断、下周期经营重点；长期目标修订建议在 ltco.suggestion。 */
        overall: Type.String(),
        judgments: Type.Array(MonthlyReviewJudgment),
        nextFocus: Type.Array(Type.String()),
        confirmedAt: NullableDateTime,
      },
      { additionalProperties: false },
    ),
    /** LTO（Long Term Outcome，原 LTCO）审视：先公司 LTO，后各战场 LTO；字段名沿用 ltco。 */
    ltco: Type.Object(
      {
        /**
         * 滑动窗口：从下月起算 6 个月（例如 2026-10 至 2027-03），每月审视时整体往后滑一个月；
         * 公司与战场 LTO 用同一个窗口。PO（Period Outcome）是窗口第一个月的拆分。
         */
        window: Type.Object({ start: MonthlyPlanPeriod, end: MonthlyPlanPeriod }, { additionalProperties: false }),
        current: Type.String(),
        /** 各战场当前的 LTO（六个月目标），审视时一起看、一起改；能力域不在这里审（2026-09-30 用户决定）。 */
        units: Type.Array(Type.Object(
          { ...MonthlyReviewSubjectRef.properties, subjectCode: Type.String(), subjectName: Type.String(), current: Type.String() },
          { additionalProperties: false },
        )),
        suggestion: Type.Union([MonthlyReviewLtcoSuggestion, Type.Null()]),
        decision: Type.Union([
          Type.Object(
            {
              decision: Type.Union([Type.Literal("keep"), Type.Literal("revise")]),
              ltcoBefore: Type.String(),
              ltcoAfter: Type.String(),
              /** 这次改动的单元长期目标；只改公司 LTCO 或保持不变时为空数组。 */
              units: Type.Array(Type.Object(
                { ...MonthlyReviewSubjectRef.properties, before: Type.String(), after: Type.String() },
                { additionalProperties: false },
              )),
              decidedAt: DateTime,
              /** 下月计划已存在且未重新生成时为 true，页面提示去计划页重新生成。 */
              planExisted: Type.Boolean(),
            },
            { additionalProperties: false },
          ),
          Type.Null(),
        ]),
      },
      { additionalProperties: false },
    ),
    /** update_summary / retry_summary / confirm_summary / decide_ltco，按状态投影。 */
    actions: Type.Array(ActionDescriptor),
  },
  { additionalProperties: false },
);

/** CEO 总览：当月还没有复盘时 review 为 null，actions 里带 monthly-review.open。 */
export const MonthlyReviewResponse = Type.Object(
  {
    period: MonthlyPlanPeriod,
    review: Type.Union([MonthlyReviewPayload, Type.Null()]),
    actions: Type.Array(ActionDescriptor),
  },
  { additionalProperties: false },
);

export const MonthlyReviewItemResponse = Type.Object(
  { item: MonthlyReviewItemPayload },
  { additionalProperties: false },
);

/** 通知投影：由复盘当前状态现算，不写通知表。 */
export const MonthlyReviewNotice = Type.Object(
  {
    id: Type.String(),
    kind: Type.Union([
      /** 本人：个人复盘还没提交（waiting / drafting / draft_failed / draft）。 */
      Type.Literal("personal_todo"),
      /** 负责人：本项待完成（draft / returned / draft_failed / drafting）。 */
      Type.Literal("item_todo"),
      /** 本单元当月 Mission 负责人：复盘还没确认，可以参与讨论与补充。 */
      Type.Literal("item_participant"),
      /** CEO：有已提交待处理的项。 */
      Type.Literal("items_to_review"),
      Type.Literal("summary_pending"),
      Type.Literal("ltco_pending"),
    ]),
    period: MonthlyPlanPeriod,
    text: Type.String(),
    href: Type.String(),
    createdAt: DateTime,
  },
  { additionalProperties: false },
);

export const MyMonthlyReviewNoticesResponse = Type.Object(
  { notices: Type.Array(MonthlyReviewNotice) },
  { additionalProperties: false },
);

export const ExecuteMonthlyReviewActionRequest = Type.Object(
  { actionId: Type.String(), input: Type.Optional(Type.Unknown()) },
  { additionalProperties: false },
);

/** 成功与幂等重放返回动作对象的最新视图；版本冲突返回 409 VERSION_CONFLICT，Web 重新读取。 */
export const ExecuteMonthlyReviewActionResponse = Type.Object(
  {
    item: Type.Optional(MonthlyReviewItemPayload),
    review: Type.Optional(MonthlyReviewPayload),
  },
  { additionalProperties: false },
);

/** monthly-review-item.update：只提交改动的栏；sources 省略时保留原来的。 */
export const MonthlyReviewItemUpdateInput = Type.Object(
  {
    fields: Type.Array(
      Type.Object({ field: MonthlyReviewField, text: FieldText, sources: Type.Optional(Sources) }, { additionalProperties: false }),
      { minItems: 1, maxItems: 4 },
    ),
  },
  { additionalProperties: false },
);

export const MonthlyReviewResolveSuggestionInput = Type.Object(
  { field: MonthlyReviewField, decision: Type.Union([Type.Literal("adopt"), Type.Literal("dismiss")]) },
  { additionalProperties: false },
);

export const MonthlyReviewReturnInput = Type.Object(
  { reason: Type.String({ minLength: 1, maxLength: 500, pattern: "\\S" }) },
  { additionalProperties: false },
);

export const MonthlyReviewUpdateSummaryInput = Type.Object(
  {
    overall: Type.String({ minLength: 1, maxLength: 3000, pattern: "\\S" }),
    judgments: Type.Array(MonthlyReviewJudgment, { minItems: 1, maxItems: 8 }),
    nextFocus: FocusList,
  },
  { additionalProperties: false },
);

/** 修订：公司 LTCO 与单元长期目标至少改一处（服务端校验与当前不同）；只写要改的。 */
export const MonthlyReviewDecideLtcoInput = Type.Union([
  Type.Object({ decision: Type.Literal("keep") }, { additionalProperties: false }),
  Type.Object(
    {
      decision: Type.Literal("revise"),
      ltco: Type.Optional(Type.String({ minLength: 1, maxLength: 4000, pattern: "\\S" })),
      units: Type.Optional(Type.Array(Type.Object(
        { ...MonthlyReviewSubjectRef.properties, sixMonthOutcome: Type.String({ minLength: 1, maxLength: 4000, pattern: "\\S" }) },
        { additionalProperties: false },
      ), { maxItems: 30 })),
    },
    { additionalProperties: false },
  ),
]);

export type TMonthlyReviewStatus = Static<typeof MonthlyReviewStatus>;
export type TMonthlyReviewItemStatus = Static<typeof MonthlyReviewItemStatus>;
export type TMonthlyReviewSubjectType = Static<typeof MonthlyReviewSubjectType>;
export type TMonthlyReviewConfirmationSource = Static<typeof MonthlyReviewConfirmationSource>;
export type TMonthlyReviewField = Static<typeof MonthlyReviewField>;
export type TMonthlyReviewSelfReview = Static<typeof MonthlyReviewSelfReview>;
export type TMonthlyReviewAssessment = Static<typeof MonthlyReviewAssessment>;
export type TMonthlyReviewJudgment = Static<typeof MonthlyReviewJudgment>;
export type TMonthlyReviewLtcoSuggestion = Static<typeof MonthlyReviewLtcoSuggestion>;
export type TMonthlyReviewSummaryCandidate = Static<typeof MonthlyReviewSummaryCandidate>;
export type TMonthlyReviewSuggestion = Static<typeof MonthlyReviewSuggestion>;
export type TMonthlyReviewHistoryEntry = Static<typeof MonthlyReviewHistoryEntry>;
export type TMonthlyReviewItemPayload = Static<typeof MonthlyReviewItemPayload>;
export type TMonthlyReviewItemRow = Static<typeof MonthlyReviewItemRow>;
export type TMonthlyReviewPayload = Static<typeof MonthlyReviewPayload>;
export type TMonthlyReviewResponse = Static<typeof MonthlyReviewResponse>;
export type TMonthlyReviewItemResponse = Static<typeof MonthlyReviewItemResponse>;
export type TMonthlyReviewNotice = Static<typeof MonthlyReviewNotice>;
export type TMyMonthlyReviewNoticesResponse = Static<typeof MyMonthlyReviewNoticesResponse>;
export type TExecuteMonthlyReviewActionRequest = Static<typeof ExecuteMonthlyReviewActionRequest>;
export type TExecuteMonthlyReviewActionResponse = Static<typeof ExecuteMonthlyReviewActionResponse>;
export type TMonthlyReviewItemUpdateInput = Static<typeof MonthlyReviewItemUpdateInput>;
export type TMonthlyReviewResolveSuggestionInput = Static<typeof MonthlyReviewResolveSuggestionInput>;
export type TMonthlyReviewReturnInput = Static<typeof MonthlyReviewReturnInput>;
export type TMonthlyReviewUpdateSummaryInput = Static<typeof MonthlyReviewUpdateSummaryInput>;
export type TMonthlyReviewDecideLtcoInput = Static<typeof MonthlyReviewDecideLtcoInput>;
export type TMonthlyReviewComment = Static<typeof MonthlyReviewComment>;
export type TCreateMonthlyReviewCommentRequest = Static<typeof CreateMonthlyReviewCommentRequest>;
export type TMonthlyReviewUnitGoalSuggestion = Static<typeof MonthlyReviewUnitGoalSuggestion>;
