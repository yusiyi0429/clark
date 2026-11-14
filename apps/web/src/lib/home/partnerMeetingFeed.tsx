"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { browserApi } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { MEETING_CARD_COMMITTED } from "@/lib/meetingSync";
import { MEETING_CHANGED } from "./meeting";

export type PartnerMeeting = components["schemas"]["PartnerMeetingsResponse"]["items"][number];
type MeetingFeed = { items: PartnerMeeting[]; error: string | null; reload(): void };

const MeetingContext = createContext<MeetingFeed | null>(null);
const events = [MEETING_CHANGED, "meeting-changed", "meeting-card-reviewed", MEETING_CARD_COMMITTED, "focus"];

/** 同一个登录人的首页、开会弹层和伙伴对话共享列表。变更发生在请求途中时，等这一趟结束再取一次。 */
export function PartnerMeetingsProvider({ children }: { children: ReactNode }) {
  const [feed, setFeed] = useState<Omit<MeetingFeed, "reload">>({ items: [], error: null });
  const refresh = useRef<() => void>(() => {});
  const reload = useCallback(() => refresh.current(), []);

  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    let reading = false;
    let again = false;
    async function load() {
      if (controller.signal.aborted || document.visibilityState === "hidden") return;
      if (reading) { again = true; return; }
      reading = true;
      try {
        const { response, data } = await browserApi.GET("/api/me/partner-meetings", { signal: controller.signal, cache: "no-store" });
        if (controller.signal.aborted) return;
        if (!response.ok || !data) throw new Error(response.status === 401 ? "登录已过期" : "没有读到会议");
        setFeed({ items: data.items, error: null });
      } catch (cause) {
        if (!controller.signal.aborted) setFeed({ items: [], error: cause instanceof Error && cause.message === "登录已过期" ? cause.message : "没有读到会议" });
      } finally {
        reading = false;
        if (!controller.signal.aborted) {
          timer = window.setTimeout(load, again ? 0 : 15_000);
          again = false;
        }
      }
    }
    function schedule() {
      window.clearTimeout(timer);
      if (document.visibilityState === "hidden") return;
      if (reading) again = true;
      else timer = window.setTimeout(load, 0);
    }
    refresh.current = schedule;
    void load();
    events.forEach((name) => window.addEventListener(name, schedule));
    document.addEventListener("visibilitychange", schedule);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      events.forEach((name) => window.removeEventListener(name, schedule));
      document.removeEventListener("visibilitychange", schedule);
      refresh.current = () => {};
    };
  }, []);

  return <MeetingContext.Provider value={{ ...feed, reload }}>{children}</MeetingContext.Provider>;
}

export function usePartnerMeetings(): MeetingFeed {
  const value = useContext(MeetingContext);
  if (!value) throw new Error("PartnerMeetingsProvider is required");
  return value;
}
