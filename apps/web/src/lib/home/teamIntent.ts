import type { TRequestPerson } from "@warmap/contracts";
import { calendarDate } from "@/lib/companyTime";

export type TeamKind = "share" | "question";
export type TeamIntent = {
  kind: TeamKind;
  names: string[];
  text: string;
  sourceUrl: string;
  dueAt: string;
  review: boolean;
};

const NO_NAMES = /^(?:同事|团队|大家|所有人|全员|对方|他们|她们|伙伴)$/;
const WEEKLY = /(?:每周|每个礼拜|固定|本周|这周).{0,12}(?:开销|进展表|周进展|工作进展)|(?:每周开销|每周进展|周进展表)/;
const SEND = /^(?:(?:请|帮我|请帮我|麻烦)(?:把|将)?\s*)?(?:转发给|转给|分享给|发送给|发给|传给)\s*(.*)$/s;
const ASK = /^(?:(?:请|帮我|请帮我|麻烦)\s*)?(?:问问|问一下|问|询问)\s*(.+)$/s;

/** 这些地址只能由真实名册解出 ID；不根据姓名猜部门成员，不默认选中重名者。 */
export function resolveTeamNames(names: string[], people: TRequestPerson[]) {
  const ids = new Set<string>();
  const unresolved: string[] = [];
  for (const name of names) {
    const matches = people.filter((person) => person.displayName === name || person.personId === name);
    if (matches.length === 1) ids.add(matches[0]!.personId);
    else unresolved.push(name);
  }
  return { ids: [...ids], unresolved };
}

/** 取用户原话中明确写出的截止日。相对日期和只给日期的情况在表单里核对（按公司时区）。 */
function deadlineOf(text: string, now: Date): string {
  const match = /(?:截止(?:到|时间)?[为是：:\s]*|最晚\s*)?(\d{4}-\d{2}-\d{2}|今天|明天|后天|(?:下)?(?:周|星期)[一二三四五六日天])\s*(?:(\d{1,2})[点:：](\d{2})?(?:分)?)?\s*(?:以前|之前|前|截止)(?:[回交给提交答]|[，。,.!！\s]|$)/.exec(text)
    ?? /(?:截止(?:到|时间)?|最晚)[为是：:\s]*(\d{4}-\d{2}-\d{2}|今天|明天|后天|(?:下)?(?:周|星期)[一二三四五六日天])(?:\s*(\d{1,2})[点:：](\d{2})?)?/.exec(text);
  if (!match) return "";
  const [, term, hour, minute] = match;
  let day = term!;
  if (!/^\d{4}-/.test(day)) {
    const today = new Date(calendarDate(now.toISOString()) + "T00:00:00Z");
    let offset = ["今天", "明天", "后天"].indexOf(day);
    if (offset === -1) {
      const target = "一二三四五六日".indexOf(day.slice(-1).replace("天", "日"));
      const weekday = (today.getUTCDay() + 6) % 7;
      offset = day.startsWith("下") ? 7 + target - weekday : (7 + target - weekday) % 7;
    }
    today.setUTCDate(today.getUTCDate() + offset);
    day = today.toISOString().slice(0, 10);
  }
  if (hour && (Number(hour) > 23 || Number(minute || 0) > 59)) return "";
  const date = new Date(day + "T00:00:00Z");
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) return "";
  return day + "T" + (hour ? hour.padStart(2, "0") + ":" + (minute || "00") : "23:59");
}

export function publicLink(value: string): string | null {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function intent(kind: TeamKind, addresses: string, body: string, review: boolean, now: Date): TeamIntent {
  const names = addresses.trim().replace(/[。！!]+$/, "").split(/\s*(?:、|，|,|以及|还有|和|与|及)\s*/u)
    .map((entry) => entry.trim().replace(/^@/, "").replace(/(?:的)?(?:天枢)?伙伴$/, "").trim()).filter(Boolean);
  const text = body.trim();
  const sourceUrl = kind === "share" ? publicLink(text) : null;
  const dueAt = kind === "question" ? deadlineOf(text, now) : "";
  return { kind, names, text: sourceUrl ? "" : text, sourceUrl: sourceUrl ? text : "", dueAt,
    review: review || !!dueAt || !names.length || names.some((name) => NO_NAMES.test(name)) };
}

function addressAndBody(value: string): [string, string] {
  const labelled = /[，,]\s*(?:附言|备注|说明)\s*[:：]\s*/.exec(value);
  const firstColon = value.search(/[:：\n]/);
  if (labelled && (firstColon < 0 || labelled.index < firstColon)) return [value.slice(0, labelled.index), value.slice(labelled.index + labelled[0].length)];
  const split = /[:：\n]/.exec(value);
  if (split) return [value.slice(0, split.index), value.slice(split.index + 1)];
  const fileNote = /[，,]\s*(?:附言|备注|说明|告诉(?:他们|她们|他|她))\s*/.exec(value);
  if (fileNote) return [value.slice(0, fileNote.index), value.slice(fileNote.index + fileNote[0].length)];
  const buddyEnd = /(?:的)?伙伴[，,]\s*/.exec(value);
  if (buddyEnd) return [value.slice(0, buddyEnd.index), value.slice(buddyEnd.index + buddyEnd[0].length)];
  return [value, ""];
}

/** 截获明确的投递/征集指令；普通问答、阅读刚收到的资料、原来的固定收集仍交给对话。 */
export function teamIntent(raw: string, files: readonly File[], now = new Date()): TeamIntent | null {
  const text = raw.trim();
  if (!text) return files.length ? intent("share", "", "", true, now) : null;
  const send = SEND.exec(text);
  if (send) {
    const [names, body] = addressAndBody(send[1]!);
    // “发给我的文件写了什么”是在问伙伴，不是发件指令。
    if (/^(?:我(?:自己)?|本人)(?:的|[？?]|$)/.test(names)) return null;
    return intent("share", names, body, false, now);
  }
  // 「把这个文件发给小林」带实际附件可直发。提到某份文件时不能把文件名充作正文。
  const trailing = /^(?:(?:请帮我|帮我|请|麻烦)\s*)?(?:把|将)(.+?)(?:转发给|转给|分享给|发送给|发给|传给)\s*(.+)$/s.exec(text);
  if (trailing) {
    const [names, note] = addressAndBody(trailing[2]!);
    const content = trailing[1]!.trim();
    const literal = /^(?:「([\s\S]+)」|“([\s\S]+)”|"([\s\S]+)")$/.exec(content);
    const quoted = literal?.slice(1).find(Boolean);
    const sourceUrl = publicLink(content);
    const exactFile = files.length > 0 && (/^(?:这(?:个|份|些)|所附|附上(?:的)?)?(?:文件|附件|材料|图片)$/.test(content) || files.some((file) => file.name === content));
    const parsed = intent("share", names, [quoted, note].filter(Boolean).join("\n\n"), !exactFile && !quoted && !sourceUrl, now);
    return sourceUrl ? { ...parsed, sourceUrl: content } : parsed;
  }
  if (WEEKLY.test(text) && /收集|征集|填写|填报|发起|提供|给我|汇报|提交/.test(text)) return null;
  const ask = ASK.exec(text);
  if (ask && !text.startsWith("请问")) {
    const [names, question] = addressAndBody(ask[1]!);
    if (/^(?:你|我|伙伴|我的伙伴|一下|为什么|如何|怎么|刚收到)/.test(names)) return null;
    if (question || names.endsWith("伙伴")) return intent("question", names, question, false, now);
    const informal = /^(.{1,35}?)[，,]\s*(.+)$/s.exec(names);
    if (informal) return intent("question", informal[1]!, informal[2]!, true, now);
    return null;
  }
  const collect = /^(?:(?:请帮我|帮我|请|麻烦)\s*)?(?:向|找|跟)(.+?)(?:收集|征集|收一下|征求)([：:\s]*)(.+)$/s.exec(text);
  if (collect) return intent("question", collect[1]!, collect[3]!, !/[：:]/.test(collect[2]!), now);
  const provide = /^(?:请|麻烦)(.{1,45}?)(?:分别|各自|各|都)?(?:给我|向我提供|提供|回复我|提交给我|发我|发给我)(.+)$/s.exec(text);
  if (provide && !/^(你|帮我|告诉我)/.test(provide[1]!)) return intent("question", provide[1]!, text, true, now);
  const unspecified = /^(?:帮我|请)?(?:发起(?:一[条个次])?)?(?:临时征集|征集信息|收集信息)[：:\s]*(.*)$/s.exec(text);
  if (unspecified) return intent("question", "", unspecified[1]!, true, now);
  const draft = /^(?:请)?(?:帮我)?(?:起草|拟写|拟一段|整理)(.+?)(?:转发给|转给|发给)(.+)$/s.exec(text);
  return draft ? intent("share", draft[2]!, "", true, now) : null;
}

export const isTeamDraft = (text: string, files: readonly File[]) => teamIntent(text, files) !== null;
