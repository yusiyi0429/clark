"use client";

import { useCallback, useState } from "react";
import type { Card } from "@/lib/api/client";
import type { ContextMarkKind } from "@/components/ContextMark";
import { renderCard } from "@/cards/registry";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import s from "@/styles/app-shell.module.css";

type Props = {
  initialCards: Card[];
  scope: string;
  label: string;
  /** 窄条上的当前工作区标记（会议 / 月度）。 */
  mark?: ContextMarkKind | null;
};

/** 自带页头与滚动区的对象页（clark 的议题 / 会议工作区、雷达展开页）：直接作为面板的子节点，不再套滚动容器。 */
const FRAMED = new Set(["issue", "meeting", "radar", "signal", "monthly-plan"]);

/** 对象页：在 CEO 工作面主区原地打开的一张 Card。关闭 / 切换走外壳的开合（C-01）。 */
export function DetailPanel({ initialCards, scope, label, mark = null }: Props) {
  const [cards, setCards] = useState(initialCards);
  const { navigate, close } = useWorkspace();

  const onCard = useCallback((updated: Card) => {
    setCards((current) => {
      const exists = current.some((card) => card.id === updated.id);
      return exists ? current.map((card) => (card.id === updated.id ? updated : card)) : [...current, updated];
    });
  }, []);
  // Card 里的「关闭 / 返回首页」回到打开它的工作面，其余链接在对象间切换。
  const onNavigate = useCallback(
    (href: string, origin?: Element | null) => (href === "/" ? close() : navigate(href, origin)),
    [close, navigate],
  );

  useRegisterDetail({ scope, label, mark, cards });

  const primary = cards[0];
  if (!primary) return null;
  const content = renderCard({ card: primary, collection: cards, onCard, onNavigate });
  return FRAMED.has(primary.kind) ? (
    content
  ) : (
    <div className={s.expandedScroll} data-card-kind={primary.kind}>
      {content}
    </div>
  );
}
