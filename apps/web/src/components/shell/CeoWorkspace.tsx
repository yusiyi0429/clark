"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Card } from "@/lib/api/client";
import { replaceActionCard } from "@/lib/actionResponse";
import { HomeBoard } from "@/components/HomeBoard";
import { NotificationRail } from "@/components/NotificationRail";
import type { Account } from "@/components/AccountMenu";
import { useWorkspace } from "./WorkspaceContext";
import { WorkspaceFrame } from "./WorkspaceFrame";

function CeoHome({ cards, onCard }: { cards: Card[]; onCard: (card: Card) => void }) {
  const { navigate } = useWorkspace();
  return <HomeBoard cards={cards} onCard={onCard} onNavigate={navigate} />;
}

/** CEO 的首页与通知常驻；开合、对话和焦点规则与成员使用同一个外壳。 */
export function CeoWorkspace({ initialCards, viewerId, account, children }: { initialCards: Card[]; viewerId: string; account: Account; children: ReactNode }) {
  const [cards, setCards] = useState(initialCards);
  useEffect(() => setCards(initialCards), [initialCards]);
  const onCard = useCallback((updated: Card) => setCards((current) => replaceActionCard(current, updated)), []);
  return (
    <WorkspaceFrame homeHref="/" viewerId={viewerId} account={account} homeCards={cards} agentTitle="CEO Agent"
      home={<CeoHome cards={cards} onCard={onCard} />}
      notifications={(api, pathname) => <NotificationRail cards={cards} onNavigate={api.navigate} onHome={() => api.navigate("/")} homeActive={!api.detailOpen} currentHref={api.detailOpen ? pathname : undefined} onCard={onCard} account={account} />}
    >{children}</WorkspaceFrame>
  );
}
