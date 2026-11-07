/**
 * 项目（新首页设计第 16 节）：一件一直做下去的事，没有「完成」，不做了就归档；每月的 Task 挂在项目上。
 *
 * B 的首页数据 v2（projects、month）和项目、挂接的接口还没出，这里先照 16.5 上线迁移的规矩从现有数据推出来：
 * 树上每个 Mission 一个同名项目，它下面的 Task 都挂上去（id 是 mission:<missionId>）。
 * 本人在这个标签页里做的新建、改名、归档、挂到、绑文件夹先记在内存里（ProjectEdits），刷新就没了——接口到了换成调接口，界面不动。
 * 网页不存业务数据，所以不写进浏览器存储。
 */
import type { HomeTask, SubSession, WorkHomeData } from "./types";
import { transferLine, type Transfer } from "./transfer";

export type ProjectGoal = {
  taskId: string;
  missionId: string;
  missionTitle: string;
  /** 这个目标是哪个月的（YYYY-MM）。 */
  period: string;
  name: string;
  /** 截止「11/20」（这个 Mission 下一个验收时间点）；没有为 null。 */
  due: string | null;
};

export type Project = {
  id: string;
  name: string;
  /** 绑定的文件夹（这台电脑上的名字）；没绑为 null。 */
  folder: string | null;
  archived: boolean;
  /** 挂过的目标，新月份在前。 */
  goals: ProjectGoal[];
  /** 这个月挂着的，按截止日。 */
  current: ProjectGoal[];
  /** 挂着的 Task 在树上的样子（子会话、事项都在这里）。 */
  tasks: HomeTask[];
  subSessions: SubSession[];
  /** 有几件等你。 */
  waiting: number;
  /** 最近一次动静（子会话、事项的更新时间里最晚的）。 */
  lastActivity: string | null;
  /** 预算用了多少（0–100+，到 80 写「预算 80%」）；还没有数据为 null。 */
  budget: number | null;
  /** 正在转交或已经交出去的那一次（16.7）；撤回了、没接的算没有。 */
  transfer: Transfer | null;
};

/** 本人在这个标签页里做的改动（接口到了以后由云端记）。attach 的值为 null 是「没挂」。 */
export type ProjectEdits = {
  created: { id: string; name: string; createdAt: string }[];
  names: Record<string, string>;
  archived: Record<string, boolean>;
  attach: Record<string, string | null>;
  folders: Record<string, string | null>;
  transfers: Record<string, Transfer>;
};
export const NO_EDITS: ProjectEdits = { created: [], names: {}, archived: {}, attach: {}, folders: {}, transfers: {} };

export const missionProject = (missionId: string) => `mission:${missionId}`;
export const projectHref = (id: string) => `/me/work/projects/${encodeURIComponent(id)}`;
export const projectInfoHref = (id: string) => `${projectHref(id)}/info`;

const latest = (dates: (string | null | undefined)[]) => dates.filter((date): date is string => !!date).sort().at(-1) ?? null;

/**
 * 推出项目列表：树上的每个 Mission 一个同名项目（16.5），加上本人新建的；Task 按 edits.attach 改挂或摘掉。
 * dueOf 给一件 Task 的截止日「11/20」（Mission 的下一个验收时间点）。
 */
export function deriveProjects(data: Pick<WorkHomeData, "missions" | "waiting" | "period">, edits: ProjectEdits, dueOf: (missionId: string) => string | null): { projects: Project[]; unattached: ProjectGoal[] } {
  const base = new Map<string, { name: string; createdAt: string | null }>();
  for (const mission of data.missions) if (mission.tasks.length) base.set(missionProject(mission.missionId), { name: mission.title, createdAt: null });
  for (const entry of edits.created) base.set(entry.id, { name: entry.name, createdAt: entry.createdAt });
  const attached = new Map<string, { goal: ProjectGoal; task: HomeTask }[]>([...base.keys()].map((id) => [id, []]));
  const unattached: ProjectGoal[] = [];
  for (const mission of data.missions) {
    for (const task of mission.tasks) {
      const goal: ProjectGoal = { taskId: task.taskId, missionId: mission.missionId, missionTitle: mission.title, period: mission.period, name: task.name, due: dueOf(mission.missionId) };
      const target = task.taskId in edits.attach ? edits.attach[task.taskId] : missionProject(mission.missionId);
      const list = target ? attached.get(target) : undefined;
      if (list) list.push({ goal, task }); else unattached.push(goal);
    }
  }
  const projects = [...base.entries()].map(([id, { name, createdAt }]): Project => {
    const entries = attached.get(id) ?? [];
    const goals = entries.map((entry) => entry.goal).sort((a, b) => b.period.localeCompare(a.period));
    const tasks = entries.map((entry) => entry.task);
    const subSessions = tasks.flatMap((task) => task.subSessions);
    const taskIds = new Set(tasks.map((task) => task.taskId));
    const transfer = edits.transfers[id] ?? null;
    const active = transfer && (transfer.status === "preparing" || transfer.status === "sent" || transfer.status === "accepted") ? transfer : null;
    return {
      id,
      name: edits.names[id] ?? name,
      folder: edits.folders[id] ?? null,
      // 接走了的进「已归档」（原负责人这边只读，16.7）。
      archived: !!edits.archived[id] || active?.status === "accepted",
      goals,
      current: goals.filter((goal) => goal.period === data.period).sort((a, b) => (a.due ?? "99/99").localeCompare(b.due ?? "99/99")),
      tasks,
      subSessions,
      waiting: data.waiting.filter((item) => item.taskId && taskIds.has(item.taskId)).length,
      lastActivity: latest([createdAt, ...subSessions.map((sub) => sub.updatedAt), ...tasks.flatMap((task) => task.items.map((item) => item.updatedAt))]),
      budget: null,
      transfer: active,
    };
  });
  return { projects, unattached };
}

/** 排序（16.2）：有等你的在前；然后是这个月有目标的，按截止日；最后按最近活动。 */
export function sortProjects(projects: Project[]): Project[] {
  const due = (project: Project) => project.current[0]?.due ?? "99/99";
  return [...projects].sort((a, b) => {
    if (!!a.waiting !== !!b.waiting) return a.waiting ? -1 : 1;
    if (!!a.current.length !== !!b.current.length) return a.current.length ? -1 : 1;
    if (a.current.length) return due(a).localeCompare(due(b)) || a.name.localeCompare(b.name);
    return (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "");
  });
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
  if (project.budget !== null && project.budget >= 80) return { text: `预算 ${project.budget}%`, warning: true };
  const goal = project.current[0];
  if (goal) return { text: [`${Number(goal.period.slice(5))} 月`, goal.name, goal.due ? `${goal.due} 验收` : null].filter(Boolean).join(" · "), warning: false };
  return { text: project.lastActivity ? `本月没有目标 · ${ago(project.lastActivity, now)}` : "本月没有目标", warning: false };
}

/** 项目对话现在接哪件 Task 的管线（B 的 project:<id> 对话到了以后换掉）：本月截止最早的那件，本月没有就最近一个月的。 */
export const conversationTask = (project: Project): ProjectGoal | null => project.current[0] ?? project.goals[0] ?? null;
