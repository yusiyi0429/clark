/**
 * 开工、开规划员在哪个文件夹（17.2 第 32 条）：用这张卡、这件 Task 所属项目在这台电脑上绑的文件夹，不用「上次用过的」。
 * 项目没绑：卡不开（ask，项目对话里出选项框问），规划员不给目录（本机给它专用目录，规划员自己会先问清）。
 * 不属于任何项目的（「其他」里的卡）才退回上次用过的文件夹（readLast），再没有用第一个。
 */
import type { BoundFolders, Project } from "./projects";
import type { SubSession } from "./types";

/** 一张卡（或一次拆卡）所属的项目：先看它自己带的项目，再看它的 Task 挂在哪个项目上，再看它是哪个项目里的子会话。 */
export function projectIdOf(target: { projectId?: string | null; taskId?: string | null; cardId?: string | null }, projects: readonly Pick<Project, "id" | "goals" | "subSessions">[]): string | null {
  if (target.projectId) return target.projectId;
  const byTask = target.taskId ? projects.find((project) => project.goals.some((goal) => goal.taskId === target.taskId)) : undefined;
  if (byTask) return byTask.id;
  return (target.cardId ? projects.find((project) => project.subSessions.some((sub) => sub.id === target.cardId)) : undefined)?.id ?? null;
}

/** 这次开工的目录：cwd 为 null 且 ask 时是项目没绑（要问）；不属于项目时用 fallback（上次用过的，没有为 null）。 */
export function startFolder(projectId: string | null, bound: BoundFolders, fallback: string | null): { cwd: string | null; ask: boolean } {
  if (!projectId) return { cwd: fallback, ask: false };
  const folder = bound.get(projectId);
  return folder ? { cwd: folder.path, ask: false } : { cwd: null, ask: true };
}

/** 认领到一个专题以后怎么办（第 68 条）：start 开工（带这些参数）；ask 先问这个项目在哪个文件夹开工；skip 不开，failed 时记成没开成。 */
export type TopicClaim =
  | { kind: "start"; topic: { id: string; title: string; free?: true; cwd?: string | null } }
  | { kind: "ask"; projectId: string }
  | { kind: "skip"; failed: boolean };

/**
 * 认领到的专题在这台电脑上怎么开（第 68 条）：
 * - 这台电脑上已经在跑（busy）：不再开，也不算失败（选完文件夹再认领时只开一个）；
 * - 普通专题：照开（本机给它专用目录）；
 * - 自由子会话（free）：本机程序太旧（protocol < 4）不开、记成没开成；项目在这台电脑上没绑文件夹，同卡一样先问（ask）；绑了在那个文件夹里开。
 */
export function claimTopic(topicId: string, { subs, projects, bound, freeSessions, busy }: {
  subs: readonly Pick<SubSession, "id" | "kind" | "title" | "free">[];
  projects: readonly Pick<Project, "id" | "subSessions">[];
  bound: BoundFolders;
  /** 这台电脑的本机程序收不收自由子会话（LocalRunner.freeSessions）。 */
  freeSessions: boolean;
  /** 这台电脑上已经有会话的卡、专题。 */
  busy: ReadonlySet<string>;
}): TopicClaim {
  if (busy.has(topicId)) return { kind: "skip", failed: false };
  const sub = subs.find((entry) => entry.id === topicId && entry.kind === "topic");
  if (!sub?.free) return { kind: "start", topic: { id: topicId, title: sub?.title ?? "" } };
  if (!freeSessions) return { kind: "skip", failed: true };
  const owner = projects.find((project) => project.subSessions.some((entry) => entry.id === topicId)) ?? null;
  const where = startFolder(owner?.id ?? null, bound, null);
  if (where.ask && owner) return { kind: "ask", projectId: owner.id };
  return { kind: "start", topic: { id: topicId, title: sub.title, free: true, cwd: where.cwd } };
}
