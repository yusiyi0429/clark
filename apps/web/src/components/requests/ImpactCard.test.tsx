import { describe, expect, it, vi } from "vitest";
import type { TImpactCardView } from "@warmap/contracts";
import { ImpactQuote } from "./ImpactCard";

type Node = { type?: unknown; props?: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  const node = value as Node;
  return node.props ? [node, ...nodes(node.props.children)] : [];
}

const source = (turnId: string | null): TImpactCardView["sources"][number] =>
  ({ meetingId: "m1", meetingTitle: "接口切换会", turnId, speakerName: "测试乙", quote: "接口统一改成 v2", at: "2026-06-01T02:00:00.000Z" });

describe("影响卡原话", () => {
  it("影响卡的原话能点", () => {
    const onNavigate = vi.fn();
    const tree = ImpactQuote({ source: source("t42"), base: "/me/requests", onNavigate });
    const link = nodes(tree).find((node) => node.type === "a")!;
    expect(link.props!.href).toBe("/me/meetings/m1?meetingAction=transcript&turn=t42");
    const event = { preventDefault: vi.fn(), currentTarget: {} };
    (link.props!.onClick as (event: unknown) => void)(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith("/me/meetings/m1?meetingAction=transcript&turn=t42", event.currentTarget);
    // CEO 那边走 /meetings。
    expect(nodes(ImpactQuote({ source: source("t42"), base: "/requests", onNavigate })).find((node) => node.type === "a")!.props!.href)
      .toBe("/meetings/m1?meetingAction=transcript&turn=t42");
  });

  it("没有发言段的原话只是文字", () => {
    expect(nodes(ImpactQuote({ source: source(null), base: "/me/requests", onNavigate: vi.fn() })).some((node) => node.type === "a")).toBe(false);
  });
});
