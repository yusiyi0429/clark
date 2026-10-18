import type { Query } from "./meetingStore.js";
import { BATTLEFIELD_MEMBERS } from "./weeklyReviews.js";

/**
 * 进展的读取权限（已定设计 5a 第 3 条，议题 2 最终规则）：CEO 能看全部；其他人只能看同一个战场里的（含自己的）。
 * Mission 卡（目标、计划）全员可读，不走这里（missions.ts 的 canReadMission）。
 * 「同一战场」按这条进展所在的那个月算，与周复盘的可见范围同一口径（weeklyReviews.ts 的 BATTLEFIELD_MEMBERS）：
 * 战场负责人、参与人、这个月 Mission 挂的战场、这个月任务卡所在的战场。
 * subject.battlefieldIds 给出时（进展挂在某个 Mission 上）只看这几个战场；没给时看这个人那个月所在的战场。
 */
export type ProgressViewer = { personId: string; role: string };
export type ProgressSubject = { personId: string; period: string; battlefieldIds?: string[] };

async function membersOf(q: Query, period: string): Promise<Map<string, Set<string>>> {
  // 只用到 $2（月份）；$1 占位与周复盘的写法一致。
  const rows = (await q(`WITH members(person_id, battlefield_id) AS (${BATTLEFIELD_MEMBERS}) SELECT person_id, battlefield_id FROM members WHERE $1::text IS NOT NULL`,
    ["-", period])).rows as { person_id: string | null; battlefield_id: string | null }[];
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.person_id || !row.battlefield_id) continue;
    const set = map.get(row.person_id) ?? new Set<string>();
    set.add(row.battlefield_id);
    map.set(row.person_id, set);
  }
  return map;
}

/** 一次读取里反复判断用：每个月的战场名单只查一次。 */
export function createProgressAccess(q: Query, viewer: ProgressViewer) {
  const periods = new Map<string, Promise<Map<string, Set<string>>>>();
  const members = (period: string) => {
    let loaded = periods.get(period);
    if (!loaded) { loaded = membersOf(q, period); periods.set(period, loaded); }
    return loaded;
  };
  return async function canRead(subject: ProgressSubject): Promise<boolean> {
    if (viewer.role === "ceo" || subject.personId === viewer.personId) return true;
    const map = await members(subject.period);
    const mine = map.get(viewer.personId);
    if (!mine?.size) return false;
    const theirs = subject.battlefieldIds?.length ? subject.battlefieldIds : [...(map.get(subject.personId) ?? [])];
    return theirs.some((id) => mine.has(id));
  };
}

export async function canReadProgress(q: Query, viewer: ProgressViewer, subject: ProgressSubject): Promise<boolean> {
  return createProgressAccess(q, viewer)(subject);
}
