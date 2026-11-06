"use client";

/**
 * 成员的通知栏（左栏）：会议、日程、复盘、请求、任务卡、待归位、分派、结果、协作、群聊、雷达，底部个人菜单。
 * 原先写在 MemberWorkspace 里，新首页 /me/work 也要原样放进来（V2 设计第 20.4 节），所以挪成一个组件；lead 放在最上面（「worker 等你」）。
 */
import { useState, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { AccountMenu, type Account } from "@/components/AccountMenu";
import { ActionNoticeCard } from "@/components/ActionNoticeCard";
import { unplacedNotices } from "@/components/tasks/Unplaced";
import { HeroButton } from "@/components/HeroButton";
import { RailClock } from "@/components/NotificationRail";
import { MissionCardNoticeGroup } from "@/components/missionCards/MissionCardNoticeGroup";
import { MonthlyReviewNotices } from "@/components/monthlyReview/MonthlyReviewNotices";
import { M2EntryNotice } from "@/components/monthlyReview/M2EntryNotice";
import { PersonalReviewBoard } from "@/components/monthlyReview/PersonalReviewBoard";
import { RequestNotices, type RequestCounts } from "@/components/requests/RequestNotices";
import { MeetingCardNoticeList, useMeetingRecords } from "@/components/meeting/MeetingCardNotices";
import { useFeishuEvents } from "@/components/meeting/useFeishuEvents";
import { railBackgroundProps, useRailBackground } from "@/components/railBackground/useRailBackground";
import type { WorkspaceApi } from "@/components/shell/WorkspaceContext";
import { logout } from "@/lib/logout";
import type { useHomePlan } from "./home/useHomePlan";
import { MemberRadarNotices, noteworthySignals } from "./MemberRadarNotices";
import { MemberMeetingSchedule } from "./MemberMeetingSchedule";
import { memberNoticeGroups, quietNoticeCount } from "./memberNotices";
import type { useMemberHome } from "./useMemberHome";
import n from "@/styles/notifications.module.css";
import rb from "@/styles/rail-background.module.css";
import m from "@/styles/member-home.module.css";

const NO_REQUESTS: RequestCounts = { items: 0, waitingReplies: 0 };

export function MemberNoticeRail({ api, currentHref, home, plan, account, homeHref = "/me", lead, leadCount = 0, onRequestCounts }: {
  api: Pick<WorkspaceApi, "navigate" | "detailOpen" | "m2Available">;
  currentHref: string;
  home: ReturnType<typeof useMemberHome>;
  plan: ReturnType<typeof useHomePlan>;
  account: Account;
  homeHref?: string;
  /** 放在通知最上面的一组（新首页的「worker 等你」）。 */
  lead?: ReactNode;
  leadCount?: number;
  /** 请求、影响两组的条数（首页「等回复 N」要用）。 */
  onRequestCounts?: (counts: RequestCounts) => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const [requests, setRequests] = useState(NO_REQUESTS);
  const railBackground = useRailBackground();
  const records = useMeetingRecords();
  const feishuEvents = useFeishuEvents();
  const radarSignals = noteworthySignals(home.radar);
  const counts = (next: RequestCounts) => { setRequests(next); onRequestCounts?.(next); };
  return (
    <aside className={`${n.rail} ${rb.bg}`} {...railBackgroundProps(railBackground)} aria-label="通知">
      <RailClock
        homeActive={!api.detailOpen}
        onHome={() => api.navigate(homeHref)}
        lead={
          <HeroButton variant="ghost" size="sm" isIconOnly type="button" onPress={() => {
              setLeaving(true);
              void logout();
            }}
            isDisabled={leaving} aria-label="退出登录" title="退出登录">
            <Lock aria-hidden="true" />
          </HeroButton>
        }
      />
      <div className={n.noticeList}>
        {lead}
        {/* M2 接管复盘和拆解时，天枢自己的周期卡（个人复盘、月度复盘）不出，同 CEO 通知栏；任务卡签发只看 M2。 */}
        <MeetingCardNoticeList meetings={records.meetings} confirms={records.confirms} minutes={records.minutes} meetingBase="/me/meetings" onNavigate={api.navigate} onChanged={records.reload} />
        <MemberMeetingSchedule meetings={home.meetings} feishuEvents={feishuEvents} onNavigate={api.navigate} />
        {api.m2Available ? null : <PersonalReviewBoard onNavigate={api.navigate} />}
        <RequestNotices base="/me/requests" currentHref={currentHref} onNavigate={api.navigate} header={false} onCounts={counts} />
        <M2EntryNotice available={api.m2Available ?? false} />
        {api.m2Available ? null : <MonthlyReviewNotices onNavigate={api.navigate} />}
        {home.rounds.map((round) => <MissionCardNoticeGroup key={round.roundId} round={round} entry="member" currentHref={currentHref} onNavigate={api.navigate} onRefresh={home.refresh} />)}
        <ActionNoticeCard id="unplaced" plain title="待归位的事项" subtitle="还没有所属 Mission" mark="unplaced"
          notices={unplacedNotices(plan.plan?.unplaced ?? [], (id, from) => api.navigate(`/me/tasks/${encodeURIComponent(id)}`, from))} onSettled={() => undefined} />
        <ActionNoticeCard id="assigned" plain title="分给你的事与邀请" subtitle="会后分派与协作邀请" mark="assign" notices={memberNoticeGroups(home.notifications, { ...home, openTask: (id, from) => api.navigate(`/me/tasks/${encodeURIComponent(id)}`, from), openGroup: (type, id, from) => api.navigate(`/me/${type === "issue" ? "issues" : "meetings"}/${encodeURIComponent(id)}`, from) }).assigned} onSettled={home.settle} />
        <ActionNoticeCard id="results" title="回复与结果" mark="progress" notices={memberNoticeGroups(home.notifications, { ...home, openTask: (id, from) => api.navigate(`/me/tasks/${encodeURIComponent(id)}`, from), openAcceptance: (id, from) => api.navigate(`/me/tasks/${encodeURIComponent(id)}?accept=1`, from), openGroup: (type, id, from) => api.navigate(`/me/${type === "issue" ? "issues" : "meetings"}/${encodeURIComponent(id)}`, from) }).results} onSettled={home.settle} />
        <ActionNoticeCard id="progress" title="协作进展" mark="progress" notices={memberNoticeGroups(home.notifications, { ...home, openTask: (id, from) => api.navigate(`/me/tasks/${encodeURIComponent(id)}`, from), openAcceptance: (id, from) => api.navigate(`/me/tasks/${encodeURIComponent(id)}?accept=1`, from), openGroup: (type, id, from) => api.navigate(`/me/${type === "issue" ? "issues" : "meetings"}/${encodeURIComponent(id)}`, from) }).progress} onSettled={home.settle} />
        <ActionNoticeCard id="thread-unread" title="群聊新消息" mark="chat" notices={home.unreadThreads.map((item) => ({ id: `${item.objectType}:${item.objectId}`, title: `${item.objectType === "issue" ? "议题" : item.objectType === "meeting" ? "会议" : "执行事项"}「${item.title}」 · ${item.unread} 条新消息`, detail: "群聊", onOpen: (from: Element | null) => {
          window.dispatchEvent(new CustomEvent("open-thread-channel", { detail: { objectType: item.objectType, objectId: item.objectId } }));
          api.navigate(`${item.href}?channel=group`, from);
        }, buttons: [] })).concat(home.unreadMissionGroups.map((item) => ({ id: `mission-card:${item.cardId}`, title: `任务卡「${item.title}」 · ${item.unread} 条新消息`, detail: "群聊", onOpen: (from: Element | null) => {
          window.dispatchEvent(new CustomEvent("open-mission-group-channel", { detail: { cardId: item.cardId } }));
          api.navigate(`${item.href}?channel=group`, from);
        }, buttons: [] })))} onSettled={() => undefined} />
        <MemberRadarNotices signals={radarSignals} currentHref={currentHref} onNavigate={api.navigate} onRead={home.readRadarNotice} />
        {leadCount + (plan.plan?.unplaced.length ?? 0) + requests.items + records.meetings.length + records.confirms.length + records.minutes.length + home.rounds.length + home.meetings.length + feishuEvents.length + home.unreadThreads.length + home.unreadMissionGroups.length + quietNoticeCount(home.notifications) + radarSignals.length === 0 ? <p className={m.quiet}>暂时没有新通知</p> : null}
      </div>
      <div className={n.railFoot}>
        <AccountMenu account={account} onNavigate={api.navigate} />
      </div>
    </aside>
  );
}
