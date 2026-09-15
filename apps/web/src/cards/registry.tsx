import type { ReactElement } from "react";
import type { Card } from "@/lib/api/client";
import { HomeCard } from "./HomeCard";
import { IssueCard } from "./IssueCard";

// Web 侧 kind → renderer 显式 registry；与 API 侧 schema registry 对应（.tech/01 §8）。
const registry: Record<string, (card: Card) => ReactElement> = {
  home: (card) => <HomeCard card={card} />,
  issue: (card) => <IssueCard card={card} />,
};

export function renderCard(card: Card): ReactElement | null {
  const renderer = registry[card.kind];
  return renderer ? renderer(card) : null;
}
