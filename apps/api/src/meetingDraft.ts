import { randomUUID } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import type { TConversationCard } from "@warmap/contracts";
import { anchorOptions } from "./meetingWorld.js";
import type { Query } from "./meetingStore.js";

/**
 * 对话里约会议（draft_meeting 工具）：把本人一句话里的时间、人名换成一张会议卡，只读不写库；本人在卡上点「约好」才建会。
 * - 时间按公司时区（北京时间）换算：今天、明天、后天、大后天、周三、这周三、下周一、10月28日、28号、2026-10-28；
 *   下午三点、三点半、15:00。没说上下午的 1–6 点按下午；没说时长按 30 分钟。
 * - 主持人默认是本人；成员只能主持自己的会（同约会议面板），CEO 可以指定别人。
 * - 参会人按名字在人员目录里找：全名对上，或说的名字（至少两个字）是某人全名的一部分且只对上一个人；
 *   没对上、对上不止一个都标在卡上，不猜。
 * - 挂点：本人在开会那个月有 Mission 时默认挂第一个（同约会议面板）；CEO 默认不挂，在卡上选。
 */
export const DraftMeetingParams = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  date: Type.String({ minLength: 1, maxLength: 20 }),
  time: Type.String({ minLength: 1, maxLength: 20 }),
  durationMinutes: Type.Optional(Type.Integer({ minimum: 5, maximum: 600 })),
  endTime: Type.Optional(Type.String({ minLength: 1, maxLength: 20 })),
  host: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  participants: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 20 })),
}, { additionalProperties: false });
export type DraftMeetingArgs = Static<typeof DraftMeetingParams>;
export type MeetingDraftCard = Extract<TConversationCard, { kind: "meeting_draft" }>;
type Person = { personId: string; displayName: string };

const OFFSET_MS = 8 * 3_600_000;
const DEFAULT_MINUTES = 30;
const DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const WEEKDAYS: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 };
const RELATIVE_DAYS: Record<string, number> = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3 };
const WEEKDAY_NAMES = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const SELF = new Set(["我", "我自己", "本人", "自己"]);
const pad = (value: number) => String(value).padStart(2, "0");

type Day = { y: number; m: number; d: number };
const dayOf = (at: Date): Day => {
  const local = new Date(at.getTime() + OFFSET_MS);
  return { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate() };
};
const addDays = (day: Day, days: number): Day => dayOf(new Date(Date.UTC(day.y, day.m - 1, day.d + days) - OFFSET_MS));
/** 周一 1 … 周日 7。 */
const weekdayOf = (day: Day) => new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay() || 7;
const exists = (y: number, m: number, d: number) => {
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
};

/** 0–99 的阿拉伯数字或中文数字（十五、二十、三十五）。 */
function number(text: string): number | null {
  if (/^\d{1,2}$/.test(text)) return Number(text);
  const at = text.indexOf("十");
  if (at < 0) return text.length === 1 && text in DIGITS ? DIGITS[text] : null;
  const tens = at === 0 ? 1 : at === 1 ? DIGITS[text[0]] : undefined;
  const rest = text.slice(at + 1);
  const ones = rest === "" ? 0 : rest.length === 1 ? DIGITS[rest] : undefined;
  return tens === undefined || ones === undefined ? null : tens * 10 + ones;
}

/** 本人说的日期 → 北京时间的那一天；认不出为 null。 */
export function parseMeetingDate(raw: string, now: Date): Day | null {
  const text = raw.replace(/\s+/g, "");
  const today = dayOf(now);
  if (text in RELATIVE_DAYS) return addDays(today, RELATIVE_DAYS[text]);
  const week = /^(这|本|下|下个)?(?:周|星期|礼拜)([一二三四五六日天1-7])$/.exec(text);
  if (week) {
    const target = WEEKDAYS[week[2]];
    const current = weekdayOf(today);
    // 这周X：本周（周一起）的那天；下周X：下一周的那天；只说周X：从今天起最近的那天。
    const offset = week[1] === "下" || week[1] === "下个" ? 7 - current + target : week[1] ? target - current : (target - current + 7) % 7;
    return addDays(today, offset);
  }
  const full = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})[日号]?$/.exec(text);
  if (full) {
    const [y, m, d] = full.slice(1).map(Number);
    return exists(y, m, d) ? { y, m, d } : null;
  }
  // 只说月日：今年的那天，已经过去就是明年的。
  const monthDay = /^(\d{1,2})[-/.月](\d{1,2})[日号]?$/.exec(text);
  if (monthDay) {
    const [m, d] = monthDay.slice(1).map(Number);
    const y = m < today.m || (m === today.m && d < today.d) ? today.y + 1 : today.y;
    return exists(y, m, d) ? { y, m, d } : null;
  }
  // 只说几号：这个月的那天，已经过去就是下个月的。
  const dayOnly = /^(\d{1,2})[日号]$/.exec(text);
  if (dayOnly) {
    const d = Number(dayOnly[1]);
    const [y, m] = d < today.d ? (today.m === 12 ? [today.y + 1, 1] : [today.y, today.m + 1]) : [today.y, today.m];
    return exists(y, m, d) ? { y, m, d } : null;
  }
  return null;
}

/** 本人说的时刻 → 24 小时制；认不出为 null。没说上下午的 1–6 点按下午（工作时间里的会）。 */
export function parseMeetingTime(raw: string): { hour: number; minute: number } | null {
  let text = raw.replace(/\s+/g, "").replace(/：/g, ":").replace(/(?:钟|整)$/, "");
  const period = /^(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上)/.exec(text)?.[1];
  if (period) text = text.slice(period.length);
  let hour: number | null;
  let minute: number | null = 0;
  const clock = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (clock) {
    hour = Number(clock[1]);
    minute = Number(clock[2]);
  } else {
    const spoken = /^([0-9零一二两三四五六七八九十]{1,3})[点时](.*)$/.exec(text);
    if (!spoken) return null;
    hour = number(spoken[1]);
    const rest = spoken[2].replace(/分$/, "");
    minute = rest === "" ? 0 : rest === "半" ? 30 : rest === "一刻" ? 15 : rest === "三刻" ? 45 : number(rest.replace(/^[零〇]/, ""));
  }
  if (hour === null || minute === null || minute > 59) return null;
  if ((period === "下午" || period === "傍晚" || period === "晚上") && hour < 12) hour += 12;
  else if (period === "中午" && hour < 11) hour += 12;
  else if (!period && hour >= 1 && hour <= 6) hour += 12;
  return hour > 23 ? null : { hour, minute };
}

/** 一个人名在人员目录里：全名对上，或（至少两个字）是某人全名的一部分；对上不止一个、没对上都不选。 */
export function matchPerson(name: string, people: Person[]): { person: Person } | { reason: "not_found" | "ambiguous" } {
  const key = name.replace(/\s+/g, "");
  const exact = people.filter((person) => person.displayName === key);
  if (exact.length === 1) return { person: exact[0] };
  if (exact.length > 1) return { reason: "ambiguous" };
  const partial = [...key].length >= 2 ? people.filter((person) => person.displayName.includes(key)) : [];
  if (partial.length === 1) return { person: partial[0] };
  return { reason: partial.length > 1 ? "ambiguous" : "not_found" };
}

const atOf = (day: Day, hour: number, minute: number) => new Date(Date.UTC(day.y, day.m - 1, day.d, hour, minute) - OFFSET_MS);
const local = (at: Date) => new Date(at.getTime() + OFFSET_MS);
const clockOf = (at: Date) => `${pad(local(at).getUTCHours())}:${pad(local(at).getUTCMinutes())}`;
/** 卡上存的时刻：北京时间带 +08:00（约会议面板按日期、时刻直接取）。 */
const isoAt = (at: Date) => `${local(at).toISOString().slice(0, 16)}:00+08:00`;
const dayLabel = (at: Date) => { const day = dayOf(at); return `${day.m}月${day.d}日（${WEEKDAY_NAMES[weekdayOf(day)]}）`; };
/** 给模型复述用：10月27日（周二）15:00–15:30。 */
export const draftTimeLabel = (start: Date, end: Date) => `${dayLabel(start)}${clockOf(start)}–${clockOf(end)}`;

/**
 * 起草一张会议卡（只读：读人员目录、读那个月的挂点选项）。时间认不出、已经过去、结束不晚于开始时返回 reason，不出卡。
 */
export async function draftMeeting(
  deps: { q: Query; viewer: { personId: string; role: "ceo" | "member" }; people: Person[]; now: Date },
  args: DraftMeetingArgs,
): Promise<{ card: MeetingDraftCard; hostNote?: string } | { reason: string }> {
  const title = args.title.trim();
  if (!title) return { reason: "会议名称是空的" };
  const day = parseMeetingDate(args.date, deps.now);
  if (!day) return { reason: `日期「${args.date}」认不出` };
  const start = parseMeetingTime(args.time);
  if (!start) return { reason: `时间「${args.time}」认不出` };
  const startAt = atOf(day, start.hour, start.minute);
  if (startAt.getTime() <= deps.now.getTime()) return { reason: `${dayLabel(startAt)}${clockOf(startAt)}已经过去了` };
  let endAt = new Date(startAt.getTime() + (args.durationMinutes ?? DEFAULT_MINUTES) * 60_000);
  if (args.endTime) {
    const end = parseMeetingTime(args.endTime);
    if (!end) return { reason: `结束时间「${args.endTime}」认不出` };
    endAt = atOf(day, end.hour, end.minute);
    if (endAt <= startAt) return { reason: "结束时间要晚于开始时间" };
  }

  const self = deps.people.find((person) => person.personId === deps.viewer.personId) ?? { personId: deps.viewer.personId, displayName: "" };
  const unresolved: MeetingDraftCard["unresolved"] = [];
  let host: Person | null = self;
  let hostNote: string | undefined;
  const hostName = args.host?.trim();
  if (hostName && !SELF.has(hostName)) {
    const matched = matchPerson(hostName, deps.people);
    const isSelf = "person" in matched && matched.person.personId === self.personId;
    if (!isSelf && deps.viewer.role !== "ceo") hostNote = "成员只能主持自己约的会，主持人仍是本人";
    else if (!isSelf && "person" in matched) host = matched.person;
    else if (!isSelf && "reason" in matched) { host = null; unresolved.push({ name: hostName, reason: matched.reason, host: true }); }
  }
  const participants: Person[] = [];
  for (const raw of args.participants ?? []) {
    const name = raw.trim();
    if (!name || SELF.has(name)) continue;
    const matched = matchPerson(name, deps.people);
    if (!("person" in matched)) {
      if (!unresolved.some((item) => item.name === name)) unresolved.push({ name, reason: matched.reason });
      continue;
    }
    const { person } = matched;
    if (person.personId === host?.personId || participants.some((item) => item.personId === person.personId)) continue;
    participants.push({ personId: person.personId, displayName: person.displayName });
  }

  let anchor: MeetingDraftCard["anchor"] = null;
  if (deps.viewer.role !== "ceo") {
    const options = await anchorOptions(deps.q, null, isoAt(startAt).slice(0, 7), null);
    const mine = options.find((option) => option.kind === "mission" && option.ownerId === deps.viewer.personId);
    if (mine) anchor = { kind: mine.kind, id: mine.id, title: mine.title };
  }
  return {
    card: { kind: "meeting_draft", draftId: randomUUID(), title, scheduledAt: isoAt(startAt), endsAt: isoAt(endAt),
      host: host ? { personId: host.personId, displayName: host.displayName } : null, participants, unresolved, anchor },
    ...(hostNote ? { hostNote } : {}),
  };
}
