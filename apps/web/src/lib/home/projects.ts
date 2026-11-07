/**
 * 项目（新首页设计第 16 节）：一件一直做下去的事，没有「完成」，不做了就归档；每月的 Task 挂在项目上。
 *
 * 数据是 B 的首页 v2（GET /api/me/work-home 的 projects、month）和项目接口（GET /api/me/projects，契约 projects.ts）；
 * 这里把它们转成左栏、项目页、详情用的样子。绑文件夹是本机程序的事（按设备分别绑，云端不存），转交的接口还没出（16.7），
 * 这两样先记在这个标签页的内存里（ProjectEdits），刷新就没了。网页不存业务数据，所以不写进浏览器存储。
 */
import type { THomeItem, TProject } from "@warmap/contracts";
import { transferLine, type Transfer } from "./transfer";
import type { HomeProject, SubSession, WorkHomeData } from "./types";

export { projectHref, projectInfoHref } from "./derive";

export type ProjectGoal = {
  taskId: string;
  missionId: string;
  /** Mission 名（「本月」里找得到才有）。 */
  missionTitle: string | null;
  /** 这个目标是哪个月的（YYYY-MM）。 */
  period: string;
  name: string;
  /** 验收截止「11/30」（契约 dueDate，Task 所在月份的最后一天）。 */
  due: string;
  criteria: string[];
  completedAt: string | null;
};

export type Project = {
  id: string;
  name: string;
  /** 绑定的文件夹（这台电脑上的名字）；没绑为 null。 */
  folder: string | null;
  archived: boolean;
  /** 挂着、没了结的目标（本月的，加之前月份没了结的），截止早的在前。 */
  goals: ProjectGoal[];
  /** 这个月挂着的。 */
  current: ProjectGoal[];
  subSessions: SubSession[];
  /** 本人在这个项目里自己做的执行事项。 */
  items: THomeItem[];
  /** 项目对话的 scope（project:<id>）。 */
  scope: string;
  /** 有几件等你。 */
  waiting: number;
  /** 最近一次动静；没有为 null。 */
  lastActivity: string | null;
  /** 预算用到 80% 以上的那件（契约 HomeProject.budget）；没有为 null。 */
  budget: { percent: number; state: "warning" | "exhausted" } | null;
  /** 正在转交或已经交出去的那一次（16.7）；撤回了、没接的算没有。 */
  transfer: Transfer | null;
};

/** 本人在这个标签页里做的、云端还不记的：绑文件夹（本机程序的接口到了换掉）、转交（B 的接口到了换掉）。 */
export type ProjectEdits = { folders: Record<string, string | null>; transfers: Record<string, Transfer> };
export const NO_EDITS: ProjectEdits = { folders: {}, transfers: {} };

/** 转交接走了的，原负责人这边进「已归档」（只读，16.7）。 */
function activeTransfer(id: string, edits: ProjectEdits): Transfer | null {
  const transfer = edits.transfers[id] ?? null;
  return transfer && (transfer.status === "preparing" || transfer.status === "sent" || transfer.status === "accepted") ? transfer : null;
}

/** 首页 v2 的一个项目（没归档的，已经按 16.2 排好）。 */
export function fromHome(project: HomeProject, data: Pick<WorkHomeData, "month" | "period">, edits: ProjectEdits): Project {
  const missionTitle = (missionId: string) => data.month.missions.find((mission) => mission.missionId === missionId)?.title ?? null;
  const goals = project.goals.map((goal): ProjectGoal => ({
    taskId: goal.taskId, missionId: goal.missionId, missionTitle: missionTitle(goal.missionId), period: goal.period, name: goal.name,
    due: goal.dueDate.slice(5).replace("-", "/"), criteria: goal.criteria, completedAt: goal.completedAt,
  }));
  const transfer = activeTransfer(project.projectId, edits);
  return {
    id: project.projectId, name: project.name, folder: edits.folders[project.projectId] ?? null, archived: transfer?.status === "accepted",
    goals, current: goals.filter((goal) => goal.period === data.period),
    subSessions: project.subSessions, items: project.items, scope: project.pipeline.scope,
    waiting: project.summary.needsYou, lastActivity: project.lastActivityAt,
    budget: project.budget ? { percent: project.budget.percent, state: project.budget.state } : null,
    transfer,
  };
}

/** 归档了的项目（GET /api/me/projects 里 archivedAt 不为 null 的）：首页数据里没有它的目标和会话，详情里的目标历史另读。 */
export function fromListed(project: TProject, edits: ProjectEdits): Project {
  return {
    id: project.projectId, name: project.name, folder: edits.folders[project.projectId] ?? null, archived: true,
    goals: [], current: [], subSessions: [], items: [], scope: `project:${project.projectId}`,
    waiting: 0, lastActivity: project.lastActivityAt, budget: null, transfer: activeTransfer(project.projectId, edits),
  };
}

/** 「2 小时前」「3 天前」。 */
export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return minutes < 1 ? "刚刚" : `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`;
}

/**
 * 项目行的第二行（16.2），按顺序取第一个有的：转交中「等 {名字} 接手」/ 交出去了「已交给 {名字}」（16.7）→「预算 80%」（warning）→「{月} 月 · {Task 名} · {截止} 验收」→「本月没有目标 · {最近活动}」。
 */
export function projectLine(project: Project, now = Date.now()): { text: string; warning: boolean } {
  const handover = transferLine(project.transfer);
  if (handover) return { text: handover, warning: false };
  if (project.budget) return { text: `预算 ${project.budget.percent}%`, warning: true };
  const goal = project.goals[0];
  if (goal) return { text: [`${Number(goal.period.slice(5))} 月`, goal.name, `${goal.due} 验收`].join(" · "), warning: false };
  return { text: project.lastActivity ? `本月没有目标 · ${ago(project.lastActivity, now)}` : "本月没有目标", warning: false };
}

/** 详情里「当前目标」那一块写哪件：本月截止最早的那件，本月没有就之前月份没了结的。 */
export const mainGoal = (project: Project): ProjectGoal | null => project.current[0] ?? project.goals[0] ?? null;
