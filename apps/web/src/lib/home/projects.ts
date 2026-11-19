/**
 * 项目（新首页设计第 16 节）：一件一直做下去的事，没有「完成」，不做了就归档；每月的 Task 挂在项目上。
 *
 * 数据是 B 的首页 v2（GET /api/me/work-home 的 projects、month）和项目接口（GET /api/me/projects，契约 projects.ts）；
 * 这里把它们转成左栏、项目页、详情用的样子。转交（16.7）跟着项目回来（transfer）。绑文件夹是本机程序的事（按设备分别绑，云端不存），
 * 从这台电脑的本机程序读（GET /v1/projects），folders 是项目 id → 文件夹名。
 */
import type { THomeItem, TProject } from "@warmap/contracts";
import { transferLine, type Person, type Transfer } from "./transfer";
import type { HomeProject, SubSession, WorkHomeData } from "./types";
import type { Worker } from "@/lib/work/workers";

export { newSubHref, projectHref, projectInfoHref } from "./derive";

export type ProjectGoal = {
  taskId: string;
  missionId: string;
  /** Mission 名（「本月」里找得到才有）。 */
  missionTitle: string | null;
  /** 这个目标是哪个月的（YYYY-MM）。 */
  period: string;
  name: string;
  /** 验收截止「11/30」（契约 dueDate：天枢里存的，没存退回记下的原验收时间点；Mission 没节点又没存的为 null，和本月页一样不写）。 */
  due: string | null;
  /** 同一个截止日的 YYYY-MM-DD（改日期用）。 */
  dueDate: string | null;
  /** 是天枢里存的（本人或伙伴改过），不是退回记下的原验收时间点：能清掉。 */
  dueSet: boolean;
  criteria: string[];
  completedAt: string | null;
  /** Task 负责人不是本人时是那个人（项目交接过来，Task 跟着项目走），目标条上画他的头像；是本人为 null。 */
  responsible: Person | null;
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
  /** 项目对话里有本人还没看过的新回复或汇报（契约 HomeProject.unseen，26 条）：标题右边蓝点。 */
  unseen: boolean;
  /** 正在转交的那一份（preparing、sent），或本人交出去了的（accepted，项目在本人这边归档、只读）；没有为 null。 */
  transfer: Transfer | null;
};

/** 这台电脑上各项目绑的文件夹：项目 id → 文件夹名。 */
export type Folders = ReadonlyMap<string, string>;
export type FolderRef = { id: string; path: string; label: string };
/** 同上，带文件夹 id 和路径（开工用）：绑了多个的是第一个（工作目录）。 */
export type BoundFolders = ReadonlyMap<string, FolderRef>;
/** 各项目绑的整份文件夹列表（17.2 第 46 条）：有顺序，第一个是工作目录。 */
export type BoundFolderLists = ReadonlyMap<string, readonly FolderRef[]>;

/** 首页 v2 的一个项目（没归档的，已经按 16.2 排好）。 */
export function fromHome(project: HomeProject, data: Pick<WorkHomeData, "month" | "period">, folders: Folders): Project {
  const missionTitle = (missionId: string) => data.month.missions.find((mission) => mission.missionId === missionId)?.title ?? null;
  const goals = project.goals.map((goal): ProjectGoal => ({
    taskId: goal.taskId, missionId: goal.missionId, missionTitle: missionTitle(goal.missionId), period: goal.period, name: goal.name,
    due: goal.dueDate?.slice(5).replace("-", "/") ?? null, dueDate: goal.dueDate, dueSet: goal.dueDateSource === "set", criteria: goal.criteria, completedAt: goal.completedAt, responsible: goal.responsible,
  }));
  return {
    id: project.projectId, name: project.name, folder: folders.get(project.projectId) ?? null, archived: false,
    goals, current: goals.filter((goal) => goal.period === data.period),
    subSessions: project.subSessions, items: project.items, scope: project.pipeline.scope,
    waiting: project.summary.needsYou, lastActivity: project.lastActivityAt,
    budget: project.budget ? { percent: project.budget.percent, state: project.budget.state } : null,
    transfer: project.transfer, unseen: project.unseen,
  };
}

/** 归档了的项目（GET /api/me/projects 里 archivedAt 不为 null 的，含交出去了的）：首页数据里没有它的目标和会话，详情里的目标历史另读。 */
export function fromListed(project: TProject, folders: Folders): Project {
  return {
    id: project.projectId, name: project.name, folder: folders.get(project.projectId) ?? null, archived: true,
    goals: [], current: [], subSessions: [], items: [], scope: `project:${project.projectId}`,
    waiting: 0, lastActivity: project.lastActivityAt, budget: null, transfer: project.transfer, unseen: false,
  };
}

/** 「2 小时前」「3 天前」。 */
export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return minutes < 1 ? "刚刚" : `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`;
}

type BackgroundWorker = Pick<Worker, "kind" | "state" | "mark" | "taskId" | "projectId" | "cardId" | "topicId">;

/**
 * 项目在后台干活（左栏标题右边那颗闪的灰点）：项目下有子会话在跑、项目对话正在回复（replying），
 * 或者这个项目的会话、规划员、验收员在这台电脑上正做着（挂着的 Task 下的，或登记带了这个项目的，或是这个项目的卡和专题）。
 * 进行中带标记的只有「验收中」（云端验收员在验）算；等你批准、等你回复、暂停、受阻、验收没过都不算在干活。
 */
export function projectWorking(project: Project, workers: readonly BackgroundWorker[], replying: boolean): boolean {
  if (replying || project.subSessions.some((sub) => sub.state === "running")) return true;
  const taskIds = new Set(project.goals.map((goal) => goal.taskId));
  const subIds = new Set(project.subSessions.map((sub) => sub.id));
  return workers.some((worker) => worker.state === "doing" && (!worker.mark || worker.mark === "reviewing")
    && ((!!worker.taskId && taskIds.has(worker.taskId)) || worker.projectId === project.id || subIds.has(worker.cardId ?? worker.topicId ?? "")));
}

/**
 * 项目行的第二行（16.2；17.2 第 47 条起只在这两种时出，其余只有名字一行）：转交中「等 {名字} 接手」/ 交出去了「已交给 {名字}」（16.7）→「预算 80%」（warning）。
 * 本月目标、「本月没有目标」不在左栏写（项目详情里有）。
 */
export function projectLine(project: Project): { text: string; warning: boolean } | null {
  const handover = transferLine(project.transfer);
  if (handover) return { text: handover, warning: false };
  if (project.budget) return { text: `预算 ${project.budget.percent}%`, warning: true };
  return null;
}

/** 详情里「当前目标」那一块写哪件：本月截止最早的那件，本月没有就之前月份没了结的。 */
export const mainGoal = (project: Project): ProjectGoal | null => project.current[0] ?? project.goals[0] ?? null;
