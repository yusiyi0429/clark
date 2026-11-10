"use client";

/**
 * 右栏的后台任务（契约 GET /api/me/background?scope=…）：云端的给手机和别的电脑看；配对的这台电脑上以本机程序为准，合并进来（同一个 id 用本机的）。
 * 云端接口没上时，云端那份由 worker 列表补（别的电脑上的、登记了还没开的规划员和验收员）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { calendarDate } from "@/lib/companyTime";
import { usePhone } from "@/components/home/usePhone";
import { readBackground } from "@/lib/board/cloud";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { inScope, localBackground, mergeBackground, workerBackground } from "./derive";
import type { BackgroundItem, BackgroundScope } from "./types";
import type { WorkHomeApi } from "./useWorkHome";

const POLL_MS = 5000;

/** scope 为 resources（二级页、月份页）时右栏只有资源块，不列后台任务，也不用去取（云端这时 items 为空）。 */
export function useBackground(scope: BackgroundScope, api: WorkHomeApi): BackgroundItem[] {
  const local = useLocalRunner();
  const handheld = usePhone();
  const [cloud, setCloud] = useState<{ scope: string; items: BackgroundItem[] } | null>(null);
  useEffect(() => {
    if (!api.live || scope === "resources") return;
    let alive = true;
    const load = () => readBackground(scope).then((data) => { if (alive && data) setCloud({ scope, items: data.items }); }, () => undefined);
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [api.live, scope]);

  const { workers } = api.work;
  const { projects } = api.data;
  // 卡、专题挂在哪件 Task：worker 列表里找（首页 v2 的子会话在项目上，不带 Task）。
  const taskOfCard = useCallback((cardId: string) => workers.find((worker) => worker.cardId === cardId)?.taskId ?? null, [workers]);
  const taskOfTopic = useCallback((topicId: string) => workers.find((worker) => worker.topicId === topicId)?.taskId ?? null, [workers]);
  // project:<id>：本机报的按挂着的 Task、项目里的子会话、拆这个项目的规划员会话（只带 projectId，16.3）认（云端那份已经按项目筛好）。
  const members = useMemo(() => {
    const project = scope.startsWith("project:") ? projects.find((entry) => `project:${entry.projectId}` === scope) : undefined;
    return project ? {
      taskIds: new Set(project.goals.map((goal) => goal.taskId)), subIds: new Set(project.subSessions.map((sub) => sub.id)),
      sessionIds: new Set(local.sessions.filter((session) => session.subject.kind === "plan" && !session.subject.taskId && session.subject.projectId === project.projectId).map((session) => session.id)),
    } : undefined;
  }, [projects, scope, local.sessions]);
  // 本机报的时间是这台电脑的钟，「今天」也按这台电脑算（公司时区）。
  const today = calendarDate(new Date().toISOString());
  const here = useMemo(() => (local.phase === "ready"
    ? localBackground({ sessions: local.sessions, deviceId: api.deviceId, canStop: !handheld, today, taskOfCard, taskOfTopic })
    : []), [local.phase, local.sessions, api.deviceId, handheld, today, taskOfCard, taskOfTopic]);
  return useMemo(() => {
    // 云端的只给看：停只能在跑它的那台电脑上经本机程序停，这台电脑上的由下面本机那份（同一个 id）给停止。
    if (scope === "resources") return [];
    const base = api.live ? (cloud?.scope === scope ? cloud.items : []).map((item) => ({ ...item, stoppable: false })) : workerBackground(workers);
    return inScope(mergeBackground(base, here), scope, members);
  }, [api.live, cloud, scope, workers, here, members]);
}
