import type { TMissionCardStatus } from "@warmap/contracts";
import type { WorldHead } from "./worldClient.js";

/**
 * 通知栏「N 月任务卡」（10/28）：本月任务卡已载入本体，签发看的是本体里全员 Mission 的生命周期，不再是 9 月复盘起算的 72 小时。
 * 只读一张列表（本月、类型 Mission），按生命周期中文名分组计数；五分钟缓存，读失败沿用上次的，从没读成过就不显示。
 */
export type MissionCardWorld = { listObjects(filters: { type: string; period: string }): Promise<WorldHead[]> };

const CACHE_MS = 5 * 60_000;
/** 已成立、已关闭都算签发完了；其余（草稿、已承诺……）是还在签发中。 */
const SETTLED = new Set(["established", "closed"]);
const ORDER = ["draft", "committed", "established", "closed"];

type Lifecycle = { status?: string; display_name?: string };

export function summarizeMissionCards(period: string, heads: WorldHead[]): TMissionCardStatus {
  const groups = new Map<string, { status: string; label: string; count: number }>();
  let settled = 0;
  for (const head of heads) {
    if (head.object_type !== "Mission") continue;
    const lifecycle = (head.lifecycle && typeof head.lifecycle === "object" ? head.lifecycle : {}) as Lifecycle;
    const status = lifecycle.status ?? "unknown";
    const group = groups.get(status) ?? { status, label: lifecycle.display_name ?? status, count: 0 };
    group.count += 1;
    groups.set(status, group);
    if (SETTLED.has(status)) settled += 1;
  }
  const rank = (status: string) => (ORDER.includes(status) ? ORDER.indexOf(status) : ORDER.length);
  const sorted = [...groups.values()].sort((a, b) => rank(a.status) - rank(b.status));
  return { period, total: sorted.reduce((sum, group) => sum + group.count, 0), settled, groups: sorted.map(({ label, count }) => ({ label, count })) };
}

export function createMissionCardStatusReader(world: MissionCardWorld | null, now: () => Date, period: (at: Date) => string) {
  let cached: { at: number; value: TMissionCardStatus } | null = null;
  return async (): Promise<TMissionCardStatus | null> => {
    if (!world) return null;
    const at = now();
    const current = period(at);
    if (cached && cached.value.period === current && at.getTime() - cached.at < CACHE_MS) return cached.value;
    try {
      cached = { at: at.getTime(), value: summarizeMissionCards(current, await world.listObjects({ type: "Mission", period: current })) };
    } catch {
      if (!cached || cached.value.period !== current) return null;
    }
    return cached.value;
  };
}
