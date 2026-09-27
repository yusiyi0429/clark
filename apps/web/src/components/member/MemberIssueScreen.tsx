"use client";

import type { Card } from "@/lib/api/client";
import { IssueCard } from "@/cards/IssueCard";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";

export function MemberIssueScreen({ card }: { card: Card }) {
  const workspace = useWorkspace();
  useRegisterDetail({ scope: `issue:${card.objectRef.id}`, label: card.title, mark: null, cards: [card],
    group: { kind: "thread", objectType: "issue", objectId: card.objectRef.id, viewerId: workspace.viewerId ?? "", members: [] } });
  return <IssueCard card={card} collection={[card]} readOnly onCard={() => undefined}
    onNavigate={(href, origin) => href === "/" ? workspace.close() : workspace.navigate(href, origin)} />;
}
