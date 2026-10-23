"use client";

/**
 * 通知栏置顶「会议记录」：我主持或创建的会里待处理的会议记录，一场会一条（会名 + 状态），点了去会议页整卡确认。
 * 只提示，不在这里办；状态由服务端算（GET /api/me/meeting-cards）：待确认、修改待确认、写入失败。
 * 同一组里排在前面的是飞书里直接开的会待整理（GET /api/me/feishu-minutes）：卡上就能整理、记到天枢里约好的会、忽略。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { TFeishuMinuteInboxItem, TMyMeetingCard } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { daySpan } from "@/lib/companyTime";
import { ActionNoticeCard, type ActionNotice } from "@/components/ActionNoticeCard";
import type { NoticeOutcome } from "@/components/NoticeActions";
import { MeetingBookingSheet } from "./MeetingBookingSheet";
import { attachFeishuMinute, ignoreFeishuMinute } from "./meetingDecisionApi";

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

export type MinuteActs = {
  organize(minute: TFeishuMinuteInboxItem): Promise<NoticeOutcome>;
  attach(minute: TFeishuMinuteInboxItem): Promise<NoticeOutcome>;
  ignore(minute: TFeishuMinuteInboxItem): Promise<NoticeOutcome>;
};

/** 待整理一份妙记一条；对得上天枢里约好的会时，主按钮写全会名，「不是这场，另建一场」就是整理。 */
export function minuteNotices(minutes: TFeishuMinuteInboxItem[], act: MinuteActs, now = new Date()): ActionNotice[] {
  return minutes.map((minute) => {
    const when = `飞书会议 · ${daySpan(minute.startsAt, minute.endsAt, now)}`;
    const ignore = { label: "忽略", run: () => act.ignore(minute) };
    return {
      id: `feishu-minute:${minute.minuteToken}`,
      title: minute.title,
      detail: minute.suggestion ? when : `${when} · 待整理`,
      tone: "neutral",
      buttons: minute.suggestion
        ? [{ label: `记到天枢里的「${minute.suggestion.title}」`, emphasis: true, run: () => act.attach(minute) }, { label: "不是这场，另建一场", run: () => act.organize(minute) }, ignore]
        : [{ label: "整理", emphasis: true, run: () => act.organize(minute) }, ignore],
    };
  });
}

const MINUTE_ERROR: Record<string, string> = { MINUTE_TAKEN: "已经记到别的会上了", MINUTE_NOT_PENDING: "已经处理过了", SUGGESTION_CHANGED: "那场会已经变了" };
const minuteError = (code: string): NoticeOutcome => ({ ok: false, error: MINUTE_ERROR[code] ?? "没有办成" });

export function MeetingCardNoticeList({ meetings, minutes = [], meetingBase, onNavigate, onChanged }: {
  meetings: TMyMeetingCard[];
  minutes?: TFeishuMinuteInboxItem[];
  meetingBase: string;
  onNavigate: Navigate;
  onChanged?: () => void;
}) {
  /** 正在整理的那一份：表单整理成了或关掉时，兑现卡上那颗按钮。 */
  const [organizing, setOrganizing] = useState<{ minute: TFeishuMinuteInboxItem; settle(outcome: NoticeOutcome): void }>();
  /** 办完、回执也淡出了的：下一次取回新数据之前先不显示，免得按钮又闪出来；新数据到了就不再拦。 */
  const [settled, setSettled] = useState<{ ids: string[]; minutes: TFeishuMinuteInboxItem[] }>({ ids: [], minutes });
  const hidden = settled.minutes === minutes ? settled.ids : [];
  /** 记到成功的：回执淡出后才通知别处（meeting-changed），免得立刻重取把回执冲掉。 */
  const attached = useRef(new Set<string>());
  const finish = (outcome: NoticeOutcome) => {
    organizing?.settle(outcome);
    setOrganizing(undefined);
  };
  const act: MinuteActs = {
    organize: (minute) => new Promise((settle) => setOrganizing({ minute, settle })),
    attach: async (minute) => {
      const result = await attachFeishuMinute(minute.minuteToken, minute.suggestion?.meetingId ?? "");
      if ("code" in result) return minuteError(result.code);
      attached.current.add(`feishu-minute:${minute.minuteToken}`);
      return { ok: true, settled: `已记到「${minute.suggestion?.title}」` };
    },
    ignore: async (minute) => {
      const result = await ignoreFeishuMinute(minute.minuteToken);
      return "code" in result ? minuteError(result.code) : { ok: true, settled: "已忽略" };
    },
  };
  const onSettled = useCallback((noticeId: string) => {
    setSettled((current) => ({ ids: [...(current.minutes === minutes ? current.ids : []), noticeId], minutes }));
    if (attached.current.delete(noticeId)) window.dispatchEvent(new Event("meeting-changed"));
    onChanged?.();
  }, [minutes, onChanged]);
  const notices = [...minuteNotices(minutes, act), ...meetingCardNotices(meetings, meetingBase, onNavigate)].filter((notice) => !hidden.includes(notice.id));
  return (
    <>
      <ActionNoticeCard id="meeting-cards" title="会议记录" mark="meeting" notices={notices} onSettled={onSettled} />
      {organizing ? (
        <MeetingBookingSheet
          key={organizing.minute.minuteToken}
          open
          organize={{ minute: organizing.minute, meetingBase, onOrganized: () => finish({ ok: true, settled: "已整理" }) }}
          onClose={() => finish({ ok: false, cancelled: true })}
        />
      ) : null}
    </>
  );
}

/** 我要处理的会议记录和待整理的妙记：打开时一起取，每 30 秒（页面可见时）、回到窗口、会议记录状态变了（meeting-changed）再取；哪个没取到就留着上一次的。 */
export function useMeetingRecords(): { meetings: TMyMeetingCard[]; minutes: TFeishuMinuteInboxItem[]; reload(): void } {
  const [meetings, setMeetings] = useState<TMyMeetingCard[]>([]);
  const [minutes, setMinutes] = useState<TFeishuMinuteInboxItem[]>([]);
  const load = useCallback(async () => {
    await Promise.all([
      browserApi.GET("/api/me/meeting-cards").then(({ data }) => { if (data) setMeetings(data.meetings); }, () => undefined),
      browserApi.GET("/api/me/feishu-minutes").then(({ data }) => { if (data) setMinutes(data.minutes); }, () => undefined),
    ]);
  }, []);
  const reload = useCallback(() => void load(), [load]);
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
  return { meetings, minutes, reload };
}

export function MeetingCardNotices({ meetingBase, onNavigate }: { meetingBase: string; onNavigate: Navigate }) {
  const records = useMeetingRecords();
  return <MeetingCardNoticeList meetings={records.meetings} minutes={records.minutes} meetingBase={meetingBase} onNavigate={onNavigate} onChanged={records.reload} />;
}
