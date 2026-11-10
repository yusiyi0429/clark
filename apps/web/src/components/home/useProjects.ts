"use client";

/**
 * 项目列表和本人的改动（16.2–16.7）：没归档的从首页 v2 来（data.projects，已排好），归档了的（含交出去了的）读 GET /api/me/projects；
 * 新建、改名、归档、恢复、挂到、转给…、撤回调 B 的接口（契约 projects.ts、projectTransfers.ts），调完重读首页。
 * 绑文件夹在这台电脑的本机程序上（D 的 GET/PUT /v1/projects）：没连上本机程序时都算没绑。交出去了的项目，这台电脑上的绑定解掉（只解绑，不动文件）。
 * 一个项目可以绑多个文件夹（17.2 第 46 条）：第一个是工作目录。老的本机程序只认一个（回的东西里没有 folders），照一个的上限来。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { TArchivedSubSession, TProject, TSubSessionKind } from "@warmap/contracts";
import { LOCAL_PROJECT_FOLDER_LIMIT } from "@/lib/local/routes";
import { attachGoal, createProject, deleteProject, deleteSubSession, listArchivedSubSessions, listProjects, setGoalDueDate, startTransfer, updateProject, updateSubSession, withdrawTransfer } from "@/lib/board/cloud";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { LocalRunnerError } from "@/lib/local/runner";
import { fromHome, fromListed, type BoundFolderLists, type BoundFolders, type Folders } from "@/lib/home/projects";
import { noteStartedTransfer, seenSequence } from "@/lib/home/transfer";
import type { WorkHomeData } from "@/lib/home/types";

export function useProjects(data: Pick<WorkHomeData, "projects" | "month" | "period" | "archivedCount">, refresh: () => Promise<unknown>) {
  const local = useLocalRunner();
  const ready = local.phase === "ready";
  const [listed, setListed] = useState<TProject[]>([]);
  /** 这台电脑上各项目绑的文件夹（项目 id → 有顺序的列表）；bound 是各自的第一个：开工、开规划员都在它里面做（17.2 第 32 条）。 */
  const [boundAll, setBoundAll] = useState<BoundFolderLists>(new Map());
  const bound: BoundFolders = useMemo(() => new Map([...boundAll].flatMap(([projectId, list]) => (list[0] ? [[projectId, list[0]] as const] : []))), [boundAll]);
  /** 本机程序认不认多个文件夹：读到过项目才知道，不知道时当认（PUT 回 400 再退回一个）。 */
  const [multi, setMulti] = useState<boolean | null>(null);
  const folderLimit = multi === false ? 1 : LOCAL_PROJECT_FOLDER_LIMIT;
  const folders: Folders = useMemo(() => new Map([...bound].map(([projectId, folder]) => [projectId, folder.label])), [bound]);
  // 归档了几个变了（本人归档、恢复、交出去了，或别处改的）就重读一次列表；一个都没有时不读。
  useEffect(() => {
    if (!data.archivedCount) { setListed([]); return; }
    let alive = true;
    void listProjects().then((answer) => { if (alive) setListed(answer.projects.filter((project) => project.archivedAt)); }, () => undefined);
    return () => { alive = false; };
  }, [data.archivedCount]);
  const { runner } = local;
  const loadFolders = useCallback(async () => {
    const listed = await runner.listProjects().catch(() => []);
    setBoundAll(new Map(listed.map((entry) => [entry.projectId, entry.folders ?? (entry.folder ? [entry.folder] : [])])));
    if (listed.length) setMulti(listed.some((entry) => entry.folders !== undefined));
  }, [runner]);
  useEffect(() => { if (ready) void loadFolders(); else setBoundAll(new Map()); }, [ready, loadFolders]);
  // 交出去了（accepted）的项目还绑着这台电脑上的文件夹：解绑（16.7，原负责人那边只读）。
  const handedOff = listed.filter((project) => project.transfer?.status === "accepted" && folders.has(project.projectId)).map((project) => project.projectId).join(",");
  useEffect(() => {
    if (!ready || !handedOff) return;
    void Promise.all(handedOff.split(",").map((projectId) => runner.putProjectFolder(projectId, { folderId: null }).catch(() => undefined))).then(loadFolders);
  }, [ready, handedOff, runner, loadFolders]);

  // 归档了的子会话（35 条）：左栏「已归档」里列出来、能恢复；进页面读一次，本人归档、恢复、删了再读。
  const [archivedSubs, setArchivedSubs] = useState<TArchivedSubSession[]>([]);
  const loadArchivedSubs = useCallback(() => listArchivedSubSessions().then((answer) => setArchivedSubs(answer.items), () => undefined), []);
  useEffect(() => { void loadArchivedSubs(); }, [loadArchivedSubs]);

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
  /** 改一件目标的验收截止日，null 清掉（退回 Mission 的节点）。 */
  const setDue = useCallback(async (projectId: string, taskId: string, dueDate: string | null) => { await setGoalDueDate(projectId, taskId, dueDate); await refresh(); }, [refresh]);
  /** 绑到这台电脑上一个允许的文件夹（folderId），null 解绑。 */
  const setFolder = useCallback(async (id: string, folderId: string | null, name?: string) => {
    await runner.putProjectFolder(id, { folderId, ...(name ? { name } : {}) });
    await loadFolders();
  }, [runner, loadFolders]);
  /** 定这个项目绑哪几个文件夹（整份有顺序的列表，空的是全部解绑）。老的本机程序不认 folderIds（回 400）：退回只绑第一个。 */
  const setFolders = useCallback(async (id: string, folderIds: string[], name?: string) => {
    const extra = name ? { name } : {};
    const one = () => runner.putProjectFolder(id, { folderId: folderIds[0] ?? null, ...extra });
    if (multi === false) await one();
    else await runner.putProjectFolder(id, { folderIds, ...extra }).catch((error) => { if (error instanceof LocalRunnerError && error.status === 400) return one(); throw error; });
    await loadFolders();
  }, [runner, multi, loadFolders]);
  /** 删掉项目（35 条，撤不回）：云端删成了，这台电脑上的绑定解掉（文件夹和文件不动）。 */
  const remove = useCallback(async (id: string) => {
    await deleteProject(id);
    if (ready) await runner.putProjectFolder(id, { folderId: null }).catch(() => undefined);
    await Promise.all([refresh(), loadFolders(), loadArchivedSubs()]);
  }, [ready, runner, refresh, loadFolders, loadArchivedSubs]);
  /** 子会话改名、归档 / 恢复、删（进回收站）。 */
  const renameSub = useCallback(async (kind: TSubSessionKind, id: string, title: string) => { await updateSubSession(kind, id, { title }); await refresh(); }, [refresh]);
  const archiveSub = useCallback(async (kind: TSubSessionKind, id: string, archived: boolean) => {
    await updateSubSession(kind, id, { archived });
    await Promise.all([refresh(), loadArchivedSubs()]);
  }, [refresh, loadArchivedSubs]);
  const removeSub = useCallback(async (kind: TSubSessionKind, id: string) => { await deleteSubSession(kind, id); await Promise.all([refresh(), loadArchivedSubs()]); }, [refresh, loadArchivedSubs]);
  /** 本机弹框选别的文件夹、一步绑到项目上（32 条）。 */
  const pickFolder = useCallback(async (id: string, name: string) => {
    if (await local.pickFolder({ projectId: id, projectName: name })) await loadFolders();
  }, [local, loadFolders]);
  /** 在桌面新建文件夹、一步绑到项目上；没成照本机的错抛出，菜单里就地写。 */
  const createFolder = useCallback(async (id: string, name: string, folderName: string) => {
    await local.createFolder({ name: folderName, projectId: id, projectName: name });
    await loadFolders();
  }, [local, loadFolders]);
  /** 转给某人（16.7）：开一份「准备交接」。 */
  const transfer = useCallback(async (projectId: string, toPersonId: string) => {
    const started = await startTransfer(projectId, toPersonId, seenSequence(projectId));
    noteStartedTransfer(started.id);
    await refresh();
  }, [refresh]);
  const withdraw = useCallback(async (transferId: string) => { await withdrawTransfer(transferId); await refresh(); }, [refresh]);
  const actions = useMemo(() => ({ create, rename, archive, remove, attach, setDue, setFolder, setFolders, pickFolder, createFolder, transfer, withdraw, renameSub, archiveSub, removeSub, reloadFolders: loadFolders }),
    [create, rename, archive, remove, attach, setDue, setFolder, setFolders, pickFolder, createFolder, transfer, withdraw, renameSub, archiveSub, removeSub, loadFolders]);
  return { all, projects, archived, archivedSubs, bound, boundAll, folderLimit, actions };
}

export type ProjectsApi = ReturnType<typeof useProjects>;
