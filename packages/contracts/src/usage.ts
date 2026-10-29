import { Type, type Static } from "@sinclair/typebox";

/**
 * 使用周报（管理员视图「使用」一栏，只给管理员）：谁在用、频率、关键路径的漏斗和中断点、本周问题台账、和上周对比。
 * 只有人名、计数和时间，不带对话正文。文案（步骤名、中断原因、台账名称）由服务端给，界面和导出的 Markdown 用同一份。
 */
const Instant = Type.String({ format: "date-time" });
const Day = Type.String({ format: "date" });
const Count = Type.Integer({ minimum: 0 });

export const UsageSummary = Type.Object({
  /** 名单里的人（CEO、DRI、参与人）。 */
  roster: Count,
  /** 这一周至少有一天用过天枢的人。 */
  activePeople: Count,
  /** 活跃的人平均用了几天（一位小数）。 */
  avgActiveDays: Type.Number({ minimum: 0 }),
  /** 发问（不含「继续」「重新回答」）。 */
  asks: Count,
}, { additionalProperties: false });

export const UsagePersonRow = Type.Object({
  personId: Type.String(),
  displayName: Type.String(),
  /** 用过天枢的日期（北京时间）。 */
  days: Type.Array(Day),
  asks: Count,
  /** 全局对话里中断的次数。 */
  breaks: Count,
  previousActiveDays: Count,
}, { additionalProperties: false });

export const UsageBreak = Type.Object({
  /** 卡在哪一步之后（这一步到了、下一步没到）。 */
  step: Type.String(),
  label: Type.String(),
  count: Count,
}, { additionalProperties: false });

export const UsageStep = Type.Object({
  key: Type.String(),
  label: Type.String(),
  /** 到达这一步的单位数（全局对话是次，会议是场，上手是人）。 */
  units: Count,
  people: Count,
}, { additionalProperties: false });

export const UsagePathKey = Type.Union([Type.Literal("conversation"), Type.Literal("meeting"), Type.Literal("memory"), Type.Literal("onboarding")]);
export const UsagePath = Type.Object({
  key: UsagePathKey,
  title: Type.String(),
  unit: Type.String(),
  /** funnel：前一步到了才有后一步；counts：几项各自计数（个人记忆）。 */
  shape: Type.Union([Type.Literal("funnel"), Type.Literal("counts")]),
  steps: Type.Array(UsageStep),
  /** 流失最多的那一步（到了这一步、没到下一步的最多）；没有流失为空。 */
  stuckStep: Type.Union([Type.String(), Type.Null()]),
  breaks: Type.Array(UsageBreak),
  /** 上周同一条路径各步的到达数（按 steps 的顺序）。 */
  previousUnits: Type.Array(Count),
}, { additionalProperties: false });

export const UsageLedgerItem = Type.Object({
  key: Type.String(),
  source: Type.Union([Type.Literal("quality"), Type.Literal("feedback"), Type.Literal("job"), Type.Literal("world")]),
  label: Type.String(),
  count: Count,
  people: Count,
  /** 还没在管理员视图里标「已解决」的条数。 */
  open: Count,
  previousCount: Count,
  lastAt: Instant,
}, { additionalProperties: false });

export const UsageWeekReport = Type.Object({
  /** 周一（北京时间）。 */
  weekStart: Day,
  weekEnd: Day,
  generatedAt: Instant,
  /** 本周还没过完：现算的，不存。 */
  live: Type.Boolean(),
  summary: UsageSummary,
  previous: UsageSummary,
  people: Type.Array(UsagePersonRow),
  paths: Type.Array(UsagePath),
  ledger: Type.Array(UsageLedgerItem),
}, { additionalProperties: false });

export const UsageWeekEntry = Type.Object({ weekStart: Day, live: Type.Boolean() }, { additionalProperties: false });
export const UsageResponse = Type.Object({
  /** 本周（现算）在前，之后是已生成的各周，新的在前。 */
  weeks: Type.Array(UsageWeekEntry),
  report: UsageWeekReport,
}, { additionalProperties: false });
export const UsageQuery = Type.Object({ week: Type.Optional(Day) }, { additionalProperties: false });

/** 上手走到的一步（界面打开这一步时报一次）；步骤名与上手流程一致。 */
export const OnboardingStepName = Type.Union([
  Type.Literal("buddy"), Type.Literal("hello"), Type.Literal("tour-notifications"), Type.Literal("tour-board"), Type.Literal("mission-flow"), Type.Literal("work"),
  Type.Literal("radar"), Type.Literal("voiceprint"), Type.Literal("connect"), Type.Literal("collector"), Type.Literal("scan"), Type.Literal("review"),
  Type.Literal("delegation"), Type.Literal("start"),
]);
export const OnboardingStepUsageRequest = Type.Object({ step: OnboardingStepName }, { additionalProperties: false });

export type TUsageSummary = Static<typeof UsageSummary>;
export type TUsagePersonRow = Static<typeof UsagePersonRow>;
export type TUsageBreak = Static<typeof UsageBreak>;
export type TUsageStep = Static<typeof UsageStep>;
export type TUsagePathKey = Static<typeof UsagePathKey>;
export type TUsagePath = Static<typeof UsagePath>;
export type TUsageLedgerItem = Static<typeof UsageLedgerItem>;
export type TUsageWeekReport = Static<typeof UsageWeekReport>;
export type TUsageResponse = Static<typeof UsageResponse>;
export type TOnboardingStepName = Static<typeof OnboardingStepName>;
