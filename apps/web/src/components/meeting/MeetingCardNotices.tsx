"use client";

/**
 * 通知栏的会后两组（10/28 起记录正文不用确认，不进通知栏）：
 * - 「会后确认」：等我确认的决策和行动项（GET /api/me/meeting-cards 的 confirms），一次只出一条、左右翻；卡上当场确认或写原因说不对，不进二级页。
 *   我主持的会里没有责任人的决策，点了去会议页交给一位参会人。
 *   成员和 CEO 用同一个组件、同一个接口，按人给。
 * - 「会议记录」：飞书里直接开的会待整理（GET /api/me/feishu-minutes，卡上整理、记到天枢里约好的会、忽略），
 *   和我主持或创建的会里写入本体失败的（卡上重试）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { TFeishuMinuteInboxItem, TMyMeetingCard, TMyMeetingConfirm } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { daySpan } from "@/lib/companyTime";
import { ActionNoticeCard, type ActionNotice } from "@/components/ActionNoticeCard";
import type { NoticeOutcome } from "@/components/NoticeActions";
import { dateLabel } from "@/components/ui/pickerFormat";
import { MeetingBookingSheet } from "./MeetingBookingSheet";
import { retryMeetingCardSync, reviewMeetingCardItem } from "./meetingCardApi";
import { attachFeishuMinute, ignoreFeishuMinute } from "./meetingDecisionApi";

type Navigate = (href: string, origin?: Element | null) => void;

/** 写入失败的会议记录：卡上重试（重排当前确认版的写入），点标题去会议页。 */
export function meetingCardNotices(meetings: TMyMeetingCard[], meetingBase: string, onNavigate: Navigate,
  retry: (meeting: TMyMeetingCard) => Promise<NoticeOutcome>): ActionNotice[] {
  return meetings.map((meeting) => ({
    id: meeting.meetingId,
    title: meeting.title,
    detail: "写入失败",
    tone: "red",
    onOpen: (from) => onNavigate(`${meetingBase}/${meeting.meetingId}`, from),
    buttons: [{ label: "重试", emphasis: true, run: () => retry(meeting) }],
  }));
}

export type ConfirmActs = {
  review(item: TMyMeetingConfirm, verdict: "confirm" | "reject", reason?: string): Promise<NoticeOutcome>;
  /** 去会议页（没有责任人的决策在那里交给一位参会人）。 */
  open(item: TMyMeetingConfirm, from: Element | null): void;
};
const CONFIRM_WORDS = {
  decision: { label: "决策确认", confirm: "确认", confirmed: "已确认", reject: "不对", field: "哪里不对", submit: "提交", rejected: "已标为不对" },
  action: { label: "行动项确认", confirm: "接下", confirmed: "已接下", reject: "退回", field: "退回的原因", submit: "退回", rejected: "已退回" },
} as const;
const receipt = (outcome: NoticeOutcome, text: string): NoticeOutcome => (outcome.ok ? { ok: true, settled: text } : outcome);

/**
 * 等我处理的一条：标签写类别，正文是决策或事项本身，小字是来自哪场会（行动项带截止）。
 * 没有责任人的决策（我是主持人）：去会议页交给一位参会人，交出去之前一直留着。
 */
export function confirmNotices(confirms: TMyMeetingConfirm[], act: ConfirmActs): ActionNotice[] {
  return confirms.map((item) => {
    if (item.needsOwner) {
      return {
        id: `${item.meetingId}:owner:${item.id}`,
        label: "指定责任人",
        title: item.text,
        detail: `来自「${item.title}」`,
        tone: "amber",
        onOpen: (from) => act.open(item, from),
        buttons: [{ label: "去指定", emphasis: true, run: async () => { act.open(item, null); return { ok: false, cancelled: true }; } }],
      };
    }
    const words = CONFIRM_WORDS[item.kind];
    return {
      id: `${item.meetingId}:${item.kind}:${item.id}`,
      label: words.label,
      title: item.text,
      detail: `来自「${item.title}」${item.dueDate ? ` · 截止 ${dateLabel(item.dueDate)}` : ""}`,
      tone: "amber",
      buttons: [{ label: words.confirm, emphasis: true, run: async () => receipt(await act.review(item, "confirm"), words.confirmed) }],
      reason: { label: words.reject, fieldLabel: words.field, placeholder: "比如：会上没这么定", submitLabel: words.submit,
        run: async (reason) => receipt(await act.review(item, "reject", reason), words.rejected) },
    };
  });
}
const REVIEW_ERROR: Record<string, string> = { ALREADY_REVIEWED: "已经处理过了", CARD_FROZEN: "这场会的决策已经定版", REASON_REQUIRED: "要写一句原因" };

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

/** 没传时用同一个空列表：「办完的先不显示」按列表是不是同一份来判断有没有取回新数据。 */
const NO_CONFIRMS: TMyMeetingConfirm[] = [];

export function MeetingCardNoticeList({ meetings, confirms = NO_CONFIRMS, minutes = [], meetingBase, onNavigate, onChanged }: {
  meetings: TMyMeetingCard[];
  confirms?: TMyMeetingConfirm[];
  minutes?: TFeishuMinuteInboxItem[];
  meetingBase: string;
  onNavigate: Navigate;
  onChanged?: () => void;
}) {
  /** 正在整理的那一份：表单整理成了或关掉时，兑现卡上那颗按钮。 */
  const [organizing, setOrganizing] = useState<{ minute: TFeishuMinuteInboxItem; settle(outcome: NoticeOutcome): void }>();
  /** 办完、回执也淡出了的：下一次取回新数据之前先不显示，免得按钮又闪出来；新数据到了就不再拦。 */
  const [settled, setSettled] = useState<{ ids: string[]; minutes: TFeishuMinuteInboxItem[]; confirms: TMyMeetingConfirm[] }>({ ids: [], minutes, confirms });
  const hidden = settled.minutes === minutes && settled.confirms === confirms ? settled.ids : [];
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
    setSettled((current) => ({ ids: [...(current.minutes === minutes && current.confirms === confirms ? current.ids : []), noticeId], minutes, confirms }));
    if (attached.current.delete(noticeId)) window.dispatchEvent(new Event("meeting-changed"));
    onChanged?.();
  }, [minutes, confirms, onChanged]);
  const review: ConfirmActs["review"] = async (item, verdict, reason) => {
    const result = await reviewMeetingCardItem(item.meetingId, { kind: item.kind, id: item.id, verdict, ...(reason ? { reason } : {}) });
    if (!result.ok) return { ok: false, error: result.status === 0 ? "网络不通，再试一次" : REVIEW_ERROR[result.code] ?? "没有办成" };
    // 会议页开着的话跟着刷新逐条状态。
    window.dispatchEvent(new CustomEvent("meeting-card-reviewed", { detail: { meetingId: item.meetingId } }));
    return { ok: true };
  };
  const retry = async (meeting: TMyMeetingCard): Promise<NoticeOutcome> => {
    const result = await retryMeetingCardSync(meeting.meetingId);
    return result.ok ? { ok: true, settled: "已重新写入" } : { ok: false, error: result.status === 0 ? "网络不通，再试一次" : "没有办成" };
  };
  const open: ConfirmActs["open"] = (item, from) => onNavigate(`${meetingBase}/${item.meetingId}`, from);
  const pending = confirmNotices(confirms, { review, open }).filter((notice) => !hidden.includes(notice.id));
  const notices = [...minuteNotices(minutes, act), ...meetingCardNotices(meetings, meetingBase, onNavigate, retry)].filter((notice) => !hidden.includes(notice.id));
  return (
    <>
      <ActionNoticeCard id="meeting-confirms" title="会后确认" mark="decision" notices={pending} paged plain onSettled={onSettled} />
      <ActionNoticeCard id="meeting-cards" title="会议记录" mark="record" notices={notices} onSettled={onSettled} />
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

/** 等我确认的条目、写入失败的会议记录和待整理的妙记：打开时一起取，每 30 秒（页面可见时）、回到窗口、会议记录状态变了（meeting-changed）再取；哪个没取到就留着上一次的。 */
export function useMeetingRecords(): { meetings: TMyMeetingCard[]; confirms: TMyMeetingConfirm[]; minutes: TFeishuMinuteInboxItem[]; reload(): void } {
  const [cards, setCards] = useState<{ meetings: TMyMeetingCard[]; confirms: TMyMeetingConfirm[] }>({ meetings: [], confirms: [] });
  const [minutes, setMinutes] = useState<TFeishuMinuteInboxItem[]>([]);
  const load = useCallback(async () => {
    await Promise.all([
      browserApi.GET("/api/me/meeting-cards").then(({ data }) => { if (data) setCards(data); }, () => undefined),
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
  return { ...cards, minutes, reload };
}

export function MeetingCardNotices({ meetingBase, onNavigate }: { meetingBase: string; onNavigate: Navigate }) {
  const records = useMeetingRecords();
  return <MeetingCardNoticeList meetings={records.meetings} confirms={records.confirms} minutes={records.minutes} meetingBase={meetingBase} onNavigate={onNavigate} onChanged={records.reload} />;
}
