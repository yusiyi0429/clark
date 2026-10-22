import { Type, type Static } from "@sinclair/typebox";
import { DateOnly, Period, TaskView } from "./tasks.js";

/** 计划点名字最多 10 个字。 */
const MarkLabel = Type.String({ minLength: 1, maxLength: 10 });

/** 时间轴上的一天；workday 按节假日日历算，含调休补班。 */
export const HomePlanDay = Type.Object(
  { date: DateOnly, workday: Type.Boolean() },
  { additionalProperties: false },
);

/** 签定的关口：来自个人任务的里程碑，只读，不能拖、不能删。 */
export const HomePlanGate = Type.Object(
  { missionId: Type.String({ minLength: 1 }), date: DateOnly, label: Type.String() },
  { additionalProperties: false },
);

/** 我的计划点：只存在天枢本地，可以加、拖、删。 */
export const HomePlanMark = Type.Object(
  { id: Type.String({ format: "uuid" }), missionId: Type.String({ minLength: 1 }), date: DateOnly, label: MarkLabel },
  { additionalProperties: false },
);

/** 本体里挂在 Mission 下的 Task：name 是对象标题，doneDefinition 和 criteria 取自 definition 块。 */
export const HomePlanTask = Type.Object(
  {
    taskId: Type.String({ minLength: 1 }),
    missionId: Type.String({ minLength: 1 }),
    name: Type.String(),
    doneDefinition: Type.Union([Type.String(), Type.Null()]),
    criteria: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

/** color 按 Mission 在列表里的顺序取固定色板，同一个 Mission 每次都是同一个颜色。 */
export const HomePlanMission = Type.Object(
  {
    missionId: Type.String({ minLength: 1 }),
    code: Type.String(),
    title: Type.String(),
    cardId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    color: Type.String(),
  },
  { additionalProperties: false },
);

/**
 * Activity 就是执行事项；column 由服务端分好：已完成、本周、之后。overdue：没完成，且截止早于本周一或挂在之前月份的 Mission 下。
 * missionId 是事项挂的 Mission，独立事项为 null；任务卡没确认时 item.mission 为空，按 Mission 归组看这里。
 * 之前月份 Mission 下没做完的也在 activities 里（放本周），它的 missionId 不在 missions 里。
 */
export const HomePlanActivity = Type.Object(
  {
    item: TaskView,
    missionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    column: Type.Union([Type.Literal("done"), Type.Literal("week"), Type.Literal("later")]),
    overdue: Type.Boolean(),
  },
  { additionalProperties: false },
);

/**
 * 成员首页的 Mission 计划视图：一次读全。
 * 本月没有 Mission 时回退显示最近一个有 Mission 的月份，这时 fallbackFrom 等于 period；不回退为 null。
 * today / weekStart / weekEnd 按公司时区；本周是今天所在的周一到周日，可能跨月。
 */
export const HomePlanResponse = Type.Object(
  {
    period: Period,
    fallbackFrom: Type.Union([Period, Type.Null()]),
    today: DateOnly,
    weekStart: DateOnly,
    weekEnd: DateOnly,
    days: Type.Array(HomePlanDay),
    missions: Type.Array(HomePlanMission),
    gates: Type.Array(HomePlanGate),
    marks: Type.Array(HomePlanMark),
    tasks: Type.Array(HomePlanTask),
    activities: Type.Array(HomePlanActivity),
  },
  { additionalProperties: false },
);

/** 加计划点：只能挂在本人的 Mission 下，日期要在这个 Mission 的月份里。 */
export const CreatePlanMarkRequest = Type.Object(
  { missionId: Type.String({ minLength: 1 }), date: DateOnly, label: MarkLabel },
  { additionalProperties: false },
);

/** 拖到别的日子或改名；至少带一个字段，不能换 Mission。 */
export const PatchPlanMarkRequest = Type.Object(
  { date: Type.Optional(DateOnly), label: Type.Optional(MarkLabel) },
  { additionalProperties: false, minProperties: 1 },
);

export type THomePlanDay = Static<typeof HomePlanDay>;
export type THomePlanGate = Static<typeof HomePlanGate>;
export type THomePlanMark = Static<typeof HomePlanMark>;
export type THomePlanTask = Static<typeof HomePlanTask>;
export type THomePlanMission = Static<typeof HomePlanMission>;
export type THomePlanActivity = Static<typeof HomePlanActivity>;
export type THomePlanResponse = Static<typeof HomePlanResponse>;
export type TCreatePlanMarkRequest = Static<typeof CreatePlanMarkRequest>;
export type TPatchPlanMarkRequest = Static<typeof PatchPlanMarkRequest>;
