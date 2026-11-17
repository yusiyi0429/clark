import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { ProjectFeedItem, SubSession } from "@/lib/home/types";
import type { Worker } from "@/lib/work/workers";
import type { CardItem } from "@/lib/board/cards";
import { conversationFeed, startedThreads } from "./Conversations";

const at = "2026-11-16T06:00:00Z";
const item = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, id: kind, at, ...extra }) as unknown as ProjectFeedItem;

describe("项目对话里留哪些项目动态", () => {
  it("留：转交那几行、还没答的「Task 改了」、子会话还开着的问和批准、约定都达到，和要你出手的受阻、等你补、等合回、停下有原因的；其余不进对话", () => {
    const feed = [
      item("goal_linked"), item("handover"), item("handover_summary"), item("transfer_declined"),
      item("goal_changed", { id: "open", answer: null }), item("goal_changed", { id: "done", answer: "keep" }),
      item("sub_session_report", { id: "report-done", sub: { id: "s1" }, why: "turn_done", blocker: null }),
      item("sub_session_report", { id: "report-held", sub: { id: "s2" }, why: "held", blocker: "额度用完了" }),
      item("sub_session_report", { id: "report-error", sub: { id: "s3" }, why: "error", blocker: null }),
      item("sub_session_decision"), item("meeting_handoff"),
      item("card_passed", { id: "passed-merged", cardId: "c1", merge: { state: "merged" } }),
      item("card_passed", { id: "passed-merge", cardId: "c2", merge: { state: "needs_merge" } }),
      item("card_blocked", { cardId: "c3" }), item("card_needs_person", { cardId: "c4" }), item("criteria_met"), item("rework_opened", { cardId: "c5" }),
    ];
    expect(conversationFeed(feed).map((entry) => entry.id)).toEqual([
      "handover", "handover_summary", "transfer_declined", "open", "report-held", "report-error", "sub_session_decision", "passed-merge", "card_blocked", "card_needs_person", "criteria_met",
    ]);
  });
});

describe("开了工的计划（设计 6.6）", () => {
  const sub = (id: string, title: string, kind: "card" | "topic" = "card") => ({
    id, kind, letter: null, title, state: "running", unseen: false, waiting: null, queueReason: null, holdUntil: null, role: null,
    sessionId: null, deviceId: null, autoStart: false, updatedAt: "2026-11-17T01:00:00.000Z", merge: null,
  }) as unknown as SubSession;
  const card = (id: string, createdAt: string) => ({ id, createdAt }) as unknown as CardItem;
  const worker = (id: string, createdAt: string) => ({ key: `card:${id}`, kind: "card", cardId: id, item: card(id, createdAt) }) as unknown as Worker;

  it("开了工的计划在开工的位置挂小条", () => {
    const subs = [sub("c2", "换头像"), sub("c1", "改首页"), sub("t1", "调研", "topic"), sub("x9", "别的计划的卡")];
    const block = startedThreads({ key: "t1", workers: [worker("c2", "2026-11-17T01:02:00Z")], cards: [card("c1", "2026-11-17T01:01:00Z"), card("c2", "2026-11-17T01:02:00Z")],
      subs, anchor: 7, onOpen: vi.fn() });
    // 插在开工那一下的位置（plan.startedAfterSequence），一个子会话一条小条，按派活单的先后；只这份计划的卡。
    expect(block).toMatchObject({ key: "started:t1", afterSequence: 7, at: "2026-11-17T01:01:00Z" });
    const html = renderToStaticMarkup(block!.node as ReactElement);
    expect(html.match(/data-testid="thread-chip"/g)).toHaveLength(2);
    expect(html).toMatch(/改首页.*换头像/);
    expect(html).not.toContain("调研");
    expect(html).not.toContain("别的计划的卡");
    // 还没开工（这份计划没有卡）的不挂。
    expect(startedThreads({ key: "t1", workers: [], cards: [], subs, anchor: null, onOpen: vi.fn() })).toBeNull();
  });
});
