import { describe, expect, it } from "vitest";
import type { ProjectFeedItem } from "@/lib/home/types";
import { conversationFeed } from "./Conversations";

const at = "2026-11-16T06:00:00Z";
const item = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, id: kind, at, ...extra }) as unknown as ProjectFeedItem;

describe("项目对话只留对话本身（本人 11/16 定 A）", () => {
  it("留：转交那几行、还没答的「Task 改了」、子会话还开着的问和批准、约定都达到；其余不进对话", () => {
    const feed = [
      item("goal_linked"), item("handover"), item("handover_summary"), item("transfer_declined"),
      item("goal_changed", { id: "open", answer: null }), item("goal_changed", { id: "done", answer: "keep" }),
      item("sub_session_report"), item("sub_session_decision"), item("meeting_handoff"),
      item("card_passed"), item("card_blocked"), item("card_needs_person"), item("criteria_met"), item("rework_opened"),
    ];
    expect(conversationFeed(feed).map((entry) => `${entry.kind}${entry.kind === "goal_changed" ? `:${entry.id}` : ""}`)).toEqual([
      "handover", "handover_summary", "transfer_declined", "goal_changed:open", "sub_session_decision", "criteria_met",
    ]);
  });
});
