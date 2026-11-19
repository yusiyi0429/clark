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
const Day = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });

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
 * criteria：完成标准（本体验收标准，没有就按完成定义算一条；本人在天枢里改过的按改后的），met 是这一条达到了（本人对它的卡里有一张最近一次有结论的验收算通过）；
 *   changed 是这一条和本体里的不一样（改过或新加的），original 是它替换掉的那条本体原文（同一位置的本体原文已不在改后的标准里时才有）。
 * added：天枢里「+ 添一件」新加的（没有本体原文，也写「未进本体」，不出「恢复」）。
 * edited：本人在天枢里改过名字或标准、还没进本体时，本体里的原文（name / criteria，没改的那一样为 null）；没改过为 null。网页写「未进本体」「原 〈原文〉」「恢复」。
 * dueDate：验收时间点（YYYY-MM-DD）：本人改过的（按 Task 存的那一份），没改过用 missionDueDate；两样都没有为 null。
 * missionDueDate：「原」验收时间点：天枢第一次读到这件 Task 时记下的当时最近的 Mission 节点，之后不往后滚（Mission 没写节点为 null）；
 *   和 dueDate 不同时网页写「原 11/18」。
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
  criteria: Type.Array(Type.Object({ text: Type.String(), met: Type.Boolean(), changed: Type.Boolean(), original: Nullable(Type.String()) }, strict)),
  edited: Nullable(Type.Object({ name: Nullable(Type.String()), criteria: Nullable(Type.Array(Type.String())) }, strict)),
  added: Type.Boolean(),
  dueDate: Nullable(Day),
  missionDueDate: Nullable(Day),
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

/** PUT /api/me/tasks/:taskId/due-date：存这件 Task 的验收时间点（按 Task 存，不要求挂项目；只有 Task 负责人能改）；null 不存了，退回 Mission 的节点。 */
export const SetTaskDueDateRequest = Type.Object({ dueDate: Nullable(Day) }, strict);
export const TaskDueDateResponse = Type.Object({ taskId: Type.String({ minLength: 1 }), name: Type.String(), dueDate: Nullable(Day) }, strict);

/**
 * PUT /api/me/tasks/:taskId/goal：就地改名字和完成标准（天枢里先生效、标未进本体，天枢不写本体；只有 Task 负责人能改）。
 * 没带的那一样照旧；和本体一样就撤掉那一样（「恢复」就是把原文存回去）。criteria 是整份，清空一条再存就是删。
 */
export const PutTaskGoalRequest = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  criteria: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 30 })),
}, { ...strict, minProperties: 1 });
export const TaskGoalResponse = Type.Object({ taskId: Type.String({ minLength: 1 }), name: Type.String(), criteria: Type.Array(Type.String()) }, strict);

/** POST /api/me/months/:period/tasks：「+ 添一件」，在本人这个月的 Mission 下新建一件天枢里的 Task（不写本体）。 */
export const AddMonthTaskRequest = Type.Object({ missionId: Type.String({ minLength: 1 }), name: Type.String({ minLength: 1, maxLength: 200 }) }, strict);
export const AddMonthTaskResponse = Type.Object({ taskId: Type.String({ minLength: 1 }) }, strict);

export type TTaskRef = Static<typeof TaskRef>;
export type TTaskSettlement = Static<typeof TaskSettlement>;
export type TContinueTaskRequest = Static<typeof ContinueTaskRequest>;
export type TContinueTaskResponse = Static<typeof ContinueTaskResponse>;
export type TStopTaskRequest = Static<typeof StopTaskRequest>;
export type TTaskSettlementResponse = Static<typeof TaskSettlementResponse>;
export type TMonthTask = Static<typeof MonthTask>;
export type TMonthDraft = Static<typeof MonthDraft>;
export type TMonthPageResponse = Static<typeof MonthPageResponse>;
export type TSetTaskDueDateRequest = Static<typeof SetTaskDueDateRequest>;
export type TTaskDueDateResponse = Static<typeof TaskDueDateResponse>;
export type TPutTaskGoalRequest = Static<typeof PutTaskGoalRequest>;
export type TTaskGoalResponse = Static<typeof TaskGoalResponse>;
export type TAddMonthTaskRequest = Static<typeof AddMonthTaskRequest>;
export type TAddMonthTaskResponse = Static<typeof AddMonthTaskResponse>;
