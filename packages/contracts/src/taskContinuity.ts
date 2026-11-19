import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { NullableInteger } from "./nullable.js";

/**
 * 跨月延续与月份页（设计《新首页_伙伴总管线与Task管线_2026-11-07》第 10 节）：月份只是检查点，不按日历一刀切。
 *
 * - 了结只有三种：completed 本人确认完成（最新一版交付物交付了，之后没开返工卡）；stopped 定了「到此为止」；
 *   continued 已经延续成另一件 Task（多半是新月份的）。没了结的 Task 一直留在左栏，子会话照常跑。
 * - 延续（天枢自己的对照，不写本体）：旧 Task → 新 Task。写入时没做完的卡、专题、待交付条目、拆卡登记、规划员和它没处理的派活单挂到新 Task，
 *   新 Task 的管线接着用旧管线那段对话，约定复制一份草稿给新 Task（约定接口的 draftFrom）；做完的卡和交付版本留在旧 Task 上。
 * - 只有那件 Task 的负责人能定延续、到此为止和撤销；延续的新 Task 也要是本人负责的。
 */

const strict = { additionalProperties: false } as const;
const Instant = Type.String({ format: "date-time" });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
export const MonthPeriod = Type.String({ pattern: "^\\d{4}-(0[1-9]|1[0-2])$" });
const Note = Type.String({ minLength: 1, maxLength: 200 });

/** 另一件 Task：id、名字（写入延续那一刻的快照）、在哪个 Mission、那个 Mission 是哪个月（Mission 不在了为 null）。 */
export const TaskRef = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  name: Type.String(),
  missionId: Type.String({ minLength: 1 }),
  period: Nullable(MonthPeriod),
}, strict);

/**
 * 一件 Task 怎么了结的。by 是谁定的 personId（completed 是交付的人；延续来自 Co-Agent、本体时可能为 null）；note 是到此为止时说的一句话；
 * to 是延续到哪件（只有 continued 有）。
 */
export const TaskSettlement = Type.Object({
  kind: Type.Union([Type.Literal("completed"), Type.Literal("stopped"), Type.Literal("continued")]),
  at: Instant,
  by: Nullable(Type.String({ minLength: 1 })),
  note: Nullable(Type.String()),
  to: Nullable(TaskRef),
}, strict);

/** POST /api/me/tasks/:taskId/continuation：延续到哪件 Task（本人负责的、还没延续出去的）。 */
export const ContinueTaskRequest = Type.Object({ toTaskId: Type.String({ minLength: 1 }) }, strict);

/**
 * 延续写好了：settlement 是旧 Task 现在的了结（continued）；moved 是这次挂到新 Task 上的几样（重复调用时都是 0）：
 * cards 没做完的卡和自己做的事项，topics 专题，pending 待交付条目，splits 拆卡登记，planners 规划员会话，drafts 还没处理的派活单草稿，
 * pipeline 新 Task 挂到了旧 Task 的项目上（项目对话一直延续，第 16 节），agreement 约定复制成了新 Task 的草稿（新 Task 已经有约定时不复制）。
 */
export const ContinueTaskResponse = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  settlement: TaskSettlement,
  moved: Type.Object({
    cards: Type.Integer({ minimum: 0 }),
    topics: Type.Integer({ minimum: 0 }),
    pending: Type.Integer({ minimum: 0 }),
    splits: Type.Integer({ minimum: 0 }),
    planners: Type.Integer({ minimum: 0 }),
    drafts: Type.Integer({ minimum: 0 }),
    pipeline: Type.Boolean(),
    agreement: Type.Boolean(),
  }, strict),
}, strict);

/** POST /api/me/tasks/:taskId/stop：到此为止，可以补一句话。 */
export const StopTaskRequest = Type.Object({ note: Type.Optional(Note) }, strict);
export const TaskSettlementResponse = Type.Object({ taskId: Type.String({ minLength: 1 }), settlement: TaskSettlement }, strict);

/**
 * 月份页上这个月本人的一件 Task（本人这个月的 Mission 下、本人负责的；本体没登记负责人的算本人的）。
 * missionOutcome：所在 Mission 的成果（没写为 null）。
 * criteria：完成标准原文（本体验收标准，没有就按完成定义算一条），met 是这一条达到了（本人对它的卡里有一张最近一次有结论的验收算通过）。
 * dueDate：验收时间点（YYYY-MM-DD）：天枢里单独存的，没存按 Mission 今天以后最近的节点（都过了取最后一个），Mission 没写节点为 null。
 * disposition / deferredTo：去向（同复盘页：本期验收 / 延期到某月 / 已取消；没定过的按了结推：延续出去的算延期，到此为止的算取消）。
 * version：交付物到第几版，没交过为 null。running：还在跑的子会话（本机会话还开着的卡和专题）。blocked：受阻的子会话（卡连续两次验收没过）。
 * done：本人确认完成了（最新一版交付了，之后没返工），不问怎么办。
 * settlement：了结了的怎么了结的（completed / stopped / continued，延续去了哪在 settlement.to），没了结为 null。
 * continuedFrom：这件是从哪件延续来的，不是为 null。复盘的去向和评定在复盘页（monthReview.ts）。
 */
export const MonthTask = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  missionId: Type.String({ minLength: 1 }),
  missionTitle: Type.String(),
  missionOutcome: Nullable(Type.String()),
  name: Type.String(),
  criteria: Type.Array(Type.Object({ text: Type.String(), met: Type.Boolean() }, strict)),
  dueDate: Nullable(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
  disposition: Type.Union([Type.Literal("current"), Type.Literal("deferred"), Type.Literal("cancelled")]),
  deferredTo: Nullable(MonthPeriod),
  version: NullableInteger({ minimum: 1 }),
  running: Type.Integer({ minimum: 0 }),
  blocked: Type.Integer({ minimum: 0 }),
  done: Type.Boolean(),
  settlement: Nullable(TaskSettlement),
  continuedFrom: Nullable(TaskRef),
}, strict);

/**
 * 下个月 Co-Agent 的草稿（第 10.5 节；暂定形状，等溪南的接口定了再改）：Mission 和 Task，延续来的带「接着哪件」和那件现在的状态（summary 一行）。
 */
export const MonthDraft = Type.Object({
  period: MonthPeriod,
  missions: Type.Array(Type.Object({
    id: Type.String({ minLength: 1 }),
    title: Type.String(),
    tasks: Type.Array(Type.Object({
      id: Type.String({ minLength: 1 }),
      name: Type.String(),
      continuesFrom: Nullable(Type.Object({ taskId: Type.String({ minLength: 1 }), name: Type.String(), period: MonthPeriod, summary: Type.String() }, strict)),
    }, strict)),
  }, strict)),
}, strict);

/**
 * GET /api/me/months/:period（月份页）：这个月本人的 Task（按 Mission 编号、再按 Task 名）；
 * draft：下个月 Co-Agent 的草稿，现在一律为 null（等溪南的接口）。
 */
export const MonthPageResponse = Type.Object({
  period: MonthPeriod,
  tasks: Type.Array(MonthTask),
  draft: Nullable(MonthDraft),
}, strict);

export type TTaskRef = Static<typeof TaskRef>;
export type TTaskSettlement = Static<typeof TaskSettlement>;
export type TContinueTaskRequest = Static<typeof ContinueTaskRequest>;
export type TContinueTaskResponse = Static<typeof ContinueTaskResponse>;
export type TStopTaskRequest = Static<typeof StopTaskRequest>;
export type TTaskSettlementResponse = Static<typeof TaskSettlementResponse>;
export type TMonthTask = Static<typeof MonthTask>;
export type TMonthDraft = Static<typeof MonthDraft>;
export type TMonthPageResponse = Static<typeof MonthPageResponse>;
