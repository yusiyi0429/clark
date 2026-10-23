"use client";

/**
 * 成员首页的 Mission 计划（GET /api/me/home-plan）。和 useMemberHome 一样：页面在前台时每 20 秒重取；
 * 计划点存好（HOME_PLAN_CHANGED）、执行事项或任务卡变了，等手上这次读完再取一次，免得旧结果盖掉刚存的。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { THomePlanResponse } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";

/** 首页计划点存好之后发出（usePlanMarks）。 */
export const HOME_PLAN_CHANGED = "home-plan-changed";

const REFRESH_MS = 20_000;
const REFRESH_ERROR = "计划暂时没读到，稍后自动重试。";
const CHANGES = [HOME_PLAN_CHANGED, "member-tasks-changed", "mission-round-changed"];

export function useHomePlan() {
  const [plan, setPlan] = useState<THomePlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadInFlight = useRef<Promise<void> | null>(null);

  const load = useCallback(() => {
    if (loadInFlight.current) return loadInFlight.current;
    loadInFlight.current = (async () => {
      try {
        const { data, response } = await browserApi.GET("/api/me/home-plan");
        if (response.status === 401) {
          window.location.assign("/access?next=%2Fme");
          return;
        }
        if (data) setPlan(data);
        setError(data ? null : REFRESH_ERROR);
      } catch {
        // 断网时保留上次的计划。
        setError(REFRESH_ERROR);
      } finally {
        loadInFlight.current = null;
      }
    })();
    return loadInFlight.current;
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    const resume = () => { if (document.visibilityState === "visible") void load(); };
    const changed = () => { if (loadInFlight.current) void loadInFlight.current.then(load); else void load(); };
    window.addEventListener("focus", resume);
    for (const name of CHANGES) window.addEventListener(name, changed);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", resume);
      for (const name of CHANGES) window.removeEventListener(name, changed);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [load]);

  return { plan, error, refresh: load };
}
