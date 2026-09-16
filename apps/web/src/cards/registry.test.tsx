import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { CARD_RENDERERS, renderCard, UnsupportedCard } from "./registry";

function card(kind: string): Card {
  return {
    schemaVersion: 1,
    id: `${kind}:1`,
    version: 1,
    kind,
    objectRef: { type: kind, id: "1", version: 1 },
    title: "对象",
    payload: {},
    actions: [],
  };
}

describe("Card renderer registry", () => {
  it("has a fixed renderer for every supported kind", () => {
    expect(Object.keys(CARD_RENDERERS).sort()).toEqual([
      "battlefield",
      "issue",
      "meeting",
      "monthly-plan",
      "radar",
      "signal",
    ]);
  });

  it("fails loudly on an unknown kind instead of rendering nothing", () => {
    const props = { card: card("mystery"), collection: [], onCard: () => undefined, onNavigate: () => undefined };
    const element = renderCard(props);
    expect(element.type).toBe(UnsupportedCard);
    const html = renderToStaticMarkup(element);
    expect(html).toContain('role="alert"');
    expect(html).toContain("mystery");
  });
});
