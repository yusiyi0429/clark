"use client";

/**
 * 通知栏置顶「会上定了」：我主持的会里还没确认的几条（每场最多 5 条）。参照飞书审批卡：在卡上直接办——
 * 「对」「其实没定」一点就办，「改一下」展开填写区、从原说法改起。办完原位写一行回执再淡出（ActionNoticeCard）。
 */
import { useCallback, useEffect, useState } from "react";
import type { TMyMeetingDecisionGroup } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { monthDayTime } from "@/lib/companyTime";
import { ActionNoticeCard, type ActionNotice } from "@/components/ActionNoticeCard";
import type { NoticeOutcome } from "@/components/NoticeActions";
import { MEETING_DECISIONS_CHANGED, reviewMeetingDecision } from "./meetingDecisionApi";

type Navigate = (href: string, origin?: Element | null) => void;

export function hostDecisionNotices(groups: TMyMeetingDecisionGroup[], meetingBase: string, onNavigate: Navigate,
  review: (meetingId: string, decisionId: string, verdict: "confirmed" | "edited" | "not_decided", statement?: string) => Promise<NoticeOutcome>): ActionNotice[] {
  return groups.flatMap((group) => group.decisions.map<ActionNotice>((decision) => ({
    id: decision.id,
    title: decision.statement,
    detail: [group.meetingTitle, decision.dueAt ? `${monthDayTime(decision.dueAt)} 前` : null, decision.recommendation === "not_decided" ? "Agent 判断没定" : null].filter(Boolean).join(" · "),
    tone: "amber",
    onOpen: (from) => onNavigate(`${meetingBase}/${group.meetingId}`, from),
    buttons: [
      { label: "对", emphasis: true, run: () => review(group.meetingId, decision.id, "confirmed") },
      { label: "其实没定", run: () => review(group.meetingId, decision.id, "not_decided") },
    ],
    reason: { label: "改一下", fieldLabel: "改成", placeholder: "", submitLabel: "保存", initial: decision.statement,
      run: (text) => review(group.meetingId, decision.id, "edited", text) },
  })));
}

export function HostDecisionNotices({ meetingBase, onNavigate }: { meetingBase: string; onNavigate: Navigate }) {
  const [groups, setGroups] = useState<TMyMeetingDecisionGroup[]>([]);
  const load = useCallback(async () => {
    try {
      const { data } = await browserApi.GET("/api/me/meeting-decisions");
      if (data) setGroups(data.groups);
    } catch { /* 下次再取 */ }
  }, []);
  useEffect(() => {
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    // 通知栏自己办完的那一条由回执淡出后收起；会议页上办的才重读。
    const changed = (event: Event) => { if ((event as CustomEvent<{ source?: string }>).detail?.source !== "rail") refresh(); };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    window.addEventListener(MEETING_DECISIONS_CHANGED, changed);
    window.addEventListener("meeting-changed", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(MEETING_DECISIONS_CHANGED, changed);
      window.removeEventListener("meeting-changed", refresh);
    };
  }, [load]);

  const review = useCallback(async (meetingId: string, decisionId: string, verdict: "confirmed" | "edited" | "not_decided", statement?: string): Promise<NoticeOutcome> => {
    try {
      await reviewMeetingDecision(meetingId, decisionId, verdict, statement, "rail");
      return { ok: true, settled: verdict === "confirmed" ? "已确认" : verdict === "edited" ? "已改" : "记为没定" };
    } catch (cause) {
      return { ok: false, error: (cause as Error).message || "没有成功，请重试" };
    }
  }, []);

  const onSettled = useCallback((noticeId: string) => {
    setGroups((current) => current.map((group) => ({ ...group, decisions: group.decisions.filter((decision) => decision.id !== noticeId) })).filter((group) => group.decisions.length));
  }, []);

  return <ActionNoticeCard id="meeting-decisions" title="会上定了" mark="meeting" notices={hostDecisionNotices(groups, meetingBase, onNavigate, review)} onSettled={onSettled} />;
}
