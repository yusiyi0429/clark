import type { TTaskProgressSource, TTaskView, TWeeklyProgressItem, TWeeklyProgressPerson, TWeeklyProgressResponse } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { projectTaskProgress } from "./taskProgress.js";
import { getTaskView } from "./tasks.js";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const BEIJING = 8 * 60 * 60 * 1000;
const monday = (day: Date) => new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY);
const firstMonday = (year: number) => monday(new Date(`${String(year).padStart(4, "0")}-01-04T00:00:00Z`));
const dateAtBeijingMidnight = (day: Date) => `${day.toISOString().slice(0, 10)}T00:00:00+08:00`;
const atBeijing = (date: Date) => new Date(date.getTime() + BEIJING).toISOString().replace("Z", "+08:00");

/** ISO 周按北京时间的日历日计算；SQL 使用带偏移的闭开区间。 */
export function weekRange(week: string | undefined, now: Date): { week: string; from: string; to: string } {
  let start: Date;
  let selected: string;
  if (week === undefined) {
    const localDay = new Date(new Date(now.getTime() + BEIJING).toISOString().slice(0, 10) + "T00:00:00Z");
    start = monday(localDay);
    const thursday = new Date(start.getTime() + 3 * DAY);
    const year = thursday.getUTCFullYear();
    const number = Math.floor((start.getTime() - firstMonday(year).getTime()) / WEEK) + 1;
    selected = `${year}-W${String(number).padStart(2, "0")}`;
  } else {
    const match = /^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/.exec(week);
    if (!match) throw new RangeError("周格式不合法");
    const year = Number(match[1]);
    if (year < 1 || year > 9998) throw new RangeError("周不存在");
    start = new Date(firstMonday(year).getTime() + (Number(match[2]) - 1) * WEEK);
    if (start >= firstMonday(year + 1)) throw new RangeError("周不存在");
    selected = week;
  }
  return { week: selected, from: dateAtBeijingMidnight(start), to: dateAtBeijingMidnight(new Date(start.getTime() + WEEK)) };
}

type ProgressRow = {
  id: string; task_id: string; author_id: string; source: TTaskProgressSource;
  body: string; links: TWeeklyProgressItem["entries"][number]["links"]; created_at: Date;
};

export async function loadWeeklyProgress(q: Query, range: ReturnType<typeof weekRange>, names: Map<string, string>): Promise<TWeeklyProgressResponse> {
  const rows = (await q(`SELECT id::text,task_id::text,author_id,source,body,links,created_at
    FROM task_progress WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
    ORDER BY created_at,id`, [range.from, range.to])).rows as ProgressRow[];
  const views = new Map<string, TTaskView | null>();
  const people = new Map<string, { person: TWeeklyProgressPerson; items: Map<string, TWeeklyProgressItem> }>();
  for (const row of rows) {
    if (!views.has(row.task_id)) views.set(row.task_id, await getTaskView(q, row.task_id, names));
    const task = views.get(row.task_id);
    if (!task) continue;
    let group = people.get(row.author_id);
    if (!group) {
      group = { person: { personId: row.author_id, displayName: names.get(row.author_id) ?? row.author_id, items: [] }, items: new Map() };
      people.set(row.author_id, group);
    }
    let item = group.items.get(row.task_id);
    if (!item) {
      item = { itemId: row.task_id, title: task.title, role: task.owner.personId === row.author_id ? "owner" : "collaborator",
        status: task.status, dueDate: task.dueDate, mission: task.mission, entries: [] };
      group.items.set(row.task_id, item);
      group.person.items.push(item);
    }
    const { id, body, links, source, createdAt } = projectTaskProgress(row, names);
    item.entries.push({ id, body, links, source, createdAt });
  }
  return { ...range, generatedAt: atBeijing(new Date()),
    people: [...people.values()].map(({ person }) => person)
      .sort((a, b) => a.displayName.localeCompare(b.displayName, "zh-CN") || a.personId.localeCompare(b.personId)) };
}
