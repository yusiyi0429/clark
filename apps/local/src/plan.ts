import type { TLocalPlanEntry, TLocalPlanProgress } from "@warmap/contracts";

/** 派活单上的「第 3/6 步」：从计划条目算（V2 设计 20.6）。 */
export function planProgress(entries: TLocalPlanEntry[]): TLocalPlanProgress {
  const done = entries.filter((e) => e.status === "completed").length;
  const cur = entries.findIndex((e) => e.status === "in_progress");
  return { done, total: entries.length, step: cur >= 0 ? cur + 1 : done, current: cur >= 0 ? entries[cur]!.content : null };
}
