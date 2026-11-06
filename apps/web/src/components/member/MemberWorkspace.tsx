"use client";

import { useState, type ReactNode } from "react";
import { AccountMenu, type Account } from "@/components/AccountMenu";
import { HeroButton } from "@/components/HeroButton";
import { type RequestCounts } from "@/components/requests/RequestNotices";
import { RequestListPanel } from "@/components/requests/RequestListScreen";
import { WorkspaceFrame } from "@/components/shell/WorkspaceFrame";
import { useWorkspace } from "@/components/shell/WorkspaceContext";
import { HomeActions } from "./home/HomeActions";
import { HomePlan } from "./home/HomePlan";
import { useHomePlan } from "./home/useHomePlan";
import { MemberNoticeRail } from "./MemberNoticeRail";
import { useMemberHome } from "./useMemberHome";
import m from "@/styles/member-home.module.css";

const NO_REQUESTS: RequestCounts = { items: 0, waitingReplies: 0 };

/** 成员首页保留在共享外壳内；Mission Card、战场与雷达详情都在同一个展开区打开。 */
export function MemberWorkspace({ displayName, loginId, viewerId = null, children }: { displayName: string; loginId?: string; viewerId?: string | null; children?: ReactNode }) {
  /** 首页「等回复 N」：跟着左栏请求、影响两组的轮询走。 */
  const [requests, setRequests] = useState(NO_REQUESTS);
  const home = useMemberHome();
  // 首页计划和通知栏的「待归位」用同一份。
  const plan = useHomePlan();
  const account = { personId: viewerId, displayName, loginId, role: "member" as const };
  return (
    <WorkspaceFrame homeHref="/me" viewerId={viewerId} account={account} agentTitle="我的对话"
      home={<MemberHomeBody displayName={displayName} home={home} plan={plan} account={account} waitingReplies={requests.waitingReplies} />}
      notifications={(api, currentHref) => <MemberNoticeRail api={api} currentHref={currentHref} home={home} plan={plan} account={account} onRequestCounts={setRequests} />}
    >{children}</WorkspaceFrame>
  );
}

/** 首页：顶行月历 · Mission · 快捷，下面 Mission 详情和最近进展；桌面上个人菜单在通知栏底部，这里的一份只在手机上显示。 */
function MemberHomeBody({ displayName, home, plan, account, waitingReplies }: { displayName: string; home: ReturnType<typeof useMemberHome>; plan: ReturnType<typeof useHomePlan>; account: Account; waitingReplies: number }) {
  const { navigate, bookMeeting } = useWorkspace();
  /** 等回复面板开着时记着按下的那颗键：面板里点进详情时从它展开，详情关了回到它。 */
  const [requestsFrom, setRequestsFrom] = useState<Element | null>(null);
  // 首页两份数据（工作台、计划）谁没连上都提示一次，重试两份都重取。
  const error = home.homeError ?? plan.error;
  return <div className={m.board}>
    <header className={m.heading}><h1>{displayName}</h1><span>我的工作台</span></header>
    {error ? <div className={m.error} role="alert"><span>{error}</span><HeroButton variant="ghost" size="sm" onPress={() => { void home.refresh(); void plan.refresh(); }}>重试</HeroButton></div> : null}
    <HomePlan plan={plan.plan} onNavigate={navigate}
      actions={<HomeActions waitingReplies={waitingReplies} radarUnread={home.radar ? home.radar.unreadCount : null} onBookMeeting={bookMeeting} onOpenRequests={setRequestsFrom} onNavigate={navigate} />} />
    <RequestListPanel open={requestsFrom !== null} onClose={() => setRequestsFrom(null)} base="/me/requests" onNavigate={(href) => navigate(href, requestsFrom)} />
    <div className={m.phoneAccount}><AccountMenu account={account} onNavigate={navigate} /></div>
  </div>;
}
