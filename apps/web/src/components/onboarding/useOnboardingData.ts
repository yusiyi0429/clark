"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { browserApi } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";

/** 引导也读最新轮次；刷新只替换展示数据，不打断当前步骤或尚未保存的输入。 */
export function useOnboardingData(initial: components["schemas"]["OnboardingResponse"]) {
  const [data, setData] = useState(initial);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const loading = useRef(false);
  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const result = await browserApi.GET("/api/me/onboarding");
      if (!result.response.ok || !result.data) throw new Error("onboarding-refresh");
      setData(result.data);
      setRefreshError(null);
    } catch {
      setRefreshError("暂时没有连接成功，已保留当前内容；稍后会自动重试。");
    } finally {
      loading.current = false;
    }
  }, []);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    const focus = () => { void refresh(); };
    const timer = window.setInterval(visible, 20_000);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  return { data, refresh, refreshError };
}
