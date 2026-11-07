"use client";

/**
 * 项目列表和本人的改动（16.2–16.5）。B 的首页数据 v2 和项目接口到了以后，这里换成读接口、调接口；用的地方不动。
 * 现在：项目从树上推（lib/home/projects 的 deriveProjects），新建、改名、归档、挂到、绑文件夹记在这个标签页的内存里。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { NO_EDITS, deriveProjects, sortProjects, type ProjectEdits } from "@/lib/home/projects";
import type { WorkHomeData } from "@/lib/home/types";

export function useProjects(data: Pick<WorkHomeData, "missions" | "waiting" | "period">, dueOf: (missionId: string) => string | null) {
  const [edits, setEdits] = useState<ProjectEdits>(NO_EDITS);
  const counter = useRef(0);
  const { projects, unattached } = useMemo(() => deriveProjects(data, edits, dueOf), [data, edits, dueOf]);
  const live = useMemo(() => sortProjects(projects.filter((project) => !project.archived)), [projects]);
  const archived = useMemo(() => projects.filter((project) => project.archived), [projects]);
  const create = useCallback((name: string) => {
    counter.current += 1;
    const id = `local:${Date.now().toString(36)}${counter.current}`;
    setEdits((now) => ({ ...now, created: [...now.created, { id, name, createdAt: new Date().toISOString() }] }));
    return id;
  }, []);
  const rename = useCallback((id: string, name: string) => setEdits((now) => ({ ...now, names: { ...now.names, [id]: name } })), []);
  const archive = useCallback((id: string, value: boolean) => setEdits((now) => ({ ...now, archived: { ...now.archived, [id]: value } })), []);
  const attach = useCallback((taskId: string, projectId: string | null) => setEdits((now) => ({ ...now, attach: { ...now.attach, [taskId]: projectId } })), []);
  const setFolder = useCallback((id: string, folder: string | null) => setEdits((now) => ({ ...now, folders: { ...now.folders, [id]: folder } })), []);
  const actions = useMemo(() => ({ create, rename, archive, attach, setFolder }), [create, rename, archive, attach, setFolder]);
  return { all: projects, projects: live, archived, unattached, actions };
}

export type ProjectsApi = ReturnType<typeof useProjects>;
