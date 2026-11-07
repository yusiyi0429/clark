"use client";

/**
 * 项目列表和本人的改动（16.2–16.5）：没归档的从首页 v2 来（data.projects，已排好），归档了的读 GET /api/me/projects；
 * 新建、改名、归档、恢复、挂到调 B 的项目接口（契约 projects.ts），调完重读首页。绑文件夹、转交还没有接口，记在这个标签页的内存里。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { TProject } from "@warmap/contracts";
import { attachGoal, createProject, listProjects, updateProject } from "@/lib/board/cloud";
import { NO_EDITS, fromHome, fromListed, type Project, type ProjectEdits } from "@/lib/home/projects";
import type { Person, Transfer } from "@/lib/home/transfer";
import type { WorkHomeData } from "@/lib/home/types";

export function useProjects(data: Pick<WorkHomeData, "projects" | "month" | "period" | "archivedCount">, refresh: () => Promise<unknown>) {
  const [edits, setEdits] = useState<ProjectEdits>(NO_EDITS);
  const [listed, setListed] = useState<TProject[]>([]);
  // 归档了几个变了（本人归档、恢复，或别处改的）就重读一次列表；一个都没有时不读。
  useEffect(() => {
    if (!data.archivedCount) { setListed([]); return; }
    let alive = true;
    void listProjects().then((answer) => { if (alive) setListed(answer.projects.filter((project) => project.archivedAt)); }, () => undefined);
    return () => { alive = false; };
  }, [data.archivedCount]);
  const home = useMemo(() => data.projects.map((project) => fromHome(project, data, edits)), [data, edits]);
  const archived = useMemo(() => [...home.filter((project) => project.archived), ...listed.map((project) => fromListed(project, edits))], [home, listed, edits]);
  const projects = useMemo(() => home.filter((project) => !project.archived), [home]);
  const all = useMemo(() => [...projects, ...archived], [projects, archived]);

  /** 建一个项目，回它的 id；带 taskId 时顺手把这件 Task 挂上来（「挂到… → 新建」）。 */
  const create = useCallback(async (name: string, taskId?: string) => {
    const project = await createProject(name, taskId);
    await refresh();
    return project.projectId;
  }, [refresh]);
  const rename = useCallback(async (id: string, name: string) => { await updateProject(id, { name }); await refresh(); }, [refresh]);
  const archive = useCallback(async (id: string, value: boolean) => { await updateProject(id, { archived: value }); await refresh(); }, [refresh]);
  const attach = useCallback(async (taskId: string, projectId: string) => { await attachGoal(projectId, taskId); await refresh(); }, [refresh]);
  const setFolder = useCallback((id: string, folder: string | null) => setEdits((now) => ({ ...now, folders: { ...now.folders, [id]: folder } })), []);
  /** 转给某人（16.7）：开一次「准备交接」。 */
  const startTransfer = useCallback((project: Project, from: Person, to: Person) => setEdits((now) => ({ ...now, transfers: { ...now.transfers, [project.id]: {
    id: `transfer:${project.id}:${Date.now().toString(36)}`, projectId: project.id, projectName: project.name, from, to, status: "preparing",
    startedAt: new Date().toISOString(), decidedAt: null, includeHistory: false, running: null, check: null, note: null,
  } } })), []);
  const updateTransfer = useCallback((projectId: string, patch: Partial<Transfer>) => setEdits((now) => {
    const current = now.transfers[projectId];
    return current ? { ...now, transfers: { ...now.transfers, [projectId]: { ...current, ...patch } } } : now;
  }), []);
  const actions = useMemo(() => ({ create, rename, archive, attach, setFolder, startTransfer, updateTransfer }), [create, rename, archive, attach, setFolder, startTransfer, updateTransfer]);
  return { all, projects, archived, actions };
}

export type ProjectsApi = ReturnType<typeof useProjects>;
