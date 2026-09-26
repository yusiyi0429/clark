"use client";

import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { AccountMenu } from "@/components/AccountMenu";
import { MorningCanvas } from "@/components/onboarding/MorningCanvas";
import { useHomeArrival } from "@/components/onboarding/useHomeArrival";
import { ActionNoticeCard } from "@/components/ActionNoticeCard";
import { HeroButton } from "@/components/HeroButton";
import { RailClock } from "@/components/NotificationRail";
import { ConversationHost, type ConversationUiState } from "@/conversation/ConversationHost";
import { logout } from "@/lib/logout";
import { MemberTasks } from "./MemberTasks";
import { memberNoticeGroups } from "./memberNotices";
import { useMemberHome } from "./useMemberHome";
// 与 CEO 工作面同样的主题层顺序（CeoWorkspace）：输入条与对话记录的字号、圆角以 ts-design 为准。
import "ts-design/styles.css";
import s from "@/styles/app-shell.module.css";
import n from "@/styles/notifications.module.css";
import m from "@/styles/member-home.module.css";

/**
 * 成员工作台（clark `/dri` 工作面的骨架）：左侧通知栏、主区是自己的事。
 * 主区是我的执行事项（会后分给我的事），通知栏里能直接接下或退回；首页底部是自己的 Agent（DRI Agent，全局对话）。
 * 发给我的信号在第 3 步接入。
 */
export function MemberWorkspace({ displayName, loginId }: { displayName: string; loginId?: string }) {
  const arriving = useHomeArrival();
  const [leaving, setLeaving] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const home = useMemberHome();
  const notices = memberNoticeGroups(home.notifications, home);
  const ui: ConversationUiState = {
    keyboard,
    setKeyboard,
    historyOpen,
    setHistoryOpen,
    globalView: false,
    setGlobalView: () => undefined,
    railMobileOpen: false,
    setRailMobileOpen: () => undefined,
    prefill: null,
    consumePrefill: () => undefined,
  };
  // Escape（C-06）：先收起对话记录，再退出键盘面。输入框里的 Escape 由输入条自己处理。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (historyOpen) setHistoryOpen(false);
      else if (keyboard) setKeyboard(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [historyOpen, keyboard]);

  return (
    <div className={s.shell} data-testid="member-workspace" data-arriving={arriving}>
      {arriving ? <div className={s.entryCarry} aria-hidden="true"><MorningCanvas /></div> : null}
      <div className={s.mainArea}>
        <div className={s.homeSurface}>
          <div className={m.board}>
            <section className={m.panel} aria-labelledby="member-title">
              <h1 id="member-title">{displayName}</h1>
              <p>发给你的信号、你推进和参与的执行事项，都会出现在这里。</p>
            </section>
            <MemberTasks tasks={home.tasks} busyId={home.busyId} error={home.taskError} onStatus={(task, status) => void home.setStatus(task, status)} />
          </div>
        </div>
      </div>
      <div className={s.notificationArea}>
        <aside className={n.rail} aria-label="通知">
          <RailClock
            homeActive
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
            <AccountMenu account={{ displayName, loginId, role: "member" }} />
          </div>
        </aside>
      </div>
      <ConversationHost page={null} detailOpen={false} agentTitle="DRI Agent" ui={ui} />
    </div>
  );
}
