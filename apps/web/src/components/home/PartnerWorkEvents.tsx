"use client";

import { useEffect, useMemo, useState } from "react";
import type { TPartnerWorkEvent } from "@warmap/contracts";
import type { TimedBlock } from "@/components/work/WorkTimeline";
import type { WaitingItem } from "@/lib/home/types";
import { cardHref, topicHref, waitingHref } from "@/lib/home/derive";
import h from "@/styles/home.module.css";

/** 同一件事从首页和伙伴都能进入原卡或原提问。已处理的旧事件仍可回看原件。 */
export function usePartnerWorkEvents(waiting: WaitingItem[], go: (href: string) => void): TimedBlock[] {
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
  return useMemo(() => {
    const byId = new Map(waiting.map(item => [item.id, item]));
    return items.map(item => {
      const original = item.waitingId ? byId.get(item.waitingId) : undefined;
      const href = original ? waitingHref(original) : item.subjectKind === "card" ? cardHref(item.subjectId) : topicHref(item.subjectId);
      return { key: item.id, at: item.at, node: <div className={h.line}>
        <button type="button" className={h.lineLink} onClick={() => go(href)}>{item.projectName} · {item.title} · {item.detail}</button>
      </div> };
    });
  }, [items, waiting, go]);
}
