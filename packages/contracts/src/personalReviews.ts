import { Type, type Static } from "@sinclair/typebox";
import { ActionDescriptor } from "./cards.js";
import { MonthlyPlanPeriod } from "./monthlyPlans.js";
import { MonthlyReviewField, MonthlyReviewSelfReview } from "./monthlyReviews.js";

/**
 * 个人复盘：月末复盘开启时，被复盘月份每个有 Mission 的人各一份，对照自己的 Mission Card 写四部分
 * （与战场复盘同一结构）。起草有三条路：本人的 AI 工具经个人令牌（MCP）写入、Co-Agent 按 Mission 卡、每周复盘、采集记录和上传的材料生成、本人手写。
 * 全员可见谁交了谁没交（看不到别人写的内容）；全部提交或被 CEO 跳过后，战场 / 能力域复盘项才开始起草。
 */

const DateTime = Type.String({ description: "ISO 8601" });
const NullableDateTime = Type.Union([DateTime, Type.Null()]);
const Count = Type.Integer({ minimum: 0 });

export const PersonalReviewStatus = Type.Union([
  /** 还没有草稿。 */
  Type.Literal("waiting"),
  /** Co-Agent 按上传材料起草中。 */
  Type.Literal("drafting"),
  Type.Literal("draft_failed"),
  /** 有草稿，本人可改。 */
  Type.Literal("draft"),
  /** 本人已提交，只读。 */
  Type.Literal("submitted"),
  /** CEO 选择「不等了，继续」。 */
  Type.Literal("skipped"),
]);

/** agent_tool：本人的 AI 工具经 MCP 写入；co_agent：上传材料后 Co-Agent 起草；manual：本人在天枢里手写；import：飞书原文导入。 */
export const PersonalReviewDraftSource = Type.Union([
  Type.Literal("agent_tool"),
  Type.Literal("co_agent"),
  Type.Literal("manual"),
  Type.Literal("import"),
  Type.Null(),
]);

const GenerationError = Type.Union([
  Type.Object({ code: Type.String(), message: Type.String(), at: DateTime }, { additionalProperties: false }),
  Type.Null(),
]);

/**
 * Co-Agent 生成个人复盘的一步：读 Mission 卡 → 读每周复盘 → 读采集记录 → 起草。
 * result 是这一步的结果，如「2 张」「缺少记录」「保留你改过的 1 段」。
 */
export const PersonalReviewGenerationStep = Type.Object(
  {
    id: Type.Union([Type.Literal("missions"), Type.Literal("weekly"), Type.Literal("collector"), Type.Literal("draft")]),
    label: Type.String(),
    status: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("done"), Type.Literal("failed")]),
    result: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** 本人被复盘月份的 Mission 摘要（复盘的对照基准）。 */
export const PersonalReviewMission = Type.Object(
  { id: Type.String(), code: Type.String(), title: Type.String(), outcome: Type.String() },
  { additionalProperties: false },
);

export const PersonalReviewPayload = Type.Object(
  {
    personalReviewId: Type.String(),
    monthlyReviewId: Type.String(),
    period: MonthlyPlanPeriod,
    version: Type.Integer({ minimum: 1 }),
    personId: Type.String(),
    personName: Type.String(),
    status: PersonalReviewStatus,
    draftSource: PersonalReviewDraftSource,
    draftError: GenerationError,
    /** 每栏正文里的出处写成 Markdown 链接 [名称](cite:<ref>)，紧跟在它支撑的那一句末尾。 */
    selfReview: Type.Union([MonthlyReviewSelfReview, Type.Null()]),
    /** 最近一次 Co-Agent 生成的步骤；还没生成过为空。 */
    generationSteps: Type.Array(PersonalReviewGenerationStep),
    /** 本人（或本人的 AI 工具）保存过的栏：重新生成时保留，不覆盖。 */
    editedFields: Type.Array(MonthlyReviewField),
    missions: Type.Array(PersonalReviewMission),
    /** 本人有未撤销、未过期的个人令牌，视为已把 AI 工具连上天枢。 */
    toolConnected: Type.Boolean(),
    /** 本复盘对话里已上传的材料数（生成时一并读取）。 */
    materialCount: Count,
    conversationScope: Type.String(),
    submittedAt: NullableDateTime,
    skipped: Type.Union([
      Type.Object({ byName: Type.String(), at: DateTime }, { additionalProperties: false }),
      Type.Null(),
    ]),
    viewer: Type.Object({ isSelf: Type.Boolean(), isCeo: Type.Boolean() }, { additionalProperties: false }),
    /** 本人：personal-review.update / submit / draft_with_co_agent；CEO：personal-review.skip。 */
    actions: Type.Array(ActionDescriptor),
  },
  { additionalProperties: false },
);

/** 看板的一行：只有名字和状态，不含内容。href 只给本人（和 CEO）。 */
export const PersonalReviewBoardRow = Type.Object(
  {
    personalReviewId: Type.String(),
    personId: Type.String(),
    personName: Type.String(),
    status: PersonalReviewStatus,
    draftSource: PersonalReviewDraftSource,
    submittedAt: NullableDateTime,
    isSelf: Type.Boolean(),
    href: Type.Union([Type.String(), Type.Null()]),
    /** CEO 对未交的人：personal-review.skip。 */
    actions: Type.Array(ActionDescriptor),
  },
  { additionalProperties: false },
);

/** 全员可见。rows 未交的在前，其次按姓名。 */
export const PersonalReviewBoard = Type.Object(
  {
    monthlyReviewId: Type.String(),
    period: MonthlyPlanPeriod,
    counts: Type.Object({ total: Count, submitted: Count, skipped: Count }, { additionalProperties: false }),
    /** 每份都已提交或跳过。 */
    complete: Type.Boolean(),
    rows: Type.Array(PersonalReviewBoardRow),
  },
  { additionalProperties: false },
);

/** 当前没有进行中的月末复盘时 board 为 null。 */
export const PersonalReviewBoardResponse = Type.Object(
  { board: Type.Union([PersonalReviewBoard, Type.Null()]) },
  { additionalProperties: false },
);

export const PersonalReviewResponse = Type.Object(
  { review: PersonalReviewPayload },
  { additionalProperties: false },
);

export const ExecutePersonalReviewActionRequest = Type.Object(
  { actionId: Type.String(), input: Type.Optional(Type.Unknown()) },
  { additionalProperties: false },
);

/** 成功与幂等重放返回最新视图；版本冲突 409 VERSION_CONFLICT。 */
export const ExecutePersonalReviewActionResponse = Type.Object(
  { review: PersonalReviewPayload, board: PersonalReviewBoard },
  { additionalProperties: false },
);

const FieldText = Type.String({ maxLength: 4000 });
const Sources = Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 10 });

/** personal-review.update：只提交改动的栏；sources 省略时保留原来的。 */
export const PersonalReviewUpdateInput = Type.Object(
  {
    fields: Type.Array(
      Type.Object({ field: MonthlyReviewField, text: FieldText, sources: Type.Optional(Sources) }, { additionalProperties: false }),
      { minItems: 1, maxItems: 4 },
    ),
  },
  { additionalProperties: false },
);

export type TPersonalReviewStatus = Static<typeof PersonalReviewStatus>;
export type TPersonalReviewDraftSource = Static<typeof PersonalReviewDraftSource>;
export type TPersonalReviewMission = Static<typeof PersonalReviewMission>;
export type TPersonalReviewGenerationStep = Static<typeof PersonalReviewGenerationStep>;
export type TPersonalReviewPayload = Static<typeof PersonalReviewPayload>;
export type TPersonalReviewBoardRow = Static<typeof PersonalReviewBoardRow>;
export type TPersonalReviewBoard = Static<typeof PersonalReviewBoard>;
export type TPersonalReviewBoardResponse = Static<typeof PersonalReviewBoardResponse>;
export type TPersonalReviewResponse = Static<typeof PersonalReviewResponse>;
export type TExecutePersonalReviewActionRequest = Static<typeof ExecutePersonalReviewActionRequest>;
export type TExecutePersonalReviewActionResponse = Static<typeof ExecutePersonalReviewActionResponse>;
export type TPersonalReviewUpdateInput = Static<typeof PersonalReviewUpdateInput>;

/**
 * 月度经营周期的总倒计时：从个人复盘开始收集起算 72 小时，目标是签发下月全部任务卡。
 * 各阶段没有各自的时限，倒计时自始至终只有这一个，到期后继续累计超时；下月全部战场的任务卡确定时 completedAt 落定。
 */
export const MonthlyCycle = Type.Object(
  {
    /** 被复盘的月份。 */
    reviewPeriod: MonthlyPlanPeriod,
    /** 要签发任务卡的月份。 */
    nextPeriod: MonthlyPlanPeriod,
    startedAt: DateTime,
    /** startedAt + 72 小时。 */
    deadlineAt: DateTime,
    completedAt: NullableDateTime,
    /** 当前走到哪一步，给倒计时旁边的一句话用。 */
    stage: Type.Union([
      Type.Literal("personal_reviews"),
      Type.Literal("unit_reviews"),
      Type.Literal("company_summary"),
      Type.Literal("lto_decision"),
      Type.Literal("period_plan"),
      Type.Literal("mission_cards"),
      Type.Literal("done"),
    ]),
    serverNow: DateTime,
  },
  { additionalProperties: false },
);

/** 没有进行中或刚完成的周期时为 null。 */
export const MonthlyCycleResponse = Type.Object(
  { cycle: Type.Union([MonthlyCycle, Type.Null()]) },
  { additionalProperties: false },
);

/** 通知栏「N 月任务卡」：本体里本月全员 Mission 按生命周期计数（10/28 起签发看本体，不再看 72 小时倒计时）。 */
export const MissionCardStatus = Type.Object(
  {
    period: MonthlyPlanPeriod,
    total: Type.Integer({ minimum: 0 }),
    /** 已成立、已关闭的张数。 */
    settled: Type.Integer({ minimum: 0 }),
    groups: Type.Array(Type.Object({ label: Type.String(), count: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })),
  },
  { additionalProperties: false },
);
/** 本体没配或读不到时为 null。 */
export const MissionCardStatusResponse = Type.Object({ status: Type.Union([MissionCardStatus, Type.Null()]) }, { additionalProperties: false });
export type TMissionCardStatus = Static<typeof MissionCardStatus>;

export type TMonthlyCycle = Static<typeof MonthlyCycle>;
export type TMonthlyCycleResponse = Static<typeof MonthlyCycleResponse>;
