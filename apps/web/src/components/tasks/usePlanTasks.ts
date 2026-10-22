"use client";

import { useEffect, useState } from "react";
import type { THomePlanTask } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";

/** 执行事项能挂的 Task：首页计划里本人 Mission 下的 Task（只读一次）；读不到就当没有，不挡新建和编辑。 */
export function usePlanTasks(): THomePlanTask[] {
  const [tasks, setTasks] = useState<THomePlanTask[]>([]);
  useEffect(() => {
    let live = true;
    void browserApi.GET("/api/me/home-plan").then(({ data }) => { if (live && data) setTasks(data.tasks); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  return tasks;
}
