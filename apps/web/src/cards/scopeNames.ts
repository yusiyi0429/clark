import type { Card } from "@/lib/api/client";
import { payloadOf, type BattlefieldPayload, type CapabilityPayload, type IssuePayload } from "./payloads";

/** 战场 / 能力的显示名：从首页已载入的注册表 Card 里找；找不到返回 undefined，调用方只写层级，不打印原始 id。 */
export function registryName(cards: Card[], kind: "battlefield" | "capability", id: string | undefined): string | undefined {
  if (!id) return undefined;
  return cards.find(
    (card) =>
      card.kind === kind &&
      (kind === "battlefield" ? payloadOf<BattlefieldPayload>(card).battlefieldId : payloadOf<CapabilityPayload>(card).capabilityId) === id,
  )?.title;
}

/** 议题所在位置的显示名。 */
export function issueScopeLabel(location: IssuePayload["location"], cards: Card[]): string {
  if (location.level === "battlefield") return registryName(cards, "battlefield", location.battlefieldId) ?? "战场";
  if (location.level === "capability") return registryName(cards, "capability", location.capabilityId) ?? "公司能力";
  return "公司战略";
}
