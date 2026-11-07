"use client";

/**
 * 右栏的后台任务（契约 GET /api/me/background?scope=…）：云端的给手机和别的电脑看；配对的这台电脑上以本机程序为准，合并进来（同一个 id 用本机的）。
 * 云端接口没上时，云端那份由 worker 列表补（别的电脑上的、登记了还没开的规划员和验收员）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { calendarDate } from "@/lib/companyTime";
import { useHandheld } from "@/components/ui/useHandheld";
import { readBackground } from "@/lib/board/cloud";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { inScope, localBackground, mergeBackground, workerBackground } from "./derive";
import type { BackgroundItem, BackgroundScope } from "./types";
import type { WorkHomeApi } from "./useWorkHome";

const POLL_MS = 5000;

/** scope 为 resources（二级页、月份页）时右栏只有资源块，不列后台任务，也不用去取（云端这时 items 为空）。 */
export function useBackground(scope: BackgroundScope, api: WorkHomeApi): BackgroundItem[] {
  const local = useLocalRunner();
  const handheld = useHandheld();
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
  const { missions } = api.data;
  // 卡、专题挂在哪件 Task：树上找（含之前验收过的卡），找不到再看 worker 列表。
  const owner = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of missions.flatMap((mission) => mission.tasks)) for (const sub of task.subSessions) map.set(sub.id, task.taskId);
    return map;
  }, [missions]);
  const taskOfCard = useCallback((cardId: string) => owner.get(cardId) ?? workers.find((worker) => worker.cardId === cardId)?.taskId ?? null, [owner, workers]);
  const taskOfTopic = useCallback((topicId: string) => owner.get(topicId) ?? workers.find((worker) => worker.topicId === topicId)?.taskId ?? null, [owner, workers]);
  // 本机报的时间是这台电脑的钟，「今天」也按这台电脑算（公司时区）。
  const today = calendarDate(new Date().toISOString());
  const here = useMemo(() => (local.phase === "ready"
    ? localBackground({ sessions: local.sessions, deviceId: api.deviceId, canStop: !handheld, today, taskOfCard, taskOfTopic })
    : []), [local.phase, local.sessions, api.deviceId, handheld, today, taskOfCard, taskOfTopic]);
  return useMemo(() => {
    // 云端的只给看：停只能在跑它的那台电脑上经本机程序停，这台电脑上的由下面本机那份（同一个 id）给停止。
    if (scope === "resources") return [];
    const base = api.live ? (cloud?.scope === scope ? cloud.items : []).map((item) => ({ ...item, stoppable: false })) : workerBackground(workers);
    return inScope(mergeBackground(base, here), scope);
  }, [api.live, cloud, scope, workers, here]);
}
