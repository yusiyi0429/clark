/**
 * 伙伴台「开会」的几条小规矩（设计 2026-11-12 第二节）：默认标题、哪些已约的会现在能开、默认挂点、计时怎么写。
 * 只做计算，不碰接口和界面。
 */
import type { TWorldAnchor, TWorldAnchorOption } from "@warmap/contracts";
import { COMPANY_TIMEZONE } from "@/lib/companyTime";

/** 这场会的会议页（新首页里，旧的 /me/meetings/:id 会跳过来）。 */
export const meetingHref = (id: string) => `/me/work/meetings/${encodeURIComponent(id)}`;

/** 已约的会提前多久就能开。 */
export const EARLY_MS = 15 * 60_000;
/** 新的一场先占一小时（实际以按下「开完了」为准）。 */
export const SLOT_MS = 60 * 60_000;

const parts = (at: Date) => Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
  timeZone: COMPANY_TIMEZONE, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
}).formatToParts(at).map((part) => [part.type, part.value]));

/** 「11月12日 15:30 的会」（公司时区）。 */
export function defaultMeetingTitle(at: Date): string {
  const p = parts(at);
  return `${Number(p.month)}月${Number(p.day)}日 ${p.hour}:${p.minute} 的会`;
}

/** 「10:00–11:00」（公司时区）。 */
export function meetingSpan(startsAt: string, endsAt: string | null): string {
  const clock = (iso: string) => { const p = parts(new Date(iso)); return `${p.hour}:${p.minute}`; };
  return `${clock(startsAt)}–${clock(endsAt ?? new Date(Date.parse(startsAt) + SLOT_MS).toISOString())}`;
}

export type BookedMeeting = { meetingId: string; title: string; startsAt: string; endsAt: string | null; hostName: string; followUp?: boolean; processing?: unknown };

/** 我主持、现在能开的会：开始前 15 分钟到结束之间、还没开完、没在出记录（取消的接口本来就不给）；先开始的在前。 */
export function startableMeetings(meetings: readonly BookedMeeting[], me: string, now: number): BookedMeeting[] {
  return meetings
    .filter((meeting) => meeting.hostName === me && !meeting.followUp && !meeting.processing)
    .filter((meeting) => {
      const start = Date.parse(meeting.startsAt);
      const end = meeting.endsAt ? Date.parse(meeting.endsAt) : start + SLOT_MS;
      return now >= start - EARLY_MS && now <= end;
    })
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

type Picked = Pick<TWorldAnchor, "kind" | "id">;
const same = (a: Picked, b: Picked) => a.kind === b.kind && a.id === b.id;

/**
 * 默认挂点：在项目页里取这个项目本月目标的 Mission；否则上次开会用的；否则本月我的第一个 Mission；再没有就第一个能挑的。
 * 选项里没有的不用（挂点要在开会那个月的选项里，服务端也这么查）。
 */
export function defaultAnchor(options: readonly TWorldAnchorOption[], hints: { missionId?: string | null; last?: Picked | null; me: string }): TWorldAnchor | null {
  const pickable = options.filter((option) => option.kind !== "unit");
  const found = (hints.missionId ? pickable.find((option) => same(option, { kind: "mission", id: hints.missionId! })) : undefined)
    ?? (hints.last ? pickable.find((option) => same(option, hints.last!)) : undefined)
    ?? pickable.find((option) => option.kind === "mission" && option.ownerId === hints.me)
    ?? pickable.find((option) => option.kind === "mission")
    ?? pickable[0];
  return found ? { kind: found.kind, id: found.id, title: found.title } : null;
}

/** 走秒：一小时内「12:34」，过了「1:02:34」。 */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
