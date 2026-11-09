/**
 * 开工、开规划员在哪个文件夹（17.2 第 32 条）：用这张卡、这件 Task 所属项目在这台电脑上绑的文件夹，不用「上次用过的」。
 * 项目没绑：卡不开（ask，项目对话里出选项框问），规划员不给目录（本机给它专用目录，规划员自己会先问清）。
 * 不属于任何项目的（「其他」里的卡）才退回上次用过的文件夹（readLast），再没有用第一个。
 */
import type { BoundFolders, Project } from "./projects";

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
