"use client";

/**
 * 通知栏里的「周复盘」（D-01）：周五 15:00 Co-Agent 起草后出现，本人那份没提交时在卡顶给「本周复盘待确认」；
 * 下面是看得到的人（同战场、CEO 看全部）这一周的提交情况，点开看（提交前别人看不到正文）。页头可以翻到上一周、下一周。
 */
import { useCallback, useEffect, useState } from "react";
import { Card as HeroCard } from "@heroui/react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import type { TWeeklyReviewBoard } from "@warmap/contracts";
import { ContextMark } from "@/components/ContextMark";
import { browserApi } from "@/lib/api/client";
import { COMPANY_TIMEZONE } from "@/lib/companyTime";
import n from "@/styles/notifications.module.css";
import a from "@/styles/notice-actions.module.css";
import b from "@/components/monthlyReview/personal-review-board.module.css";
import w from "./weekly-review-board.module.css";
import { weekLabel, weeklyStatusText } from "./weeklyReviewApi";

type Navigate = (href: string, origin?: Element | null) => void;

/** CEO 通知栏里周复盘出现的时段：公司时区的周五到下周一（周五起草，周一前收齐）。 */
export function inWeeklyReviewWindow(now: Date): boolean {
  return ["Fri", "Sat", "Sun", "Mon"].includes(new Intl.DateTimeFormat("en-US", { timeZone: COMPANY_TIMEZONE, weekday: "short" }).format(now));
}

export function useWeeklyReviewBoard() {
  const [board, setBoard] = useState<TWeeklyReviewBoard | null>(null);
  const [week, setWeek] = useState<string | undefined>(undefined);
  const load = useCallback(async () => {
    try {
      const { data } = await browserApi.GET("/api/weekly-reviews/board", { params: { query: week ? { week } : {} } });
      if (data) setBoard(data.board);
    } catch { /* 下次再取 */ }
  }, [week]);
  useEffect(() => {
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("weekly-review-changed", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("weekly-review-changed", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);
  return { board, showWeek: setWeek };
}

/** 名单数据由调用方的 useWeeklyReviewBoard 给（通知栏要据此判断是不是「暂时没有新通知」）。 */
export function WeeklyReviewBoard({ onNavigate, state }: { onNavigate: Navigate; state: ReturnType<typeof useWeeklyReviewBoard> }) {
  const { board, showWeek } = state;
  if (!board || !board.rows.length) return null;
  const self = board.rows.find((row) => row.isSelf);
  const open = (href: string, event: { target: EventTarget }) => onNavigate(href, (event.target as Element).closest("[data-notice]"));
  const selfTitle = !self ? null : self.status === "drafting" ? `${board.isCurrentWeek ? "本周" : weekLabel(board.weekStart, board.weekEnd)}复盘生成中`
    : self.status === "submitted" ? null : `${board.isCurrentWeek ? "本周" : weekLabel(board.weekStart, board.weekEnd)}复盘待确认`;

  return <HeroCard<"section"> render={(props) => <section {...props} />} className={n.card} data-notice="weekly-review" aria-label="周复盘">
    <HeroCard.Header<"header"> render={(props) => <header {...props} />} className={n.glassHeader}>
      <ContextMark kind="review" className={n.glyph} />
      <span className={n.identity}>
        <strong>周复盘<b className={`${n.count} ${b.ratio}`} aria-label={`已提交 ${board.counts.submitted} / ${board.counts.total}`}>{board.counts.submitted}/{board.counts.total}</b></strong>
        <small className={w.week}>
          <button type="button" aria-label="上一周" disabled={!board.previousWeek} onClick={() => board.previousWeek && showWeek(board.previousWeek)}><ChevronLeft size={14} aria-hidden /></button>
          {weekLabel(board.weekStart, board.weekEnd)}
          <button type="button" aria-label="下一周" disabled={!board.nextWeek} onClick={() => board.nextWeek && showWeek(board.nextWeek)}><ChevronRight size={14} aria-hidden /></button>
        </small>
      </span>
    </HeroCard.Header>
    <div className={n.tray}>
      {self && selfTitle ? <div className={a.push}>
        <div className={a.openRow}>
          <button type="button" className={n.item} data-tone="amber" onClick={(event) => open(self.href, event)} aria-label={`打开我的周复盘：${selfTitle}`}>
            <span className={n.mark} aria-hidden="true" />
            <span className={n.itemText}><span>{selfTitle}</span></span>
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        </div>
      </div> : null}
      {self?.status === "submitted" ? <p className={b.selfDone} role="status"><Check size={15} aria-hidden />{board.isCurrentWeek ? "本周" : "这一周"}复盘已提交</p> : null}
      <ul className={b.roster} aria-label="提交情况">
        {board.rows.map((row) => {
          const tone = row.status === "submitted" ? "done" : "open";
          return <li key={row.weeklyReviewId} className={b.row} data-tone={tone}>
            <button type="button" className={b.open} onClick={(event) => open(row.href, event)} aria-label={`打开 ${row.personName} 的周复盘`}>
              <span className={b.name}>{row.personName}{row.isSelf ? <em>（你）</em> : null}</span>
              <span className={b.state} data-tone={tone}>{weeklyStatusText(row.status, row.origin, row.isSelf)}</span>
              <ChevronRight size={14} aria-hidden />
            </button>
          </li>;
        })}
      </ul>
    </div>
  </HeroCard>;
}
