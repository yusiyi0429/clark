"use client";

/**
 * 通知栏置顶「会议记录」：我主持或创建的会里待处理的会议记录，一场会一条（会名 + 状态），点了去会议页整卡确认。
 * 只提示，不在这里办；状态由服务端算（GET /api/me/meeting-cards）：待确认、修改待确认、写入失败。
 */
import { useCallback, useEffect, useState } from "react";
import type { TMyMeetingCard } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { ActionNoticeCard, type ActionNotice } from "@/components/ActionNoticeCard";

type Navigate = (href: string, origin?: Element | null) => void;

const STATUS_LABEL: Record<TMyMeetingCard["status"], string> = { pending: "待确认", edit_pending: "修改待确认", failed: "写入失败" };

export function meetingCardNotices(meetings: TMyMeetingCard[], meetingBase: string, onNavigate: Navigate): ActionNotice[] {
  return meetings.map((meeting) => ({
    id: meeting.meetingId,
    title: meeting.title,
    detail: STATUS_LABEL[meeting.status],
    tone: meeting.status === "failed" ? "red" : "amber",
    onOpen: (from) => onNavigate(`${meetingBase}/${meeting.meetingId}`, from),
    buttons: [],
  }));
}

export function MeetingCardNoticeList({ meetings, meetingBase, onNavigate }: { meetings: TMyMeetingCard[]; meetingBase: string; onNavigate: Navigate }) {
  return <ActionNoticeCard id="meeting-cards" title="会议记录" mark="meeting" notices={meetingCardNotices(meetings, meetingBase, onNavigate)} onSettled={() => undefined} />;
}

export function MeetingCardNotices({ meetingBase, onNavigate }: { meetingBase: string; onNavigate: Navigate }) {
  const [meetings, setMeetings] = useState<TMyMeetingCard[]>([]);
  const load = useCallback(async () => {
    try {
      const { data } = await browserApi.GET("/api/me/meeting-cards");
      if (data) setMeetings(data.meetings);
    } catch { /* 下次再取 */ }
  }, []);
  useEffect(() => {
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("meeting-changed", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("meeting-changed", refresh);
    };
  }, [load]);
  return <MeetingCardNoticeList meetings={meetings} meetingBase={meetingBase} onNavigate={onNavigate} />;
}
