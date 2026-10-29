"use client";

import { useEffect, useState } from "react";
import { browserApi } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";

export type FeishuEvent = components["schemas"]["FeishuCalendarEventsResponse"]["events"][number];

/** 服务端按人缓存 5 分钟，这里同样 5 分钟读一次。 */
const REFRESH_MS = 5 * 60_000;

/** 本人飞书日历里接下来 7 天的日程（只读，和「会议安排」排在一起）：打开时读一次，之后 5 分钟一次、回到前台再读；读不到就是空的。已经结束的不给。 */
export function useFeishuEvents(): FeishuEvent[] {
  const [events, setEvents] = useState<FeishuEvent[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { data } = await browserApi.GET("/api/me/feishu-events").catch(() => ({ data: undefined }));
      if (alive && data) setEvents(data.events);
    };
    const resume = () => { if (document.visibilityState === "visible") void load(); };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    document.addEventListener("visibilitychange", resume);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, []);
  const now = Date.now();
  return events.filter((event) => Date.parse(event.endsAt) > now);
}
