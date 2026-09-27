"use client";

import type { ReactElement } from "react";
import type { Card } from "@/lib/api/client";
import { BattlefieldCard } from "./BattlefieldCard";
import { IssueCard } from "./IssueCard";
import { MeetingCard } from "./MeetingCard";
import { MonthlyPlanCard } from "./MonthlyPlanCard";
import { RadarCard } from "./RadarCard";
import { SignalCard } from "./SignalCard";

export type CardRenderProps = {
  card: Card;
  /** 同一页面上一起加载的 Card：Radar 视图需要 Signal 列表，Meeting 需要候选 Issue。 */
  collection: Card[];
  onCard: (card: Card) => void;
  /** origin：触发的来源元素，用于卡片 ⇄ 工作区转场。 */
  onNavigate: (href: string, origin?: Element | null) => void;
};

/** kind → 固定 renderer。新增 kind 必须同时在这里和后端 projector 注册。 */
export const CARD_RENDERERS: Record<string, (props: CardRenderProps) => ReactElement> = {
  issue: (props) => <IssueCard {...props} />,
  battlefield: (props) => <BattlefieldCard {...props} />,
  radar: (props) => <RadarCard {...props} />,
  signal: (props) => <SignalCard {...props} />,
  meeting: (props) => <MeetingCard {...props} />,
  "monthly-plan": (props) => <MonthlyPlanCard {...props} />,
};

export function UnsupportedCard() {
  return (
    <section role="alert" data-testid="unsupported-card" className="unsupported-card">
      <p>这项内容暂时无法显示，请刷新页面</p>
    </section>
  );
}

export function renderCard(props: CardRenderProps): ReactElement {
  const renderer = CARD_RENDERERS[props.card.kind];
  if (!renderer) {
    console.error(`Unsupported Card kind: ${props.card.kind}`);
    return <UnsupportedCard />;
  }
  return renderer(props);
}
