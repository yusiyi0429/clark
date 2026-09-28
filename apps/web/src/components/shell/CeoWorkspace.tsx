"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Card } from "@/lib/api/client";
import { replaceActionCard } from "@/lib/actionResponse";
import { CeoGlance } from "@/components/CeoGlance";
import { HomeBoard } from "@/components/HomeBoard";
import { NotificationRail } from "@/components/NotificationRail";
import { AccountMenu, type Account } from "@/components/AccountMenu";
import b from "@/styles/home-board.module.css";
import { useWorkspace } from "./WorkspaceContext";
import { WorkspaceFrame } from "./WorkspaceFrame";

/**
 * 首页主区。三屏以上是完整看板；手持（≤959：单屏、三折叠双屏）首页是一条滚动 —— 通知 → 精简的公司全局 → 个人菜单，
 * 两者用 CSS 按宽度切换（服务端渲染没有屏宽，不在 JS 里判断，免得手机上先闪一下大看板）。个人菜单在桌面随通知栏，这里的一份只在手持显示。
 */
function CeoHome({ cards, onCard, account }: { cards: Card[]; onCard: (card: Card) => void; account: Account }) {
  const { navigate } = useWorkspace();
  return <>
    <HomeBoard cards={cards} onCard={onCard} onNavigate={navigate} />
    <CeoGlance cards={cards} onNavigate={navigate} />
    <div className={b.phoneAccount}><AccountMenu account={account} onNavigate={navigate} /></div>
  </>;
}

/** CEO 的首页与通知常驻；开合、对话和焦点规则与成员使用同一个外壳。 */
export function CeoWorkspace({ initialCards, viewerId, account, children }: { initialCards: Card[]; viewerId: string; account: Account; children: ReactNode }) {
  const [cards, setCards] = useState(initialCards);
  useEffect(() => setCards(initialCards), [initialCards]);
  const onCard = useCallback((updated: Card) => setCards((current) => replaceActionCard(current, updated)), []);
  return (
    <WorkspaceFrame homeHref="/" viewerId={viewerId} account={account} homeCards={cards} agentTitle="我的 Agent"
      home={<CeoHome cards={cards} onCard={onCard} account={account} />}
      notifications={(api, pathname) => <NotificationRail cards={cards} onNavigate={api.navigate} onHome={() => api.navigate("/")} homeActive={!api.detailOpen} currentHref={api.detailOpen ? pathname : undefined} onCard={onCard} account={account} />}
    >{children}</WorkspaceFrame>
  );
}
