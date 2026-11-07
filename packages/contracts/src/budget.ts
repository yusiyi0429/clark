import { Type, type Static, type TSchema } from "@sinclair/typebox";

const strict = { additionalProperties: false } as const;
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** 预算模式（新首页设计 11.3）：auto 自动（默认，管线综合质量和消耗自己定）、set 设预算、unlimited 无上限。 */
export const BudgetMode = Type.Union([Type.Literal("auto"), Type.Literal("set"), Type.Literal("unlimited")]);

/**
 * 预算（设计 11.3、11.4）。天枢只存和读；到了怎么降档、怎么停由本机程序照 11.4 做。
 * mode = set 时至少一项上限，只给这次用得到的那几项：
 * - hours：真在跑的时长（小时）；排队、等额度恢复、等你回复都不算；
 * - weeklyPercent：从开工起，账号本周额度最多涨多少个百分点；
 * - money：TokenHub 金额上限，币种照 TokenHub 钱包的，不换算。
 * 别的模式三项都是 null（存的时候清掉）。规划员和验收员的花费算进 Task。
 */
export const Budget = Type.Object({
  mode: BudgetMode,
  hours: Nullable(Type.Number({ exclusiveMinimum: 0, maximum: 1000 })),
  weeklyPercent: Nullable(Type.Integer({ minimum: 1, maximum: 100 })),
  money: Nullable(Type.Object({ amount: Type.Number({ exclusiveMinimum: 0, maximum: 1_000_000 }), currency: Type.Union([Type.Literal("CNY"), Type.Literal("USD")]) }, strict)),
}, strict);

/**
 * GET / PUT /api/me/tasks/:taskId/budget（Task 负责人）：这件 Task 的预算，Task 详情里「预算」那一行。
 * inherited：没单独设过，用的是本人在「偏好」里的缺省（GET /api/me/budget-default）。开工框选的模式随 AcceptCardDraftsRequest.budget 存进来。
 */
export const TaskBudgetResponse = Type.Object({ taskId: Type.String({ minLength: 1 }), budget: Budget, inherited: Type.Boolean() }, strict);

export type TBudgetMode = Static<typeof BudgetMode>;
export type TBudget = Static<typeof Budget>;
export type TTaskBudgetResponse = Static<typeof TaskBudgetResponse>;
