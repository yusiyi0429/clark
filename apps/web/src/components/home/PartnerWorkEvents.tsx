"use client";

import { useEffect, useMemo, useState } from "react";
import type { TPartnerWorkEvent } from "@warmap/contracts";
import type { TimedBlock } from "@/components/work/WorkTimeline";
import type { WaitingItem } from "@/lib/home/types";
import { cardHref, topicHref, waitingHref } from "@/lib/home/derive";
import h from "@/styles/home.module.css";

/** 在右边开这个会话（rightOpener）：开了回 true；手机上、首页数据里找不到的回 false。 */
type OpenRight = (subject: { kind: "card" | "topic"; id: string }, from?: string) => boolean;

/**
 * 主线里的事件行：项目名 · 会话名 · 说明；从主线开的会话做完一轮写「做完一轮」，有摘要接「：摘要」（放不下换行，不截）。
 * 点了：给了 open 时先在右边开（从主线开的带上项目名）；开不了的照旧去原卡、原提问或那个会话。
 */
export function workEventBlocks(items: readonly TPartnerWorkEvent[], waiting: readonly WaitingItem[], go: (href: string) => void, open?: OpenRight): TimedBlock[] {
  const byId = new Map(waiting.map(item => [item.id, item]));
  return items.map(item => {
    const original = item.waitingId ? byId.get(item.waitingId) : undefined;
    const href = original ? waitingHref(original) : item.subjectKind === "card" ? cardHref(item.subjectId) : topicHref(item.subjectId);
    const press = () => { if (!open?.({ kind: item.subjectKind, id: item.subjectId }, item.fromMain ? item.projectName : undefined)) go(href); };
    const words = item.done ? `做完一轮${item.detail ? `：${item.detail}` : ""}` : item.detail;
    return { key: item.id, at: item.at, node: <div className={h.line}>
      <button type="button" className={h.lineLink} onClick={press} data-testid="work-event">{`${item.projectName} · ${item.title} · ${words}`}</button>
    </div> };
  });
}

/** 同一件事从首页和伙伴都能进入原卡或原提问。已处理的旧事件仍可回看原件。 */
export function usePartnerWorkEvents(waiting: WaitingItem[], go: (href: string) => void, open?: OpenRight): TimedBlock[] {
  const [items, setItems] = useState<TPartnerWorkEvent[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    let reading = false;
    const read = async () => {
      if (reading || document.visibilityState === "hidden") return;
      reading = true;
      try {
        const response = await fetch("/api/me/partner-work-events", { cache: "no-store", signal: controller.signal });
        if (response.status === 401 || response.status === 403) setItems([]);
        if (!response.ok) return;
        const result = await response.json() as { items: TPartnerWorkEvent[] };
        if (!controller.signal.aborted) setItems(result.items);
      } catch { /* 上次读到的事件留在原处，回到前台或下次刷新时重读。 */ }
      finally { reading = false; }
    };
    void read();
    const timer = window.setInterval(read, 30_000);
    document.addEventListener("visibilitychange", read);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", read); };
  }, []);
  return useMemo(() => workEventBlocks(items, waiting, go, open), [items, waiting, go, open]);
}
