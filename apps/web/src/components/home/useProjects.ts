"use client";

/**
 * 项目列表和本人的改动（16.2–16.7）：没归档的从首页 v2 来（data.projects，已排好），归档了的（含交出去了的）读 GET /api/me/projects；
 * 新建、改名、归档、恢复、挂到、转给…、撤回调 B 的接口（契约 projects.ts、projectTransfers.ts），调完重读首页。
 * 绑文件夹在这台电脑的本机程序上（D 的 GET/PUT /v1/projects）：没连上本机程序时都算没绑。交出去了的项目，这台电脑上的绑定解掉（只解绑，不动文件）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { TProject } from "@warmap/contracts";
import { attachGoal, createProject, listProjects, startTransfer, updateProject, withdrawTransfer } from "@/lib/board/cloud";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { fromHome, fromListed, type Folders } from "@/lib/home/projects";
import type { WorkHomeData } from "@/lib/home/types";

export function useProjects(data: Pick<WorkHomeData, "projects" | "month" | "period" | "archivedCount">, refresh: () => Promise<unknown>) {
  const local = useLocalRunner();
  const ready = local.phase === "ready";
  const [listed, setListed] = useState<TProject[]>([]);
  const [folders, setFolders] = useState<Folders>(new Map());
  // 归档了几个变了（本人归档、恢复、交出去了，或别处改的）就重读一次列表；一个都没有时不读。
  useEffect(() => {
    if (!data.archivedCount) { setListed([]); return; }
    let alive = true;
    void listProjects().then((answer) => { if (alive) setListed(answer.projects.filter((project) => project.archivedAt)); }, () => undefined);
    return () => { alive = false; };
  }, [data.archivedCount]);
  const { runner } = local;
  const loadFolders = useCallback(async () => {
    const bound = await runner.listProjects().catch(() => []);
    setFolders(new Map(bound.flatMap((entry) => (entry.folder ? [[entry.projectId, entry.folder.label] as const] : []))));
  }, [runner]);
  useEffect(() => { if (ready) void loadFolders(); else setFolders(new Map()); }, [ready, loadFolders]);
  // 交出去了（accepted）的项目还绑着这台电脑上的文件夹：解绑（16.7，原负责人那边只读）。
  const handedOff = listed.filter((project) => project.transfer?.status === "accepted" && folders.has(project.projectId)).map((project) => project.projectId).join(",");
  useEffect(() => {
    if (!ready || !handedOff) return;
    void Promise.all(handedOff.split(",").map((projectId) => runner.putProjectFolder(projectId, { folderId: null }).catch(() => undefined))).then(loadFolders);
  }, [ready, handedOff, runner, loadFolders]);

  const projects = useMemo(() => data.projects.map((project) => fromHome(project, data, folders)), [data, folders]);
  const archived = useMemo(() => listed.map((project) => fromListed(project, folders)), [listed, folders]);
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
  /** 绑到这台电脑上一个允许的文件夹（folderId），null 解绑。 */
  const setFolder = useCallback(async (id: string, folderId: string | null, name?: string) => {
    await runner.putProjectFolder(id, { folderId, ...(name ? { name } : {}) });
    await loadFolders();
  }, [runner, loadFolders]);
  /** 转给某人（16.7）：开一份「准备交接」。 */
  const transfer = useCallback(async (projectId: string, toPersonId: string) => { await startTransfer(projectId, toPersonId); await refresh(); }, [refresh]);
  const withdraw = useCallback(async (transferId: string) => { await withdrawTransfer(transferId); await refresh(); }, [refresh]);
  const actions = useMemo(() => ({ create, rename, archive, attach, setFolder, transfer, withdraw, reloadFolders: loadFolders }),
    [create, rename, archive, attach, setFolder, transfer, withdraw, loadFolders]);
  return { all, projects, archived, actions };
}

export type ProjectsApi = ReturnType<typeof useProjects>;
