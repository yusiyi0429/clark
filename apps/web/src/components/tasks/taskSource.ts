import type { components } from "@/lib/api/schema";

type Task = Pick<components["schemas"]["TaskView"], "source" | "origin">;

/** 没挂 Mission 的事项从哪来：会后分派、Agent 建，其余是本人建的独立事项。 */
export const taskSourceLabel = (task: Task) => task.source === "meeting" ? task.origin ? `会后分派 · ${task.origin.meetingTitle}` : "会后分派"
  : task.source === "agent" ? "Agent 建" : "独立事项";
