"use client";

import { useCallback, useEffect, useState } from "react";
import type { TMonthlyReviewNotice } from "@warmap/contracts";
import { ActionNoticeCard } from "@/components/ActionNoticeCard";
import { browserApi } from "@/lib/api/client";
import { calendarDate, companyMonth } from "@/lib/companyTime";

/** 复盘通知是服务端按当前状态现算的：进页面、回到前台、复盘有变动时重新读。 */
/** CEO 在月末前可以提前开始当月复盘：从 20 日起、当月还没有复盘时给一个入口（倒数第 3 天会自动开启）。 */
export type StartReviewEntry = { period: string; href: string };

export function useMonthlyReviewNotices(ceo = false): { notices: TMonthlyReviewNotice[]; start: StartReviewEntry | null } {
  const [notices, setNotices] = useState<TMonthlyReviewNotice[]>([]);
  const [start, setStart] = useState<StartReviewEntry | null>(null);
  const load = useCallback(async () => {
    try {
      const { data } = await browserApi.GET("/api/me/monthly-reviews");
      if (data) setNotices(data.notices);
      if (!ceo) return;
      const now = new Date();
      const period = companyMonth(now);
      if (Number(calendarDate(now.toISOString()).slice(8, 10)) < 20) { setStart(null); return; }
      const { data: current } = await browserApi.GET("/api/monthly-reviews/{period}", { params: { path: { period } } });
      setStart(current && !current.review && current.actions.some((action) => action.actionType === "monthly-review.open") ? { period, href: `/reviews/${period}` } : null);
    } catch { /* 下次再取 */ }
  }, [ceo]);
  useEffect(() => {
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("monthly-review-changed", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("monthly-review-changed", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);
  return { notices, start };
}

/** 通知栏里的「月末复盘」一组；没有待办时不出现。 */
export function MonthlyReviewNotices({ onNavigate, ceo = false }: { onNavigate: (href: string, origin?: Element | null) => void; ceo?: boolean }) {
  const { notices, start } = useMonthlyReviewNotices(ceo);
  return <ActionNoticeCard id="monthly-review" title="月末复盘" mark="monthly"
    notices={[
      ...(start ? [{ id: `monthly-review:start:${start.period}`, title: `开始 ${Number(start.period.slice(5))} 月复盘`, detail: "", tone: "neutral" as const, onOpen: (from: Element | null) => onNavigate(start.href, from), buttons: [] }] : []),
      // 个人复盘的待办在「个人复盘」看板卡的卡顶处理（PersonalReviewBoard），这里不重复。
      ...notices.filter((notice) => notice.kind !== "personal_todo").map((notice) => ({ id: notice.id, title: notice.text, detail: "", tone: "amber" as const, onOpen: (from: Element | null) => onNavigate(notice.href, from), buttons: [] })),
    ]}
    onSettled={() => undefined} />;
}
