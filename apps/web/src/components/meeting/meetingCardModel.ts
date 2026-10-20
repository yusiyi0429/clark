import type { TMeetingCardDraft, TMeetingCardSection, TMeetingCardSync, TMeetingCardV1Payload, TMeetingCardView } from "@warmap/contracts";
import { COMPANY_TIMEZONE } from "@/lib/companyTime";

/** 会议卡上显示的那一份：草稿或确认版（确认版的修改不带 stale）。 */
export type CardContent = TMeetingCardDraft | TMeetingCardV1Payload;
type Change = CardContent["objectChanges"][number];

const blank = (value: string) => !value.trim();
const sameSection = (a: TMeetingCardSection, b: TMeetingCardSection) => a.heading === b.heading && a.body === b.body;
const sameChange = (a: Change, b: Change) => a.targetRef === b.targetRef && a.after.text === b.after.text;
const names = (content: CardContent) => content.participants.map((person) => person.name).join("\n");

/** 草稿和当前确认版内容不同（有一份没确认的修改）。 */
export function cardDiffers(draft: TMeetingCardDraft, payload: TMeetingCardV1Payload): boolean {
  return draft.title !== payload.title || draft.occurredAt !== payload.occurredAt || draft.summary !== payload.summary || names(draft) !== names(payload)
    || draft.sections.length !== payload.sections.length
    || draft.sections.some((section, index) => section.id !== payload.sections[index].id || !sameSection(section, payload.sections[index]))
    || draft.objectChanges.length !== payload.objectChanges.length
    || draft.objectChanges.some((change, index) => change.id !== payload.objectChanges[index].id || !sameChange(change, payload.objectChanges[index]));
}
export const viewDiffers = (view: TMeetingCardView) => Boolean(view.draft && view.confirmed && cardDiffers(view.draft, view.confirmed.payload));

export type DiffRow<T> = { item: T; state: "same" | "changed" | "deleted"; was: T | null };
/**
 * 修改中按 id 和确认版比（没有确认版时全是 same）：内容不同、新加的、和别的项调了先后的算 changed，was 是确认版里的那一项（界面在新文字上方划线显示）；
 * 确认版有、草稿里删掉的放回原来的位置（跟在它前面那项后面），state deleted。
 */
function diffRows<T extends { id: string }>(items: T[], confirmed: T[] | null, same: (a: T, b: T) => boolean): DiffRow<T>[] {
  if (!confirmed) return items.map((item) => ({ item, state: "same", was: null }));
  const before = new Map(confirmed.map((item) => [item.id, item]));
  const kept = new Set(items.map((item) => item.id));
  const nowOrder = items.map((item) => item.id).filter((id) => before.has(id));
  const oldOrder = confirmed.map((item) => item.id).filter((id) => kept.has(id));
  const rows: DiffRow<T>[] = items.map((item) => {
    const was = before.get(item.id) ?? null;
    const moved = was !== null && nowOrder.indexOf(item.id) !== oldOrder.indexOf(item.id);
    return { item, state: was && !moved && same(was, item) ? "same" : "changed", was };
  });
  confirmed.forEach((old, index) => {
    if (kept.has(old.id)) return;
    let after = -1;
    for (let previous = index - 1; previous >= 0 && after < 0; previous -= 1) after = rows.findIndex((row) => row.item.id === confirmed[previous].id);
    rows.splice(after + 1, 0, { item: old, state: "deleted", was: old });
  });
  return rows;
}
export const sectionRows = (sections: TMeetingCardSection[], confirmed: TMeetingCardSection[] | null) => diffRows(sections, confirmed, sameSection);
export const changeRows = (changes: Change[], confirmed: Change[] | null) => diffRows<Change>(changes, confirmed, sameChange);

/** 「依据：第 1、3 段」：按当前段落顺序编号，指不到的不写；一段都指不到时不显示。 */
export function basisLabel(sectionIds: string[], sections: TMeetingCardSection[]): string | null {
  const numbers = [...new Set(sectionIds)].map((id) => sections.findIndex((section) => section.id === id) + 1).filter((n) => n > 0).sort((a, b) => a - b);
  return numbers.length ? `依据：第 ${numbers.join("、")} 段` : null;
}

/** 草稿能存：会名、每段标题和正文、每条改后内容都不空，至少一段。 */
export const draftReady = (draft: TMeetingCardDraft) => !blank(draft.title) && draft.sections.length > 0
  && draft.sections.every((section) => !blank(section.heading) && !blank(section.body)) && draft.objectChanges.every((change) => !blank(change.after.text));

/** 离开一个字段时，清空了的必填项恢复成上次存下的（用户删段走「⋯ 删除」）；还没存过的新段两项都空就去掉。 */
export function restoreBlank(local: TMeetingCardDraft, saved: TMeetingCardDraft | null): TMeetingCardDraft {
  if (!saved) return local;
  const savedSections = new Map(saved.sections.map((section) => [section.id, section]));
  const savedChanges = new Map(saved.objectChanges.map((change) => [change.id, change]));
  let changed = false;
  const title = blank(local.title) ? saved.title : local.title;
  const sections = local.sections.flatMap((section) => {
    const old = savedSections.get(section.id);
    if (!old && blank(section.heading) && blank(section.body)) { changed = true; return []; }
    if (!old || (!blank(section.heading) && !blank(section.body))) return [section];
    changed = true;
    return [{ ...section, heading: blank(section.heading) ? old.heading : section.heading, body: blank(section.body) ? old.body : section.body }];
  });
  const objectChanges = local.objectChanges.map((change) => {
    const old = savedChanges.get(change.id);
    if (!old || !blank(change.after.text)) return change;
    changed = true;
    return { ...change, after: { text: old.after.text } };
  });
  return changed || title !== local.title ? { ...local, title, sections, objectChanges } : local;
}

/** 「放弃修改」：把草稿内容换回确认版（挂点、来源仍以服务端为准）。 */
export function draftFromConfirmed(draft: TMeetingCardDraft, payload: TMeetingCardV1Payload): TMeetingCardDraft {
  return { ...draft, title: payload.title, occurredAt: payload.occurredAt, participants: payload.participants, summary: payload.summary,
    sections: payload.sections, objectChanges: payload.objectChanges.map((change) => ({ ...change, stale: false })) };
}

/** 删掉的段落如果被行动项引为依据，存草稿时连行动项一起交（去掉那段）；否则不交，服务端沿用已存的。 */
export function actionItemsAfterDelete(draft: TMeetingCardDraft, items: TMeetingCardView["actionItems"]): TMeetingCardView["actionItems"] | undefined {
  const ids = new Set(draft.sections.map((section) => section.id));
  if (!items.some((item) => item.basisSectionIds.some((id) => !ids.has(id)))) return undefined;
  return items.map((item) => ({ ...item, basisSectionIds: item.basisSectionIds.filter((id) => ids.has(id)) }));
}

export function newSectionId(sections: { id: string }[]): string {
  let id = "";
  do id = `sec-${Math.random().toString(36).slice(2, 10)}`; while (!id || sections.some((section) => section.id === id));
  return id;
}

type SyncTone = "wait" | "done" | "warn" | "fail" | "off";
export type SyncRow = { key: string; text: string; tone: SyncTone; retry: boolean };
const withReason = (label: string, reason: string | null) => (reason ? `${label} · ${reason}` : label);
/**
 * 同步状态逐行：会议事件一行（写入失败可重试），每条对象修改一行；被新版本取代的不显示。
 * 对象只说已更新 / 更新中 / 未更新 · 原因 / 更新失败 · 原因 / 目标未定（对象重试这一期不做）。
 */
export function syncRows(sync: TMeetingCardSync, changes: { id: string }[]): SyncRow[] {
  const { event } = sync;
  const eventRow: SyncRow = event.status === "succeeded" ? { key: "event", text: "会议事件 · 已写入", tone: "done", retry: false }
    : event.status === "failed" ? { key: "event", text: `会议事件 · ${withReason("写入失败", event.error)}`, tone: "fail", retry: true }
      : event.status === "skipped" ? { key: "event", text: "会议事件 · 不写入", tone: "off", retry: false }
        : { key: "event", text: "会议事件 · 写入中", tone: "wait", retry: false };
  const objectRows = sync.objects.filter((object) => object.status !== "superseded").map((object): SyncRow => {
    const index = changes.findIndex((change) => change.id === object.changeId);
    const name = object.title || `修改 ${index >= 0 ? index + 1 : ""}`.trim();
    const row = (state: string, tone: SyncTone): SyncRow => ({ key: object.changeId, text: `${name} · ${state}`, tone, retry: false });
    switch (object.status) {
      case "updated": return row("已更新", "done");
      case "pending": return row("更新中", "wait");
      case "conflict": return row("未更新 · 目标已变", "warn");
      case "not_allowed": return row(withReason("未更新", object.error), "warn");
      case "failed": return row(withReason("更新失败", object.error), "fail");
      default: return object.error && object.error !== "目标未定" ? row(withReason("未更新", object.error), object.error === "不写入" ? "off" : "warn") : row("目标未定", "fail");
    }
  });
  return [eventRow, ...objectRows];
}
export const syncPending = (sync: TMeetingCardSync | null) => Boolean(sync && (sync.event.status === "pending" || sync.objects.some((object) => object.status === "pending")));

/** 发言段：逐字稿里的一句（会议页已有的逐字稿，不另取）。 */
export type RecordTurn = { id: string; speakerId: string; startedAt?: string; text: string };
/** 出处定位「turn-0012..turn-0015」或单个发言段 → 那几句原话；逐字稿里找不到时 null。 */
export function excerptTurns(locator: string | null, turns: RecordTurn[]): RecordTurn[] | null {
  if (!locator) return null;
  const [first, last = first] = locator.split("..");
  const start = turns.findIndex((turn) => turn.id === first);
  const end = turns.findIndex((turn) => turn.id === last);
  return start >= 0 && end >= start ? turns.slice(start, end + 1) : null;
}
const clock = (iso: string | undefined) => {
  const at = iso ? new Date(iso) : null;
  return at && Number.isFinite(at.getTime()) ? at.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: COMPANY_TIMEZONE }) : "";
};
/** 原话的时段「14:03–14:07」（公司时区）；没有时间时空串。 */
export function excerptSpan(turns: RecordTurn[]): string {
  const from = clock(turns[0]?.startedAt);
  const to = clock(turns[turns.length - 1]?.startedAt);
  return from && to && from !== to ? `${from}–${to}` : from || to;
}

/** 日期时间选择器的值（公司时区「YYYY-MM-DDTHH:mm」）↔ 带时区的 ISO。 */
export function companyInput(iso: string | null): string {
  const at = iso ? new Date(iso) : null;
  if (!at || !Number.isFinite(at.getTime())) return "";
  return `${at.toLocaleDateString("sv-SE", { timeZone: COMPANY_TIMEZONE })}T${clock(iso!)}`;
}
export const fromCompanyInput = (value: string) => (value ? `${value}:00+08:00` : null);
/** 实际时间在将来（服务端不收）。 */
export const inFuture = (iso: string | null, now = Date.now()) => Boolean(iso && Date.parse(iso) > now);
