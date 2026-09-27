"use client";

import { useState, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { AccountMenu, type Account } from "@/components/AccountMenu";
import { ActionNoticeCard } from "@/components/ActionNoticeCard";
import { HeroButton } from "@/components/HeroButton";
import { RailClock } from "@/components/NotificationRail";
import { MissionCardNoticeGroup } from "@/components/missionCards/MissionCardNoticeGroup";
import { WorkspaceFrame } from "@/components/shell/WorkspaceFrame";
import { useWorkspace } from "@/components/shell/WorkspaceContext";
import { logout } from "@/lib/logout";
import { MemberTasks } from "./MemberTasks";
import { MemberHomeWidgets } from "./MemberHomeWidgets";
import { MemberRadarWidget } from "./MemberRadarWidget";
import { MemberRadarNotices, noteworthySignals } from "./MemberRadarNotices";
import { memberNoticeGroups } from "./memberNotices";
import { useMemberHome } from "./useMemberHome";
import n from "@/styles/notifications.module.css";
import m from "@/styles/member-home.module.css";

/** 成员首页保留在共享外壳内；Mission Card、战场与雷达详情都在同一个展开区打开。 */
export function MemberWorkspace({ displayName, loginId, viewerId = null, children }: { displayName: string; loginId?: string; viewerId?: string | null; children?: ReactNode }) {
  const [leaving, setLeaving] = useState(false);
  const home = useMemberHome();
  const radarSignals = noteworthySignals(home.radar);
  const account = { displayName, loginId, role: "member" as const };
  return (
    <WorkspaceFrame homeHref="/me" viewerId={viewerId} account={account} agentTitle="DRI Agent"
      home={<MemberHomeBody displayName={displayName} home={home} account={account} />}
      notifications={(api, currentHref) => (
        <aside className={`${n.rail} ${m.memberRail}`} aria-label="通知">
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
          <div className={`${n.noticeList} ${m.memberNotices}`}>
            {home.rounds.map((round) => <MissionCardNoticeGroup key={round.roundId} round={round} entry="member" currentHref={currentHref} onNavigate={api.navigate} onRefresh={home.refresh} />)}
            <ActionNoticeCard id="assigned" title="新的执行事项" subtitle="会后分派与协作邀请" mark="meeting" notices={memberNoticeGroups(home.notifications, { ...home, openTask: (id, from) => api.navigate(`/me/tasks/${encodeURIComponent(id)}`, from) }).assigned} onSettled={home.settle} />
            <ActionNoticeCard id="results" title="回复与结果" mark="issue" notices={memberNoticeGroups(home.notifications, home).results} onSettled={home.settle} />
            <MemberRadarNotices signals={radarSignals} currentHref={currentHref} onNavigate={api.navigate} onRead={home.readRadarNotice} />
            {home.rounds.length + home.notifications.filter((item) => !item.readAt).length + radarSignals.length === 0 ? <p className={m.quiet}>暂时没有新通知</p> : null}
          </div>
          <div className={`${n.railFoot} ${m.memberAccount}`}>
            <AccountMenu account={account} onNavigate={api.navigate} />
          </div>
        </aside>
      )}
    >{children}</WorkspaceFrame>
  );
}

/** 手机上按「先看新的、再推手上的、最后看全局」排（member-home.module.css）；桌面上个人菜单在通知栏底部，这里的一份只在手机上显示。 */
function MemberHomeBody({ displayName, home, account }: { displayName: string; home: ReturnType<typeof useMemberHome>; account: Account }) {
  const { navigate } = useWorkspace();
  return <div className={m.board}>
    <header className={m.heading}><h1>{displayName}</h1><span>我的工作台</span></header>
    {home.homeError ? <div className={m.error} role="alert"><span>{home.homeError}</span><HeroButton variant="ghost" size="sm" onPress={() => void home.refresh()}>重试</HeroButton></div> : null}
    {home.work || !home.homeError ? <div className={m.widgetsSlot}><MemberHomeWidgets work={home.work} onNavigate={navigate} onRefresh={home.refresh}
      radar={home.radar ? <MemberRadarWidget radar={home.radar} onNavigate={navigate} /> : undefined} /></div> : null}
    <MemberTasks tasks={home.tasks} busyId={home.busyId} error={home.taskError === home.homeError ? null : home.taskError} onStatus={(task, status) => void home.setStatus(task, status)} onNavigate={navigate} />
    <div className={m.phoneAccount}><AccountMenu account={account} onNavigate={navigate} /></div>
  </div>;
}
