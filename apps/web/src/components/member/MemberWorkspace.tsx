"use client";

import { useState, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { AccountMenu } from "@/components/AccountMenu";
import { ActionNoticeCard } from "@/components/ActionNoticeCard";
import { HeroButton } from "@/components/HeroButton";
import { RailClock } from "@/components/NotificationRail";
import { WorkspaceFrame } from "@/components/shell/WorkspaceFrame";
import { logout } from "@/lib/logout";
import { MemberTasks } from "./MemberTasks";
import { memberNoticeGroups } from "./memberNotices";
import { useMemberHome } from "./useMemberHome";
import n from "@/styles/notifications.module.css";
import m from "@/styles/member-home.module.css";

/** 成员首页保留在共享外壳内；Mission Card、战场与雷达详情都在同一个展开区打开。 */
export function MemberWorkspace({ displayName, loginId, viewerId = null, children }: { displayName: string; loginId?: string; viewerId?: string | null; children?: ReactNode }) {
  const [leaving, setLeaving] = useState(false);
  const home = useMemberHome();
  const notices = memberNoticeGroups(home.notifications, home);
  const account = { displayName, loginId, role: "member" as const };
  return (
    <WorkspaceFrame homeHref="/me" viewerId={viewerId} account={account} agentTitle="DRI Agent"
      home={
        <div className={m.board}>
          <section className={m.panel} aria-labelledby="member-title">
            <h1 id="member-title">{displayName}</h1>
            <p>发给你的信号、你推进和参与的执行事项，都会出现在这里。</p>
          </section>
          <MemberTasks tasks={home.tasks} busyId={home.busyId} error={home.taskError} onStatus={(task, status) => void home.setStatus(task, status)} />
        </div>
      }
      notifications={(api) => (
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
            <ActionNoticeCard id="assigned" title="新的执行事项" subtitle="会后分给你的事" mark="meeting" notices={notices.assigned} onSettled={home.settle} />
            <ActionNoticeCard id="results" title="回复与结果" mark="issue" notices={notices.results} onSettled={home.settle} />
            {notices.assigned.length + notices.results.length === 0 ? <p className={m.quiet}>暂时没有新通知</p> : null}
          </div>
          <div className={n.railFoot}>
            <AccountMenu account={account} onNavigate={api.navigate} />
          </div>
        </aside>
      )}
    >{children}</WorkspaceFrame>
  );
}
