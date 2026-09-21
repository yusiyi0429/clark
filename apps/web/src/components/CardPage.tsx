"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Card } from "@/lib/api/client";
import { renderCard } from "@/cards/registry";
import { ConversationDock } from "@/conversation/ConversationDock";
import { clearOrigin, rememberOriginFromFocus, takeOrigin, playObjectEnter } from "@/lib/objectTransition";
import s from "@/styles/app-shell.module.css";

type Props = {
  initialCards: Card[];
  scope: string;
  label: string;
  /** workspace：对象材料铺满主区；feed：列表型页面由 Card 自己滚动。 */
  layout?: "workspace" | "feed";
  /** Meeting / Signal 阅读把同一 Conversation 嵌入右侧栏，其余对象继续使用底部 dock。 */
  conversationPlacement?: "dock" | "embedded";
};

/** 对象页外壳：主区只渲染 Card，底部是共享 Conversation dock。 */
export function CardPage({ initialCards, scope, label, layout = "workspace", conversationPlacement = "dock" }: Props) {
  const [cards, setCards] = useState(initialCards);
  const router = useRouter();

  const onCard = useCallback((updated: Card) => {
    setCards((current) => {
      const exists = current.some((card) => card.id === updated.id);
      return exists ? current.map((card) => (card.id === updated.id ? updated : card)) : [...current, updated];
    });
  }, []);

  const onNavigate = useCallback(
    (href: string) => {
      if (href.startsWith("/access")) window.location.assign(href);
      else {
        rememberOriginFromFocus();
        router.push(href);
      }
    },
    [router],
  );

  const primary = cards[0];
  const panel = useRef<HTMLDivElement>(null);

  // 对象页展开过渡：来源矩形由首页点击写入，直接打开 URL 时没有来源，只渲染终态。
  useLayoutEffect(() => {
    if (layout !== "workspace" || !panel.current) {
      clearOrigin();
      return;
    }
    playObjectEnter(panel.current, takeOrigin());
  }, [layout, primary?.id]);

  // Escape 退出当前对象/列表页；通知浮卡、对话记录层与监测范围会自行先处理（它们在 dialog 内）。
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (document.querySelector('dialog, [role="dialog"]')) return;
      router.push("/");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  if (!primary) return null;

  return (
    <div className={s.shell} data-testid="ceo-workspace" data-layout={layout}>
      <div className={s.mainArea}>
        {layout === "workspace" ? (
          <div className={s.expanded} data-testid="expanded-panel" ref={panel}>
            <div className={s.expandedScroll} data-card-kind={primary.kind}>{renderCard({ card: primary, collection: cards, onCard, onNavigate })}</div>
          </div>
        ) : (
          <div className={s.feedSurface} data-testid="expanded-panel">
            {renderCard({ card: primary, collection: cards, onCard, onNavigate })}
          </div>
        )}
      </div>
      {conversationPlacement === "dock" ? <ConversationDock scope={scope} label={label} availableCards={cards} /> : null}
    </div>
  );
}
