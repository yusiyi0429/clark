import { Type, type Static } from "@sinclair/typebox";
import { ActionDescriptor } from "./cards.js";

/**
 * 周复盘（D-01）：每人每周一份，存在天枢。每周五 15:00（上海时间）Co-Agent 按本人本周的采集记录、Mission 与 Task 进展、
 * 参加的会议结论、上一周的周复盘和本月 Mission 卡起草；本人逐段修改后提交。正文每句带出处 `[名称](cite:<ref>)`，
 * 没有记录的写「缺少记录」。可见：本人、同一战场的人、CEO；别人只在提交后看得到正文。
 * 提交后按关联的 Mission、Task 各写一条进展到本体（只写进展和证据链接）。10 月的周复盘从飞书一次性导入，状态为已提交（导入）。
 */

const DateTime = Type.String({ description: "ISO 8601" });
const NullableDateTime = Type.Union([DateTime, Type.Null()]);
const Day = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });

/** 五段沿用公司周复盘模板：本周总体判断、关键进展与 Evidence、最重要的问题及 Why、判断变化 / Implication、当前处理。 */
export const WeeklyReviewField = Type.Union([
  Type.Literal("overall"),
  Type.Literal("progress"),
  Type.Literal("issues"),
  Type.Literal("implications"),
  Type.Literal("actions"),
]);
const Section = Type.Object(
  { text: Type.String({ maxLength: 4000 }), sources: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 10 }) },
  { additionalProperties: false },
);
export const WeeklyReviewBody = Type.Object(
  { overall: Section, progress: Section, issues: Section, implications: Section, actions: Section },
  { additionalProperties: false },
);
/** Co-Agent 提交的候选：五段 text + sources（sources 由服务端按正文里的出处重算）。 */
export const WeeklyReviewDraftCandidate = WeeklyReviewBody;

export const WeeklyReviewStatus = Type.Union([
  Type.Literal("drafting"),
  Type.Literal("draft_failed"),
  Type.Literal("draft"),
  Type.Literal("submitted"),
]);
/** tianshu：在天枢生成和修改；import：从飞书导入的历史周复盘（已提交）。 */
export const WeeklyReviewOrigin = Type.Union([Type.Literal("tianshu"), Type.Literal("import")]);

/** 生成的一步：读 Mission 卡 → 读 Mission 与 Task 进展 → 读会议结论 → 读采集记录 → 读上周复盘 → 起草。 */
export const WeeklyReviewGenerationStep = Type.Object(
  {
    id: Type.Union([Type.Literal("missions"), Type.Literal("progress"), Type.Literal("meetings"), Type.Literal("collector"),
      Type.Literal("previous"), Type.Literal("draft")]),
    label: Type.String(),
    status: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("done"), Type.Literal("failed")]),
    result: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** 修改记录的一条（不含改之前的原文）。 */
export const WeeklyReviewRevision = Type.Object(
  {
    at: DateTime,
    kind: Type.Union([Type.Literal("generate"), Type.Literal("edit"), Type.Literal("submit"), Type.Literal("import")]),
    byName: Type.String(),
    fields: Type.Array(WeeklyReviewField),
  },
  { additionalProperties: false },
);

export const WeeklyReviewPayload = Type.Object(
  {
    weeklyReviewId: Type.String(),
    version: Type.Integer({ minimum: 1 }),
    personId: Type.String(),
    personName: Type.String(),
    /** 这一周的周一与周日（上海日期）。 */
    weekStart: Day,
    weekEnd: Day,
    status: WeeklyReviewStatus,
    origin: WeeklyReviewOrigin,
    /** 导入的飞书原文。 */
    importSource: Type.Union([Type.Object({ title: Type.String(), url: Type.String() }, { additionalProperties: false }), Type.Null()]),
    /** 别人看草稿时为 null（提交后才看得到正文）。 */
    body: Type.Union([WeeklyReviewBody, Type.Null()]),
    draftError: Type.Union([Type.Object({ code: Type.String(), message: Type.String(), at: DateTime }, { additionalProperties: false }), Type.Null()]),
    generationSteps: Type.Array(WeeklyReviewGenerationStep),
    /** 本人改过的段：重新生成时保留。 */
    editedFields: Type.Array(WeeklyReviewField),
    /** 新的在前。 */
    revisions: Type.Array(WeeklyReviewRevision),
    submittedAt: NullableDateTime,
    viewer: Type.Object({ isSelf: Type.Boolean(), isCeo: Type.Boolean() }, { additionalProperties: false }),
    /** 本人：weekly-review.update / submit / generate。 */
    actions: Type.Array(ActionDescriptor),
  },
  { additionalProperties: false },
);

export const WeeklyReviewBoardRow = Type.Object(
  {
    weeklyReviewId: Type.String(),
    personId: Type.String(),
    personName: Type.String(),
    status: WeeklyReviewStatus,
    origin: WeeklyReviewOrigin,
    isSelf: Type.Boolean(),
    href: Type.String(),
  },
  { additionalProperties: false },
);

/** 看得到的人（本人、同战场、CEO 看全部）这一周的周复盘；本人的在最前，其次未提交的、再按姓名。 */
export const WeeklyReviewBoard = Type.Object(
  {
    weekStart: Day,
    weekEnd: Day,
    /** 是不是本周（上海时间）。 */
    isCurrentWeek: Type.Boolean(),
    counts: Type.Object({ total: Type.Integer({ minimum: 0 }), submitted: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
    rows: Type.Array(WeeklyReviewBoardRow),
    /** 前一周、后一周（有周复盘时）。 */
    previousWeek: Type.Union([Day, Type.Null()]),
    nextWeek: Type.Union([Day, Type.Null()]),
  },
  { additionalProperties: false },
);

/** 不带 week：本周有看得到的周复盘就取本周，否则取最近有周复盘的一周；都没有为 null。 */
export const WeeklyReviewBoardResponse = Type.Object(
  { board: Type.Union([WeeklyReviewBoard, Type.Null()]) },
  { additionalProperties: false },
);
export const WeeklyReviewResponse = Type.Object({ review: WeeklyReviewPayload }, { additionalProperties: false });
export const ExecuteWeeklyReviewActionRequest = Type.Object(
  { actionId: Type.String(), input: Type.Optional(Type.Unknown()) },
  { additionalProperties: false },
);
export const ExecuteWeeklyReviewActionResponse = Type.Object({ review: WeeklyReviewPayload }, { additionalProperties: false });

/** weekly-review.update：只提交改动的段；sources 省略时保留原来的。 */
export const WeeklyReviewUpdateInput = Type.Object(
  {
    fields: Type.Array(
      Type.Object({ field: WeeklyReviewField, text: Type.String({ maxLength: 4000 }),
        sources: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 10 })) }, { additionalProperties: false }),
      { minItems: 1, maxItems: 5 },
    ),
  },
  { additionalProperties: false },
);

export type TWeeklyReviewField = Static<typeof WeeklyReviewField>;
export type TWeeklyReviewBody = Static<typeof WeeklyReviewBody>;
export type TWeeklyReviewStatus = Static<typeof WeeklyReviewStatus>;
export type TWeeklyReviewOrigin = Static<typeof WeeklyReviewOrigin>;
export type TWeeklyReviewGenerationStep = Static<typeof WeeklyReviewGenerationStep>;
export type TWeeklyReviewRevision = Static<typeof WeeklyReviewRevision>;
export type TWeeklyReviewPayload = Static<typeof WeeklyReviewPayload>;
export type TWeeklyReviewBoardRow = Static<typeof WeeklyReviewBoardRow>;
export type TWeeklyReviewBoard = Static<typeof WeeklyReviewBoard>;
export type TWeeklyReviewBoardResponse = Static<typeof WeeklyReviewBoardResponse>;
export type TWeeklyReviewResponse = Static<typeof WeeklyReviewResponse>;
export type TExecuteWeeklyReviewActionResponse = Static<typeof ExecuteWeeklyReviewActionResponse>;
export type TWeeklyReviewUpdateInput = Static<typeof WeeklyReviewUpdateInput>;
