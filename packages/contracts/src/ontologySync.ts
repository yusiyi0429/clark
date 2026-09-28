import { Type, type Static } from "@sinclair/typebox";
import { TaskMissionRef, TaskProgressLink, TaskProgressSource, TaskStatus } from "./tasks.js";

/** 工单 13：本体每周来拉成员写进执行事项的进展。周是 ISO 周，按北京时间周一 00:00 到下周一 00:00。 */
export const OntologyWeek = Type.String({ pattern: "^\\d{4}-W(0[1-9]|[1-4]\\d|5[0-3])$" });

export const WeeklyProgressQuery = Type.Object(
  { week: Type.Optional(OntologyWeek) },
  { additionalProperties: false },
);

/** 一条进展；条目只增不改，本体按 id 去重。 */
export const WeeklyProgressEntry = Type.Object({
  id: Type.String({ format: "uuid" }),
  body: Type.String({ minLength: 1, maxLength: 2000 }),
  links: Type.Array(TaskProgressLink, { maxItems: 5 }),
  source: TaskProgressSource,
  createdAt: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

/** 某人这一周写过进展的一件执行事项；本体按 personId + week + itemId 覆盖写入。status 是拉取时的当前状态。 */
export const WeeklyProgressItem = Type.Object({
  itemId: Type.String({ format: "uuid" }),
  title: Type.String({ minLength: 1 }),
  role: Type.Union([Type.Literal("owner"), Type.Literal("collaborator")]),
  status: TaskStatus,
  dueDate: Type.Union([Type.String({ format: "date" }), Type.Null()]),
  mission: Type.Union([TaskMissionRef, Type.Null()]),
  entries: Type.Array(WeeklyProgressEntry, { minItems: 1 }),
}, { additionalProperties: false });

export const WeeklyProgressPerson = Type.Object({
  personId: Type.String({ minLength: 1 }),
  displayName: Type.String({ minLength: 1 }),
  items: Type.Array(WeeklyProgressItem, { minItems: 1 }),
}, { additionalProperties: false });

export const WeeklyProgressResponse = Type.Object({
  week: OntologyWeek,
  /** 周起止（含起不含止），带 +08:00 偏移的 ISO 时间。 */
  from: Type.String({ minLength: 1 }),
  to: Type.String({ minLength: 1 }),
  generatedAt: Type.String({ minLength: 1 }),
  people: Type.Array(WeeklyProgressPerson),
}, { additionalProperties: false });

export type TWeeklyProgressQuery = Static<typeof WeeklyProgressQuery>;
export type TWeeklyProgressEntry = Static<typeof WeeklyProgressEntry>;
export type TWeeklyProgressItem = Static<typeof WeeklyProgressItem>;
export type TWeeklyProgressPerson = Static<typeof WeeklyProgressPerson>;
export type TWeeklyProgressResponse = Static<typeof WeeklyProgressResponse>;
