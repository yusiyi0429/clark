import { pinyin } from "pinyin-pro";
import type { TRequestKind } from "@warmap/contracts";
import type { Query } from "../meetingStore.js";

/**
 * 「昨天巨杰拜托我填的那个表……你帮我问问」：从本人手上没完成的待办里定位是哪一件（⑨ 传话，议题 7）。
 * 全部确定性规则，不交给模型挑：
 * - 人名按读音匹配（声调不管，zh/z、ch/c、sh/s、n/l、-ng/-n 视为同音），语音把「巨杰」转成「居杰」也对得上；
 *   认全名、名字、杰哥 / 老唐 / 唐总这类叫法。说了人名就只在这个人发来的待办里找，对不上就是没有，绝不换成别人的。
 * - 「昨天」「上周三」「10 月 17 日」这类时间前后各放宽一天。
 * - 还剩不止一件时，按原话和标题、说明的字面重合挑：只有一件对得上才算定位到，否则交给本人点选。
 */
export type OpenTodo = {
  requestId: string; kind: TRequestKind; title: string; body: string;
  initiatorId: string; initiatorName: string; sentAt: Date;
};
export type TodoPerson = { personId: string; displayName: string };
export type LocateHints = { person?: string; date?: string; about?: string };
export type TimeWindow = { from: Date; to: Date };
export type LocateResult =
  | { status: "one"; todo: OpenTodo }
  | { status: "many"; todos: OpenTodo[]; total: number }
  /** person：本人说到的人（对得上人员目录就是目录里的名字）；nearMisses：这个人发来、但不在说的时间里的待办。 */
  | { status: "none"; person: string | null; nearMisses: OpenTodo[] };

/** 点选卡最多列几件。 */
const MAX_PICK = 4;
const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

export const TODO_KIND_LABELS: Record<TRequestKind, string> = { relay: "传话", collection: "信息收集", impact: "影响", supplement: "补充请求", doc_change: "文档变更" };

/** 本人手上没完成的待办：发给本人、已发出、本人那一行还没标记完成的请求，新的在前。 */
export async function listOpenTodos(q: Query, personId: string, names: Map<string, string>, limit = 50): Promise<OpenTodo[]> {
  const rows = (await q(`SELECT r.id, r.kind, r.title, r.body, r.initiator_id, r.sent_at FROM request_recipients rr JOIN requests r ON r.id = rr.request_id
    WHERE rr.person_id = $1 AND rr.status = 'pending' AND r.status <> 'draft' ORDER BY r.sent_at DESC, r.id LIMIT ${Math.max(1, Math.floor(limit))}`, [personId])).rows as
    { id: string; kind: TRequestKind; title: string; body: string; initiator_id: string; sent_at: Date }[];
  return rows.map((row) => ({ requestId: row.id, kind: row.kind, title: row.title, body: row.body, initiatorId: row.initiator_id,
    initiatorName: names.get(row.initiator_id) ?? row.initiator_id, sentAt: row.sent_at }));
}

/* ---------- 读音 ---------- */

/** 一个音节的模糊键：去掉翘舌、n/l 不分、前后鼻音不分。 */
export function fuzzySyllable(syllable: string): string {
  return syllable.toLowerCase().replace(/^([zcs])h/, "$1").replace(/^n/, "l").replace(/ng$/, "n");
}

const HAN = /\p{Script=Han}/u;
const readingCache = new Map<string, { exact: Set<string>; fuzzy: Set<string> }>();
/** 一个字所有读音（多音字都算，不带声调）与它们的模糊键；不是汉字的按小写原样。 */
function readings(char: string): { exact: Set<string>; fuzzy: Set<string> } {
  let found = readingCache.get(char);
  if (!found) {
    const exact = HAN.test(char) ? pinyin(char, { toneType: "none", type: "array", multiple: true }) as string[] : [char.toLowerCase()];
    found = { exact: new Set(exact), fuzzy: new Set(exact.map(fuzzySyllable)) };
    if (readingCache.size > 5000) readingCache.clear();
    readingCache.set(char, found);
  }
  return found;
}

const overlaps = (a: Set<string>, b: Set<string>) => [...a].some((item) => b.has(item));

/**
 * 叫法里每个字的读音：名字里的字只取它在名字里的那个读音（「南」在人名里读 nan，不能拿「南无」的 na 去对「那个」），
 * 老 / 小 / 总 / 哥 / 姐这些称呼字取常用读音。原话一侧仍是所有读音（语音转写可能写成任何同音字）。
 */
const formReadingCache = new Map<string, string[]>();
function formReadings(form: string, name: string): string[] {
  const key = `${name}|${form}`;
  let found = formReadingCache.get(key);
  if (!found) {
    const nameChars = [...name];
    const nameReadings = pinyin(name, { toneType: "none", type: "array", surname: "head" }) as string[];
    const single = (char: string) => HAN.test(char) ? (pinyin(char, { toneType: "none", type: "array" }) as string[])[0] : char.toLowerCase();
    found = [...form].map((char) => {
      const index = nameChars.indexOf(char);
      return index >= 0 && nameReadings.length === nameChars.length ? nameReadings[index] : single(char);
    });
    if (formReadingCache.size > 5000) formReadingCache.clear();
    formReadingCache.set(key, found);
  }
  return found;
}

/** 原话里有没有一段和 form 同音（逐字比读音，只认连续的汉字）；fuzzy 时按模糊键比。 */
function soundsIn(text: string, form: string, name: string, fuzzy: boolean): boolean {
  const key = fuzzy ? "fuzzy" : "exact";
  const chars = [...text];
  const target = formReadings(form, name).map((reading) => new Set([fuzzy ? fuzzySyllable(reading) : reading]));
  if (target.length < 2) return false;
  for (let start = 0; start + target.length <= chars.length; start += 1) {
    if (target.every((reading, offset) => HAN.test(chars[start + offset]) && overlaps(readings(chars[start + offset])[key], reading))) return true;
  }
  return false;
}

/**
 * 对得上的程度：1 字面一样，2 读音一样（不管声调），3 只是模糊同音（翘舌、n/l、前后鼻音）。
 * 「是一张表」和「斯一」只在第 3 级同音，原话里有字面或同音更好的人名时不算。
 */
type Tier = 1 | 2 | 3;
function tierOf(text: string, form: string, name: string): Tier | null {
  if (text.includes(form)) return 1;
  if (soundsIn(text, form, name, false)) return 2;
  if (soundsIn(text, form, name, true)) return 3;
  return null;
}

/** 复姓：名字按两个字的姓拆。 */
const COMPOUND_SURNAMES = ["欧阳", "司马", "上官", "诸葛", "东方", "皇甫", "尉迟", "公孙", "慕容", "长孙", "宇文", "司徒", "夏侯", "令狐"];

/** 一个人在口语里的叫法：全名、名字、杰哥 / 杰姐、老唐 / 小唐 / 唐总 / 唐哥 / 唐姐。都至少两个字。 */
export function nameForms(displayName: string): string[] {
  const name = displayName.trim();
  const forms = new Set<string>([name]);
  if (!HAN.test(name) || [...name].length < 2) return [...forms];
  const surname = COMPOUND_SURNAMES.find((item) => name.startsWith(item)) ?? [...name][0];
  const given = name.slice(surname.length);
  if ([...given].length >= 2) forms.add(given);
  if (given) for (const suffix of ["哥", "姐"]) forms.add(`${[...given].at(-1)}${suffix}`);
  for (const form of [`老${surname}`, `小${surname}`, `${surname}总`, `${surname}哥`, `${surname}姐`]) forms.add(form);
  return [...forms].filter((form) => [...form].length >= 2);
}

/**
 * 原话里说到了谁（叫法见 nameForms）：只留对得上程度最好的那一级（字面 > 同音 > 模糊同音），不到 maxTier 的不算。
 */
export function mentionedPeople<T extends TodoPerson>(text: string, people: T[], maxTier: Tier = 3): T[] {
  if (!text.trim()) return [];
  const tiers = people.map((person) => nameForms(person.displayName).reduce<Tier | null>((best, form) => {
    const tier = tierOf(text, form, person.displayName.trim());
    return tier !== null && (best === null || tier < best) ? tier : best;
  }, null));
  const best = Math.min(...tiers.map((tier) => tier ?? 4));
  return best > maxTier ? [] : people.filter((_, index) => tiers[index] === best);
}

/** 模型摘出的「人」有时不是人名（「财务」「那个同事」）：这类不当作说到了某个人。 */
const NOT_A_NAME = /同事|财务|行政|人事|客户|对方|那个人|他|她|HR|hr/;

/* ---------- 时间 ---------- */

/** 北京时间的日历日（UTC 零点表示）。 */
const shanghaiDay = (at: Date) => { const local = new Date(at.getTime() + SHANGHAI_OFFSET_MS); return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()); };
/** 北京时间某日 0 点对应的时刻。 */
const dayStart = (day: number) => new Date(day - SHANGHAI_OFFSET_MS);
const around = (firstDay: number, lastDay: number): TimeWindow => ({ from: dayStart(firstDay - DAY_MS), to: dayStart(lastDay + 2 * DAY_MS) });

const NUMERALS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const numberOf = (text: string) => /^\d+$/.test(text) ? Number(text) : text === "十" ? 10
  : text.startsWith("十") ? 10 + (NUMERALS[text[1]] ?? 0) : text.endsWith("十") ? (NUMERALS[text[0]] ?? 0) * 10
  : text.length === 3 && text[1] === "十" ? (NUMERALS[text[0]] ?? 0) * 10 + (NUMERALS[text[2]] ?? 0) : NUMERALS[text] ?? Number.NaN;
const WEEKDAYS: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 末: 6 };
const NUM = "(\\d{1,2}|[一二两三四五六七八九十]{1,3})";

/**
 * 原话里说的时间（北京时间），前后各放宽一天；说的是一周就是那一周再前后各一天。没说时间返回 null。
 * 认：今天 / 刚才、昨天、前天、大前天、N 天前、（上）周 X、上周、这周、M 月 D 日、D 号、YYYY-MM-DD。
 * 「上周五」有两种理解（10/18 定）：按日历周往前一周的周五，或最近过去的那个周五（周日说「上周五」常指前天）。
 * 两种理解落在不同的日子时都返回，由 locateTodo 分别去找；落在同一天只返回一个。
 */
export function timeWindows(text: string, now: Date): TimeWindow[] | null {
  const today = shanghaiDay(now);
  const lastWeek = /(?<!上)上(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/.exec(text);
  if (lastWeek) {
    const weekday = new Date(today).getUTCDay() || 7;
    const calendar = today - (weekday - 1) * DAY_MS + (WEEKDAYS[lastWeek[1]] - 8) * DAY_MS;
    // 最近过去的那个周 X（不含今天）。
    const back = (weekday - WEEKDAYS[lastWeek[1]] + 7) % 7 || 7;
    const recent = today - back * DAY_MS;
    return recent === calendar ? [around(calendar, calendar)] : [around(calendar, calendar), around(recent, recent)];
  }
  const window = timeWindow(text, now);
  return window ? [window] : null;
}

function timeWindow(text: string, now: Date): TimeWindow | null {
  const today = shanghaiDay(now);
  const weekday = new Date(today).getUTCDay() || 7;
  const monday = today - (weekday - 1) * DAY_MS;
  const single = (day: number) => around(day, day);
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) return single(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  const monthDay = new RegExp(`${NUM}月${NUM}(?:日|号)?`).exec(text);
  if (monthDay) {
    const month = numberOf(monthDay[1]), date = numberOf(monthDay[2]);
    if (month >= 1 && month <= 12 && date >= 1 && date <= 31) {
      const year = new Date(today).getUTCFullYear();
      const day = Date.UTC(year, month - 1, date);
      return single(day > today ? Date.UTC(year - 1, month - 1, date) : day);
    }
  }
  if (/大前天/.test(text)) return single(today - 3 * DAY_MS);
  if (/前天/.test(text)) return single(today - 2 * DAY_MS);
  if (/昨(天|晚|日|儿|早)/.test(text)) return single(today - DAY_MS);
  if (/今(天|早|晚|儿)|刚才|刚刚/.test(text)) return single(today);
  const ago = new RegExp(`${NUM}天(?:前|以前|之前)`).exec(text);
  if (ago && numberOf(ago[1]) >= 1) return single(today - numberOf(ago[1]) * DAY_MS);
  const day = /(上上|上|这|本)?(?:个)?(?:周|星期|礼拜)([一二三四五六日天末])/.exec(text);
  if (day) {
    const shift = day[1] === "上上" ? -14 : day[1] === "上" ? -7 : 0;
    const target = monday + (shift + WEEKDAYS[day[2]] - 1) * DAY_MS;
    if (day[2] === "末") return around(target, target + DAY_MS);
    // 只说「周三」：这周的周三还没到就是上周的。
    return single(!day[1] && target > today ? target - 7 * DAY_MS : target);
  }
  if (/上上(?:个)?(?:周|星期|礼拜)/.test(text)) return around(monday - 14 * DAY_MS, monday - 8 * DAY_MS);
  if (/上(?:个)?(?:周|星期|礼拜)/.test(text)) return around(monday - 7 * DAY_MS, monday - DAY_MS);
  if (/(这|本)(?:个)?(?:周|星期|礼拜)/.test(text)) return around(monday, today);
  const dayOfMonth = new RegExp(`(?<![月\\d])${NUM}号`).exec(text);
  if (dayOfMonth) {
    const date = numberOf(dayOfMonth[1]);
    if (date >= 1 && date <= 31) {
      const current = new Date(today);
      const candidate = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), date);
      return single(candidate > today ? Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, date) : candidate);
    }
  }
  return null;
}

const within = (todo: OpenTodo, window: TimeWindow) => todo.sentAt >= window.from && todo.sentAt < window.to;

/* ---------- 说的是哪件事 ---------- */

/** 常被拿来指代一件待办的东西：「那个表」「那份合同」。 */
const OBJECT_WORDS = ["表格", "表", "文档", "文件", "合同", "报告", "方案", "截图", "数据", "链接", "材料", "清单", "周报", "月报", "简历", "发票", "报销", "预算", "海报", "视频", "PPT", "ppt"];
/** 不说明是哪件事的字：人称、指代、请求、时间。 */
const FILLER = new Set([..."我你他她它们的了吗呢吧啊呀那这个些帮问下一给让请把是在有就都也还要想说做填写弄发拜托昨今前天刚才上周星期礼拜号月日早晚和跟里"]);

/** 原话里说到这件待办的程度：标题里的词权重高，说明里的低。只用来在剩下的几件里挑。 */
function relevance(text: string, todo: OpenTodo): number {
  const title = todo.title, body = todo.body.slice(0, 500);
  let score = 0;
  for (const word of OBJECT_WORDS) if (text.includes(word) && title.includes(word)) score += 2;
  const chars = [...text];
  const seen = new Set<string>();
  for (let index = 0; index + 1 < chars.length; index += 1) {
    const pair = chars[index] + chars[index + 1];
    if (seen.has(pair) || !HAN.test(chars[index]) || !HAN.test(chars[index + 1]) || FILLER.has(chars[index]) && FILLER.has(chars[index + 1])) continue;
    seen.add(pair);
    if (title.includes(pair)) score += 2;
    else if (body.includes(pair)) score += 1;
  }
  return score;
}

/**
 * 定位：说了人 → 只看这些人发来的；说了时间 → 只看前后一天内的；还剩不止一件 → 按说到的事挑，只有一件对得上才定位到。
 * people 是人员目录（用来认出「说到的人不在发起人里」，好如实说没找到）；hints 是模型从原话里摘出的人名、日期、事（原话里没有时补充）。
 */
export function locateTodo(input: { message: string; hints?: LocateHints; todos: OpenTodo[]; people: TodoPerson[]; now: Date }): LocateResult {
  const { message, todos, now } = input;
  const hints = input.hints ?? {};
  const initiators = [...new Map(todos.map((todo) => [todo.initiatorId, { personId: todo.initiatorId, displayName: todo.initiatorName }])).values()];
  const hintPerson = hints.person?.trim() ?? "";
  const spoken = [message, hintPerson].join("\n");
  // 原话里只认字面或同音；模糊同音只认模型摘出的人名（原话里「是一张表」不能当成「斯一」）。两边都有时取交集。
  const fromMessage = mentionedPeople(message, initiators, 2).map((person) => person.personId);
  const fromHint = hintPerson ? mentionedPeople(hintPerson, initiators, 3).map((person) => person.personId) : [];
  const both = fromMessage.filter((id) => fromHint.includes(id));
  const said = new Set(fromMessage.length ? (both.length ? both : fromMessage) : fromHint);
  // 不是发起人的人只认字面或同音（模糊同音太容易把「是一」听成人名）；模型摘出的人名对不上任何人时照原样说。
  const outsider = said.size ? null
    : mentionedPeople(spoken, input.people, 2)[0]?.displayName ?? (hintPerson && !NOT_A_NAME.test(hintPerson) ? hintPerson : null);
  const hintDay = hints.date && /^\d{4}-\d{2}-\d{2}$/.test(hints.date) ? timeWindows(hints.date, now) : null;
  const windows = timeWindows(message, now) ?? hintDay;

  // 说到了人，但不是任何一件待办的发起人：如实说没有，绝不换成别人发的。
  if (outsider) return { status: "none", person: outsider, nearMisses: [] };
  const byPerson = said.size ? todos.filter((todo) => said.has(todo.initiatorId)) : todos;
  // 时间有两种理解时各找一遍：只有一种找得到就按它往下走；两种找到的不是同一批就交给本人点选。
  const found = windows ? windows.map((window) => byPerson.filter((todo) => within(todo, window))).filter((list) => list.length) : [byPerson];
  const key = (list: OpenTodo[]) => list.map((todo) => todo.requestId).sort().join();
  if (found.length > 1 && key(found[0]) !== key(found[1])) {
    const union = [...new Map(found.flat().map((todo) => [todo.requestId, todo])).values()].sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
    return { status: "many", todos: union.slice(0, MAX_PICK), total: union.length };
  }
  const inTime = found[0] ?? [];
  if (!inTime.length) {
    const person = said.size ? initiators.filter((item) => said.has(item.personId)).map((item) => item.displayName).join("、") : null;
    return { status: "none", person, nearMisses: said.size ? byPerson.slice(0, MAX_PICK) : [] };
  }
  if (inTime.length === 1) return { status: "one", todo: inTime[0] };
  const text = `${message}\n${hints.about ?? ""}`;
  const scored = inTime.map((todo) => ({ todo, score: relevance(text, todo) })).sort((a, b) => b.score - a.score || b.todo.sentAt.getTime() - a.todo.sentAt.getTime());
  const hits = scored.filter((item) => item.score > 0);
  if (hits.length === 1) return { status: "one", todo: hits[0].todo };
  const pool = hits.length ? hits : scored;
  return { status: "many", todos: pool.slice(0, MAX_PICK).map((item) => item.todo), total: pool.length };
}
