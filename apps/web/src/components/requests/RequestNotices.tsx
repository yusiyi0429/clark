"use client";

/**
 * 通知栏里的「请求」一组（参照 Linear Inbox 的待处理）：收到还没完成的待办卡、我发出的有问题待回答的（点开落到问答区）、有人完成或回答了还没看的。
 * 打开那条请求即读；页头右上角「+」发起新请求，点页头进列表。CEO 和成员共用，各自传入路径前缀。
 */
import { useCallback, useEffect, useState } from "react";
import { Card as HeroCard } from "@heroui/react";
import { ChevronRight, Plus, Send, Waypoints } from "lucide-react";
import type { TRequestListItem } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { monthDayTime } from "@/lib/companyTime";
import { REQUESTS_CHANGED } from "./requestApi";
import n from "@/styles/notifications.module.css";
import s from "./requests.module.css";

type Navigate = (href: string, origin?: Element | null) => void;
/** qa：点开直接落到问答区（有问题等我回答时）。 */
type Notice = { id: string; title: string; detail: string; tone: "amber" | "neutral"; qa?: boolean };

/** 影响卡（kind = impact，会后决定或文档变更推来的）：还没处理的、或有更新没看的；单独一组，在请求上面。 */
export function impactNotices(inbox: TRequestListItem[]): Notice[] {
  return inbox.filter((item) => item.kind === "impact" && (item.myStatus === "pending" || item.unread)).map((item) => ({
    id: item.id, title: item.title, tone: item.unread ? "amber" : "neutral", detail: [item.initiatorName, monthDayTime(item.sentAt)].filter(Boolean).join(" · "),
  }));
}

export function requestNotices(inbox: TRequestListItem[], sent: TRequestListItem[]): Notice[] {
  const received = inbox.filter((item) => item.kind !== "impact" && (item.myStatus === "pending" || item.unread)).map<Notice>((item) => ({
    id: item.id, title: item.title, tone: item.unread ? "amber" : "neutral",
    detail: [item.initiatorName, monthDayTime(item.sentAt), item.myStatus === "done" ? (item.kind === "collection" ? "已确认" : "已完成")
      : item.fieldsFilled ? `已填 ${item.fieldsFilled.filled}/${item.fieldsFilled.required}` : ""].filter(Boolean).join(" · "),
  }));
  const mine = sent.filter((item) => item.status !== "draft" && (item.openQuestions > 0 || item.unread)).map<Notice>((item) => ({
    id: item.id, title: item.title, tone: item.openQuestions > 0 ? "amber" : "neutral", qa: item.openQuestions > 0,
    detail: item.openQuestions > 0 ? `${item.openQuestions} 问待回答` : `${item.recipientsDone}/${item.recipientNames.length} ${item.kind === "collection" ? "已确认" : "完成"}`,
  }));
  return [...received, ...mine];
}

export function RequestNotices({ base, currentHref, onNavigate }: { base: string; currentHref?: string; onNavigate: Navigate }) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [impacts, setImpacts] = useState<Notice[]>([]);
  const load = useCallback(async () => {
    try {
      const [inbox, sent] = await Promise.all([
        browserApi.GET("/api/me/requests", { params: { query: { box: "inbox" } } }),
        browserApi.GET("/api/me/requests", { params: { query: { box: "sent" } } }),
      ]);
      if (inbox.data && sent.data) {
        setNotices(requestNotices(inbox.data.items, sent.data.items));
        setImpacts(impactNotices(inbox.data.items));
      }
    } catch { /* 下次再取 */ }
  }, []);
  useEffect(() => {
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, 20_000);
    window.addEventListener("focus", refresh);
    window.addEventListener(REQUESTS_CHANGED, refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener(REQUESTS_CHANGED, refresh); };
  }, [load]);
  // 打开过的请求服务端已标为已读：换页时重读一次。
  useEffect(() => { void load(); }, [currentHref, load]);

  const origin = (target: EventTarget) => (target as Element).closest("[data-notice]");
  const row = (notice: Notice) => {
    const href = `${base}/${encodeURIComponent(notice.id)}`;
    return (
      <button key={notice.id} type="button" className={n.item} data-tone={notice.tone} aria-current={href === currentHref?.split("#")[0] ? "true" : undefined}
        onClick={(event) => onNavigate(notice.qa ? `${href}#qa` : href, origin(event.target))}>
        <span className={n.mark} aria-hidden="true" />
        <span className={n.itemText}><span>{notice.title}</span><small>{notice.detail}</small></span>
        <ChevronRight size={15} aria-hidden="true" />
      </button>
    );
  };
  return (
    <>
    {impacts.length ? (
      <HeroCard<"section"> render={(props) => <section {...props} />} className={n.card} data-notice="impacts" aria-label="影响">
        <HeroCard.Header<"header"> render={(props) => <header {...props} />} className={n.glassHeader}>
          <span className={`${n.glyph} ${s.glyph}`} aria-hidden="true"><Waypoints size={17} /></span>
          <span className={n.identity}><strong>影响<b className={n.count}>{impacts.length}</b></strong></span>
        </HeroCard.Header>
        <div className={n.tray}>{impacts.map(row)}</div>
      </HeroCard>
    ) : null}
    <HeroCard<"section"> render={(props) => <section {...props} />} className={n.card} data-notice="requests" aria-label="请求">
      <HeroCard.Header<"header"> render={(props) => <header {...props} />} className={n.glassHeader}>
        <span className={`${n.glyph} ${s.glyph}`} aria-hidden="true"><Send size={17} /></span>
        <button type="button" className={`${n.identity} ${s.headerOpen}`} onClick={(event) => onNavigate(base, origin(event.target))} aria-label="打开请求列表">
          <strong>请求{notices.length ? <b className={n.count}>{notices.length}</b> : null}</strong>
        </button>
        <button type="button" className={s.corner} onClick={(event) => onNavigate(`${base}/new`, origin(event.target))} aria-label="新请求" title="新请求">
          <Plus size={18} aria-hidden="true" />
        </button>
      </HeroCard.Header>
      {notices.length ? <div className={n.tray}>{notices.map(row)}</div> : null}
    </HeroCard>
    </>
  );
}
