"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { RailClock } from "@/components/NotificationRail";
import { logout } from "@/lib/logout";
import s from "@/styles/app-shell.module.css";
import n from "@/styles/notifications.module.css";
import m from "@/styles/member-home.module.css";

/**
 * 成员工作台（clark `/dri` 工作面的骨架）：左侧通知栏、主区是自己的事。
 * 第 1 步只有身份与退出；通知、发给我的信号与执行事项在后续步骤接入。
 */
export function MemberWorkspace({ displayName }: { displayName: string }) {
  const [leaving, setLeaving] = useState(false);

  return (
    <div className={s.shell} data-testid="member-workspace">
      <div className={s.mainArea}>
        <div className={s.homeSurface}>
          <div className={m.board}>
            <section className={m.panel} aria-labelledby="member-title">
              <h1 id="member-title">{displayName}</h1>
              <p>发给你的信号、你推进和参与的执行事项，都会出现在这里。</p>
            </section>
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
            <p className={m.quiet}>暂时没有新通知</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
