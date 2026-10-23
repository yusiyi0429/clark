"use client";

import { useState, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { AccountMenu, type Account } from "@/components/AccountMenu";
import { ActionNoticeCard } from "@/components/ActionNoticeCard";
import { CycleCountdown } from "@/components/CycleCountdown";
import { HeroButton } from "@/components/HeroButton";
import { RailClock } from "@/components/NotificationRail";
import { MissionCardNoticeGroup } from "@/components/missionCards/MissionCardNoticeGroup";
import { MonthlyReviewNotices } from "@/components/monthlyReview/MonthlyReviewNotices";
import { PersonalReviewBoard } from "@/components/monthlyReview/PersonalReviewBoard";
import { useWeeklyReviewBoard, WeeklyReviewBoard } from "@/components/weeklyReview/WeeklyReviewBoard";
import { RequestNotices, type RequestCounts } from "@/components/requests/RequestNotices";
import { RequestListPanel } from "@/components/requests/RequestListScreen";
import { MeetingCardNoticeList, useMyMeetingCards } from "@/components/meeting/MeetingCardNotices";
import { WorkspaceFrame } from "@/components/shell/WorkspaceFrame";
import { useWorkspace } from "@/components/shell/WorkspaceContext";
import { logout } from "@/lib/logout";
import { HomeActions } from "./home/HomeActions";
import { HomePlan } from "./home/HomePlan";
import { useHomePlan } from "./home/useHomePlan";
import { MemberRadarNotices, noteworthySignals } from "./MemberRadarNotices";
import { MemberMeetingSchedule } from "./MemberMeetingSchedule";
import { memberNoticeGroups, quietNoticeCount } from "./memberNotices";
import { useMemberHome } from "./useMemberHome";
import { weeklySyncNotices } from "./weeklySyncNotice";
import n from "@/styles/notifications.module.css";
import m from "@/styles/member-home.module.css";

const NO_REQUESTS: RequestCounts = { items: 0, waitingReplies: 0 };

/** 成员首页保留在共享外壳内；Mission Card、战场与雷达详情都在同一个展开区打开。 */
export function MemberWorkspace({ displayName, loginId, viewerId = null, children }: { displayName: string; loginId?: string; viewerId?: string | null; children?: ReactNode }) {
  const [leaving, setLeaving] = useState(false);
  /** 左栏请求、影响两组的条数（算进空通知提示）和首页「等回复 N」：跟着那两组的轮询走。 */
  const [requests, setRequests] = useState(NO_REQUESTS);
  const home = useMemberHome();
  const weeklyReviews = useWeeklyReviewBoard();
  const meetingCards = useMyMeetingCards();
  const radarSignals = noteworthySignals(home.radar);
  const account = { displayName, loginId, role: "member" as const };
  return (
    <WorkspaceFrame homeHref="/me" viewerId={viewerId} account={account} agentTitle="我的对话"
      home={<MemberHomeBody displayName={displayName} home={home} account={account} waitingReplies={requests.waitingReplies} />}
      notifications={(api, currentHref) => (
        <aside className={n.rail} aria-label="通知">
          <RailClock
            homeActive={!api.detailOpen}
            onHome={() => api.navigate("/me")}
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
            <CycleCountdown />
            <MeetingCardNoticeList meetings={meetingCards} meetingBase="/me/meetings" onNavigate={api.navigate} />
            <ActionNoticeCard id="weekly-sync" title="每周同步" subtitle="把本周进展写进天枢" mark="meeting" notices={weeklySyncNotices(home.weeklySync)} onSettled={() => undefined} />
            <MemberMeetingSchedule meetings={home.meetings} onNavigate={api.navigate} />
            <WeeklyReviewBoard onNavigate={api.navigate} state={weeklyReviews} />
            <PersonalReviewBoard onNavigate={api.navigate} />
            <RequestNotices base="/me/requests" currentHref={currentHref} onNavigate={api.navigate} header={false} onCounts={setRequests} />
            <MonthlyReviewNotices onNavigate={api.navigate} />
            {home.rounds.map((round) => <MissionCardNoticeGroup key={round.roundId} round={round} entry="member" currentHref={currentHref} onNavigate={api.navigate} onRefresh={home.refresh} />)}
            <ActionNoticeCard id="assigned" title="分给你的事与邀请" subtitle="会后分派与协作邀请" mark="meeting" notices={memberNoticeGroups(home.notifications, { ...home, openTask: (id, from) => api.navigate(`/me/tasks/${encodeURIComponent(id)}`, from), openGroup: (type, id, from) => api.navigate(`/me/${type === "issue" ? "issues" : "meetings"}/${encodeURIComponent(id)}`, from) }).assigned} onSettled={home.settle} />
            <ActionNoticeCard id="results" title="回复与结果" mark="issue" notices={memberNoticeGroups(home.notifications, { ...home, openTask: (id, from) => api.navigate(`/me/tasks/${encodeURIComponent(id)}`, from), openAcceptance: (id, from) => api.navigate(`/me/tasks/${encodeURIComponent(id)}?accept=1`, from), openGroup: (type, id, from) => api.navigate(`/me/${type === "issue" ? "issues" : "meetings"}/${encodeURIComponent(id)}`, from) }).results} onSettled={home.settle} />
            <ActionNoticeCard id="thread-unread" title="群聊新消息" mark="issue" notices={home.unreadThreads.map((item) => ({ id: `${item.objectType}:${item.objectId}`, title: `${item.objectType === "issue" ? "议题" : item.objectType === "meeting" ? "会议" : "执行事项"}「${item.title}」 · ${item.unread} 条新消息`, detail: "群聊", onOpen: (from: Element | null) => {
              window.dispatchEvent(new CustomEvent("open-thread-channel", { detail: { objectType: item.objectType, objectId: item.objectId } }));
              api.navigate(`${item.href}?channel=group`, from);
            }, buttons: [] })).concat(home.unreadMissionGroups.map((item) => ({ id: `mission-card:${item.cardId}`, title: `任务卡「${item.title}」 · ${item.unread} 条新消息`, detail: "群聊", onOpen: (from: Element | null) => {
              window.dispatchEvent(new CustomEvent("open-mission-group-channel", { detail: { cardId: item.cardId } }));
              api.navigate(`${item.href}?channel=group`, from);
            }, buttons: [] })))} onSettled={() => undefined} />
            <MemberRadarNotices signals={radarSignals} currentHref={currentHref} onNavigate={api.navigate} onRead={home.readRadarNotice} />
            {requests.items + meetingCards.length + home.rounds.length + home.meetings.length + home.unreadThreads.length + home.unreadMissionGroups.length + quietNoticeCount(home.notifications) + radarSignals.length + (home.weeklySync ? 1 : 0) + (weeklyReviews.board?.rows.length ?? 0) === 0 ? <p className={m.quiet}>暂时没有新通知</p> : null}
          </div>
          <div className={n.railFoot}>
            <AccountMenu account={account} onNavigate={api.navigate} />
          </div>
        </aside>
      )}
    >{children}</WorkspaceFrame>
  );
}

/** 首页：顶行月历 · Mission · 快捷，下面 Mission 详情和最近进展；桌面上个人菜单在通知栏底部，这里的一份只在手机上显示。 */
function MemberHomeBody({ displayName, home, account, waitingReplies }: { displayName: string; home: ReturnType<typeof useMemberHome>; account: Account; waitingReplies: number }) {
  const { navigate, bookMeeting, m2Available = false } = useWorkspace();
  const plan = useHomePlan();
  /** 等回复面板开着时记着按下的那颗键：面板里点进详情时从它展开，详情关了回到它。 */
  const [requestsFrom, setRequestsFrom] = useState<Element | null>(null);
  // 首页两份数据（工作台、计划）谁没连上都提示一次，重试两份都重取。
  const error = home.homeError ?? plan.error;
  return <div className={m.board}>
    <header className={m.heading}><h1>{displayName}</h1><span>我的工作台</span></header>
    {error ? <div className={m.error} role="alert"><span>{error}</span><HeroButton variant="ghost" size="sm" onPress={() => { void home.refresh(); void plan.refresh(); }}>重试</HeroButton></div> : null}
    <HomePlan plan={plan.plan} onNavigate={navigate}
      actions={<HomeActions waitingReplies={waitingReplies} radarUnread={home.radar ? home.radar.unreadCount : null} today={plan.plan?.today ?? null} m2Available={m2Available} onBookMeeting={bookMeeting} onOpenRequests={setRequestsFrom} onNavigate={navigate} />} />
    <RequestListPanel open={requestsFrom !== null} onClose={() => setRequestsFrom(null)} base="/me/requests" onNavigate={(href) => navigate(href, requestsFrom)} />
    <div className={m.phoneAccount}><AccountMenu account={account} onNavigate={navigate} /></div>
  </div>;
}
