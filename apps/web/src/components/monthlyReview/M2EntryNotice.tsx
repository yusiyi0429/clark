"use client";

import { useEffect, useState } from "react";
import { ActionNoticeCard, type ActionNotice } from "@/components/ActionNoticeCard";
import { COMPANY_TIMEZONE } from "@/lib/companyTime";

/** 复盘与拆解的时段：公司时区的月末倒数第 3 天到次月 7 日。 */
export function inM2Window(now: Date): boolean {
  const [year, month, day] = now.toLocaleDateString("sv-SE", { timeZone: COMPANY_TIMEZONE }).split("-").map(Number);
  return day <= 7 || day >= new Date(Date.UTC(year, month, 0)).getUTCDate() - 2;
}

/** 卡里唯一一行：点了去 M2。M2 是另一个应用，整页跳过去（go 由调用方给，测试里换成记录）。 */
export function m2EntryNotices(go: (href: string) => void): ActionNotice[] {
  return [{ id: "m2-entry:open", title: "复盘与拆解", detail: "", onOpen: () => go("/m2/"), buttons: [] }];
}

/**
 * M2 的通知（溪南 10/27 初版接口 GET /m2/api/notifications）：环节、我的待办、@我、生成失败四种，合并少发、只读。
 * 点开时、点「知道了」时调 POST /m2/api/notifications/read 标已读（M2 页面从链接进入时也会自己标）。
 */
export type M2Notification = {
  id: string;
  type: "stage" | "todo" | "mention" | "failure";
  title: string;
  text?: string;
  link: string;
  dueAt?: string | null;
  status?: "open" | "done";
  unread?: boolean;
};
const TYPES = new Set(["stage", "todo", "mention", "failure"]);

/** 接口回来的 items 里只留认得的；环节卡已完成又看过的不显示（每人平时只看到一两张）。接口出错、404、不是 JSON 都当没有。 */
export function visibleM2Notifications(body: unknown): M2Notification[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is M2Notification => {
    const value = item as Partial<M2Notification> | null;
    return Boolean(value && typeof value.id === "string" && typeof value.title === "string" && typeof value.link === "string" && TYPES.has(value.type ?? ""))
      && !(value!.type === "stage" && value!.status === "done" && !value!.unread);
  });
}

const DUE = new Intl.DateTimeFormat("zh-CN", { timeZone: COMPANY_TIMEZONE, month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** dueAt 是带 Z 的时刻：「截止 10/31 周六 18:00」（北京时间），不到 24 小时标红；过了截止写「已过截止」。 */
function due(dueAt: string, now: Date): { text: string; soon: boolean } {
  const left = Date.parse(dueAt) - now.getTime();
  if (left <= 0) return { text: "已过截止", soon: true };
  const parts = Object.fromEntries(DUE.formatToParts(new Date(dueAt)).map((part) => [part.type, part.value]));
  return { text: `截止 ${parts.month}/${parts.day} ${parts.weekday} ${parts.hour}:${parts.minute}`, soon: left < 86_400_000 };
}

/** 标已读：一次最多 20 个；页面跳走也要发出去（keepalive），失败不提示（下次取通知时还在就再标）。 */
export function markM2NotificationsRead(ids: string[]): Promise<boolean> {
  return fetch("/m2/api/notifications/read", { method: "POST", credentials: "same-origin", keepalive: true,
    headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: ids.slice(0, 20) }) })
    .then((response) => response.ok, () => false);
}

/** 环节卡和 @我 可以在通知栏里「知道了」；待办办完、生成失败续跑成功才消失，不给关。 */
export function m2NotificationNotices(items: M2Notification[], go: (href: string) => void, now: Date, markRead = markM2NotificationsRead): ActionNotice[] {
  return items.map((item) => {
    const deadline = item.dueAt && item.status !== "done" ? due(item.dueAt, now) : null;
    return {
      id: `m2:${item.id}`,
      title: item.title,
      detail: [item.text, deadline?.text].filter(Boolean).join(" · "),
      tone: item.type === "failure" || deadline?.soon ? "red" : item.unread || item.type === "todo" ? "amber" : "neutral",
      onOpen: () => { void markRead([item.id]); go(`/m2/${item.link.replace(/^\/+/, "")}`); },
      buttons: item.type === "stage" || item.type === "mention"
        ? [{ label: "知道了", run: async () => (await markRead([item.id]) ? { ok: true as const, settled: "已读" } : { ok: false as const, error: "没标上，稍后再试" }) }]
        : [],
    };
  });
}

const POLL_MS = 60_000;

/** 每分钟取一次（带 ETag，没变化回 304 就沿用）；页面不在前台时不取，回到前台立即取。 */
function useM2Notifications(enabled: boolean): [M2Notification[], (id: string) => void] {
  const [items, setItems] = useState<M2Notification[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let etag: string | null = null;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch("/m2/api/notifications", { credentials: "same-origin", headers: etag ? { "If-None-Match": etag } : {} });
        if (response.status === 304) return;
        const next = response.ok ? visibleM2Notifications(await response.json()) : [];
        etag = response.ok ? response.headers.get("ETag") : null;
        if (alive) setItems(next);
      } catch {
        etag = null;
        if (alive) setItems([]);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => { alive = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", load); };
  }, [enabled]);
  return [items, (id: string) => setItems((current) => current.filter((item) => `m2:${item.id}` !== id))];
}

/**
 * 通知栏里的「目标拆解与协作」：M2 的通知（有就出，不限时段）在前，复盘与拆解时段里再加一行去 M2 的入口。
 * M2 对当前登录人不可用就整张不出；接口没接上或出错时只剩入口那一行。不是待办，不出条数角标。
 */
export function M2EntryNotice({ available, now = new Date() }: { available: boolean; now?: Date }) {
  const [items, dismiss] = useM2Notifications(available);
  if (!available) return null;
  const go = (href: string) => window.location.assign(href);
  const notices = [...m2NotificationNotices(items, go, now), ...(inM2Window(now) ? m2EntryNotices(go) : [])];
  if (!notices.length) return null;
  return <ActionNoticeCard id="m2-entry" title="目标拆解与协作" mark="monthly" counted={false} notices={notices} onSettled={dismiss} />;
}
