"use client";

import { useEffect, useState } from "react";
import { browserApi } from "@/lib/api/client";

/** 首页「全局进展」入口上的两个数：红线几条、计划外几条。读不到时为 null，入口照常显示。 */
export function useProgressCounts() {
  const [counts, setCounts] = useState<{ redLines: number; offPlan: number } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const { data } = await browserApi.GET("/api/progress");
        if (alive && data) setCounts({ redLines: data.progress.redLines.length, offPlan: data.progress.offPlan.length });
      } catch { /* 下次回到前台再读 */ }
    };
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", refresh);
    return () => { alive = false; window.removeEventListener("focus", refresh); };
  }, []);
  return counts;
}
