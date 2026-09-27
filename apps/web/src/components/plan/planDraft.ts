import type { TMonthPlanResponse, TSaveMonthPlanRequest, TTaskView } from "@warmap/contracts";

export type Step = { taskId?: string; version?: number; clientId?: string; title: string; startDate: string; dueDate: string; status: TTaskView["status"]; source?: TTaskView["source"] };
export type PlanGroup = { missionId: string | null; title: string; battlefieldName: string | null; milestones: TMonthPlanResponse["groups"][number]["milestones"]; items: Step[] };

export function draftFromPlan(plan: TMonthPlanResponse): PlanGroup[] {
  return plan.groups.map(group => ({ ...group, items: group.items.map(task => ({ taskId: task.id, version: task.version, title: task.title, startDate: task.startDate ?? "", dueDate: task.dueDate ?? "", status: task.status, source: task.source })) }));
}

export function dateFromPointer(clientX: number, left: number, width: number, period: string): string {
  const [year, month] = period.split("-").map(Number);
  const days = new Date(year, month, 0).getDate();
  const day = Math.min(days, Math.max(1, Math.floor((clientX - left) / width * days) + 1));
  return `${period}-${String(day).padStart(2, "0")}`;
}

export function planChanges(original: PlanGroup[], draft: PlanGroup[]) {
  let added = 0, adjusted = 0;
  draft.forEach((group, groupIndex) => group.items.forEach((item, index) => {
    if (!item.taskId) { added++; return; }
    const old = original[groupIndex]?.items.find(row => row.taskId === item.taskId);
    if (old && (old.title !== item.title || old.startDate !== item.startDate || old.dueDate !== item.dueDate || original[groupIndex].items.indexOf(old) !== index)) adjusted++;
  }));
  return { added, adjusted };
}

export function saveBody(period: string, original: PlanGroup[], draft: PlanGroup[]): TSaveMonthPlanRequest {
  return { period, groups: draft.flatMap((group, groupIndex) => {
    const old = original[groupIndex];
    const changed = group.items.some((item, index) => !item.taskId || old.items[index]?.taskId !== item.taskId ||
      old.items[index]?.title !== item.title || old.items[index]?.startDate !== item.startDate || old.items[index]?.dueDate !== item.dueDate);
    if (!changed) return [];
    return [{ missionId: group.missionId, items: group.items.map(item => {
      if (!item.taskId) return { clientId: item.clientId, title: item.title.trim(),
        ...(item.startDate ? { startDate: item.startDate } : {}), ...(item.dueDate ? { dueDate: item.dueDate } : {}) };
      const before = old.items.find(row => row.taskId === item.taskId);
      return { taskId: item.taskId,
        ...(before?.title !== item.title ? { title: item.title.trim() } : {}),
        ...(before?.startDate !== item.startDate ? { startDate: item.startDate || null } : {}),
        ...(before?.dueDate !== item.dueDate ? { dueDate: item.dueDate || null } : {}) };
    }) }];
  }) };
}
