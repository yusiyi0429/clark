"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Card } from "@/lib/api/client";
import { HomeBoard } from "./HomeBoard";
import { NotificationRail } from "./NotificationRail";
import { ConversationDock } from "@/conversation/ConversationDock";
import { clearOrigin, rememberOriginFromFocus } from "@/lib/objectTransition";
import s from "@/styles/app-shell.module.css";

/** 首页外壳：左通知栏 + 右决策看板 + 底部全局 Conversation dock。 */
export function HomeShell({ initialCards }: { initialCards: Card[] }) {
  const [cards, setCards] = useState(initialCards);
  const router = useRouter();

  // 首页不是对象页：挂载即作废上一次点击留下的来源矩形。
  useEffect(() => clearOrigin(), []);

  const onCard = useCallback((updated: Card) => {
    setCards((current) => current.map((card) => (card.id === updated.id ? updated : card)));
  }, []);

  const onNavigate = useCallback(
    (href: string) => {
      rememberOriginFromFocus();
      router.push(href);
    },
    [router],
  );

  return (
    <div className={s.shell} data-testid="ceo-workspace">
      <div className={s.mainArea}>
        <div className={s.homeSurface}>
          <HomeBoard cards={cards} onCard={onCard} onNavigate={onNavigate} />
        </div>
      </div>
      <div className={s.notificationArea} data-testid="notification-only">
        <NotificationRail cards={cards} onNavigate={onNavigate} />
      </div>
      <ConversationDock scope="global" label="公司全局" availableCards={cards} />
    </div>
  );
}
