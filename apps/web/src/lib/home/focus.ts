/**
 * 首页「等你」（2026-11-16 重新设计，设计稿 .scratch/home-redesign-20261116 第 4 节）：伙伴认为现在该你看的事，一份清单、一处排序。
 * 服务端的等你、会议接口里的会、「这台电脑没连上」在这里合成一份，按四档排：
 * 1 快开始、正在开的会（开始前 15 分钟起到结束），按开始时间；
 * 2 卡着活的（批准、提问、额度；有活在等这台电脑时的「电脑没连上」），等得久的在前；
 * 3 24 小时内到期或已过截止的，截止早的在前；
 * 4 其余（含开完 72 小时内要你处理的会），新的在前；没有活在等时「电脑没连上」排最后。
 * 同一场会只留一行：服务端等你里已经指向这场会的，会议接口那一份不再列。这台电脑正在录的那场在伙伴台胶囊上，不进。
 */
import { BLOCKING } from "./derive";
import { EARLY_MS, SLOT_MS } from "./meeting";
import type { PartnerMeeting } from "./partnerMeetingFeed";
import type { WaitingItem } from "./types";

export type FocusRow =
  | { kind: "machine" }
  | { kind: "waiting"; item: WaitingItem }
  | { kind: "meeting"; item: PartnerMeeting; when: "soon" | "after" };

export const FOCUS_VISIBLE = 5;
export const AFTER_MEETING_MS = 72 * 3_600_000;
const DUE_SOON_MS = 24 * 3_600_000;

/** 首页露几行：超过 6 件只露 5 件，其余收进「还有 N 件」；正好 6 件不为一件多一行折叠。 */
export function visibleCount(total: number): number {
  return total <= FOCUS_VISIBLE + 1 ? total : FOCUS_VISIBLE;
}

const instant = (value: string | null | undefined) => (value ? Date.parse(value) : Number.NaN);

/** 会议的结束时刻：没写结束时间的按开始后一小时。 */
export function meetingEnd(item: Pick<PartnerMeeting, "at" | "endsAt">): number {
  const end = instant(item.endsAt);
  return Number.isFinite(end) ? end : instant(item.at) + SLOT_MS;
}

function meetingWhen(item: PartnerMeeting, now: number): "soon" | "after" | null {
  const end = meetingEnd(item);
  if (!item.allDay && (item.stage === "scheduled" || item.stage === "live") && now >= instant(item.at) - EARLY_MS && now < end) return "soon";
  if (item.needsAction && end <= now && now - end <= AFTER_MEETING_MS) return "after";
  return null;
}

export function focusList({ waiting, meetings, offline, recordingMeetingId, now }: {
  waiting: WaitingItem[];
  meetings: PartnerMeeting[];
  offline: boolean;
  recordingMeetingId: string | null;
  now: number;
}): FocusRow[] {
  const shown = new Set(waiting.flatMap(({ open }) => (open.kind === "meeting" ? [open.id] : [])));
  const rows: FocusRow[] = waiting.map((item) => ({ kind: "waiting", item }));
  for (const item of meetings) {
    if (item.meetingId && (shown.has(item.meetingId) || item.meetingId === recordingMeetingId)) continue;
    const when = meetingWhen(item, now);
    if (when) rows.push({ kind: "meeting", item, when });
  }
  const machineBlocking = waiting.some((item) => item.answer === "inline_local");
  if (offline) rows.push({ kind: "machine" });

  // 每行一个（档，档内的比较值）；档内值小的在前，同值保持原次序。
  const rank = (row: FocusRow): [number, number] => {
    if (row.kind === "machine") return machineBlocking ? [2, Number.NEGATIVE_INFINITY] : [5, 0];
    if (row.kind === "meeting") return row.when === "soon" ? [1, instant(row.item.at)] : [4, -instant(row.item.at)];
    const { item } = row;
    if (BLOCKING.has(item.kind)) return [2, finite(instant(item.at))];
    const due = instant(item.dueAt);
    if (Number.isFinite(due) && due - now <= DUE_SOON_MS) return [3, due];
    return [4, -finite(instant(item.at), Number.NEGATIVE_INFINITY)];
  };
  return rows
    .map((row, index) => ({ row, index, key: rank(row) }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.index - b.index)
    .map(({ row }) => row);
}

const finite = (value: number, fallback = Number.POSITIVE_INFINITY) => (Number.isFinite(value) ? value : fallback);
