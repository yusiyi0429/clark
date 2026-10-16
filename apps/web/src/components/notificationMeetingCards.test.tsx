import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { NotificationRail } from "./NotificationRail";
import { WorkspaceSchematic } from "./onboarding/WorkspaceSchematic";

function card(kind: string, id: string, title: string, payload: unknown, extra: Partial<Card> = {}): Card {
  return { schemaVersion: 1, id: `${kind}:${id}`, version: 1, kind, objectRef: { type: kind, id, version: 1 }, title, payload, actions: [], ...extra } as unknown as Card;
}

const preflight = (overrides: object = {}) => ({ status: "pending", pendingSince: null, runId: null, entries: [], basis: "", brief: "", error: null, generatedAt: null, ...overrides });

// 2026-10-10 是周六；10:00–10:45（公司时区）。
const meeting = (id: string, overrides: object = {}, extra: Partial<Card> = {}) =>
  card("meeting", id, `会议 ${id}`, {
    status: "scheduled", scheduledAt: "2026-10-10T02:00:00Z", endsAt: "2026-10-10T02:45:00Z", endedAt: null, hasEnded: false,
    leadDriId: "bai", ceoParticipantId: "liu",
    participants: [{ personId: "bai", displayName: "白田田" }, { personId: "liu", displayName: "刘明华" }],
    issueIds: ["i1", "i2"], preflight: preflight(), outcome: null, ...overrides,
  }, extra);

describe("非演示模式保持原样", () => {
  it("没有深色会议卡，会议仍在「战略会议安排」分组里", () => {
    const html = renderToStaticMarkup(<NotificationRail cards={[meeting("m1", { scheduledAt: "2026-10-10T08:00:00Z", endsAt: "2099-10-10T09:00:00Z" })]} onNavigate={() => undefined} />);
    expect(html).toContain("战略会议安排");
    expect(html).not.toContain('data-notice="meeting:');
    expect(renderToStaticMarkup(<WorkspaceSchematic role="ceo" focus="notifications" />)).toContain("战略会议安排");
  });
});
