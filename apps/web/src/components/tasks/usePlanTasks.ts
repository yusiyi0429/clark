"use client";

import { useEffect, useState } from "react";
import type { THomePlanTask } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";

/**
 * 执行事项能挂的 Task：首页计划里本人 Mission 下的 Task（只读一次）。
 * 返回按 Mission 取的函数：还没读到、读失败、或这个 Mission 不在首页计划里时给 null（不知道有没有），否则给它的 Task（可能为空）。
 */
export function usePlanTasks(): (missionId: string) => THomePlanTask[] | null {
  const [plan, setPlan] = useState<{ missionIds: string[]; tasks: THomePlanTask[] } | null>(null);
  useEffect(() => {
    let live = true;
    void browserApi.GET("/api/me/home-plan").then(({ data }) => {
      if (live && data) setPlan({ missionIds: data.missions.map((mission) => mission.missionId), tasks: data.tasks });
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  return (missionId) => plan?.missionIds.includes(missionId) ? plan.tasks.filter((task) => task.missionId === missionId) : null;
}
