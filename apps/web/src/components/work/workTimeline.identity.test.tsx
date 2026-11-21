import { describe, expect, it, vi } from "vitest";
import { Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import type { ConversationData, Message } from "@/conversation/useConversation";

// There is no installed DOM/test reconciler. Keep the actual element builders and
// inspect every array/element boundary rather than flattening away React parents.
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useMemo: (compute: () => unknown) => compute() }));
import { ConversationTurn, ConversationTurns } from "@/conversation/Transcript";
import { WorkTimeline, type TimedBlock } from "./WorkTimeline";
import { BubbleContext } from "@/conversation/ReplyBubbles";

type Element = ReactElement<Record<string, unknown>>;
type Located = { path: string[]; element: Element };
function locate(value: ReactNode, found: Located[] = [], path: string[] = []): Located[] {
  if (Array.isArray(value)) {
    value.forEach((child, index) => locate(child, found, [...path, `array:${isValidElement(child) && child.key !== null ? child.key : index}`]));
  } else if (isValidElement<Record<string, unknown>>(value)) {
    const label = value.type === Fragment ? "Fragment" : typeof value.type === "string" ? value.type
      : typeof value.type === "function" ? value.type.name : "Provider";
    const next = [...path, `${label}:${value.key ?? ""}`];
    if (value.type === ConversationTurns) {
      locate(ConversationTurns(value.props as Parameters<typeof ConversationTurns>[0]), found, next);
    } else {
      found.push({ path: next, element: value });
      locate(value.props.children as ReactNode, found, next);
    }
  }
  return found;
}
const data = (messages: Message[], extra: Partial<ConversationData> = {}) => ({
  scope: "global", messages, partial: "", streaming: false, thinking: false, stage: "answering", startedAt: 0, steps: [], send: vi.fn(), rescope: vi.fn(), ...extra,
}) as unknown as ConversationData;
const message = (sequence: number, createdAt?: string): Message => ({ sequence, role: "user", content: `message-${sequence}`, ...(createdAt ? { createdAt } : {}) });
const HandoffPicker = () => <textarea defaultValue="keep this instruction" />;
const handoff: TimedBlock = { key: "meeting-handoff:confirmation-1", at: "2026-11-13T09:30:00Z", node: <HandoffPicker /> };
const meeting: TimedBlock = { key: "partner-meeting:meeting-1", at: "2026-11-13T17:00:00+08:00", node: <details open><summary>record</summary></details> };
const rendered = (messages: Message[], blocks = [handoff, meeting], extra: Partial<ConversationData> = {}) => locate(WorkTimeline({ data: data(messages, extra), blocks }));
const block = (tree: Located[], key = handoff.key) => tree.find(({ element }) => element.props["data-block"] === key)!;
const order = (tree: Located[]) => tree.flatMap(({ element }) => element.props["data-block"] ? [element.props["data-block"]]
  : element.type === ConversationTurn ? [`message:${(element.props.message as Message).sequence}`] : []);

describe("WorkTimeline event key ancestry", () => {
  it("keeps handoff and open-reader parents when untimed history appends", () => {
    const before = rendered([message(1)]);
    const after = rendered([message(1), message(2)]);
    const again = rendered([message(1), message(2), message(3)]);
    for (const key of [handoff.key, meeting.key]) {
      expect(block(after, key).path).toEqual(block(before, key).path);
      expect(block(again, key).path).toEqual(block(before, key).path);
      expect(block(after, key).element.type).toBe(block(before, key).element.type);
    }
    // The leaf remains the same type/key beneath that parent; this is an identity
    // contract test, not a simulated mount or a claim that DOM state was observed.
    expect(block(after).element.props.children).toBe(handoff.node);
    expect(order(after)).toEqual(["message:1", "message:2", meeting.key, handoff.key]);
  });

  it("keeps the same parent from no history through the first untimed row", () => {
    expect(block(rendered([message(1)])).path).toEqual(block(rendered([])).path);
  });

  it("keeps parents through timed → optimistic untimed → timed history", () => {
    const timed = [message(1, "2026-11-13T08:00:00Z"), message(2, "2026-11-13T10:00:00Z")];
    const before = rendered(timed);
    const pending = rendered([...timed, message(3)]);
    const loaded = rendered([...timed, message(3, "2026-11-13T11:00:00Z")]);
    for (const key of [handoff.key, meeting.key]) {
      expect(block(pending, key).path).toEqual(block(before, key).path);
      expect(block(loaded, key).path).toEqual(block(before, key).path);
    }
    expect(order(before)).toEqual(["message:1", meeting.key, handoff.key, "message:2"]);
    expect(order(pending)).toEqual(["message:1", "message:2", "message:3", meeting.key, handoff.key]);
    expect(order(loaded)).toEqual(["message:1", meeting.key, handoff.key, "message:2", "message:3"]);
  });

  it("preserves explicit anchors and instant order when blocks share or change buckets", () => {
    const anchored: TimedBlock = { ...handoff, key: "transfer", at: "2026-11-13T09:15:00Z", afterSequence: 2 };
    const tail: TimedBlock = { ...handoff, key: "last", at: "2026-11-13T09:10:00Z", afterSequence: null };
    const early: TimedBlock = { ...meeting, key: "early", at: "2026-11-13T16:30:00+08:00" };
    const blocks = [handoff, anchored, tail, early];
    const before = rendered([message(1)], blocks);
    const after = rendered([message(1), message(2), message(3)], blocks);
    expect(order(before)).toEqual(["message:1", "early", "last", "transfer", handoff.key]);
    expect(order(after)).toEqual(["message:1", "message:2", "transfer", "message:3", "early", "last", handoff.key]);
    for (const key of ["early", "last", "transfer", handoff.key]) expect(block(after, key).path).toEqual(block(before, key).path);
    expect(early.at).toBe("2026-11-13T16:30:00+08:00");
  });

  it("keeps block parents while the current streaming turn starts and settles", () => {
    const before = rendered([message(1)]);
    const streaming = rendered([message(1)], undefined, { streaming: true, partial: "reply" });
    const settled = rendered([message(1), { sequence: 2, role: "assistant", content: "reply" }]);
    expect(block(streaming).path).toEqual(block(before).path);
    expect(block(settled).path).toEqual(block(before).path);
    expect(order(streaming)).toEqual(["message:1", meeting.key, handoff.key, "message:-1"]);
  });

  it("第一次打开、消息没到时不画插块", () => {
    // 第一次读历史、一条消息还没到：开工小条等按时间 / 序号插的块都先不画（只留载入状态）。
    const anchored: TimedBlock = { ...handoff, key: "started", afterSequence: 3 };
    expect(order(rendered([], [handoff, meeting, anchored], { historyStatus: "loading" }))).toEqual([]);
    // 读到了（哪怕 0 条）、或已经有消息（重试、读过的对话）时照常画。
    expect(order(rendered([], [handoff, meeting], { historyStatus: "ready" }))).toEqual([meeting.key, handoff.key]);
    expect(order(rendered([message(1)], [handoff], { historyStatus: "loading" }))).toEqual(["message:1", handoff.key]);
  });

  it("wraps the timeline in bubbles (BubbleContext = true) and keeps the reply node from streaming to settled", () => {
    const top = WorkTimeline({ data: data([message(1)]), blocks: [] }) as Element;
    expect(top.type === BubbleContext || top.type === BubbleContext.Provider).toBe(true);
    expect(top.props.value).toBe(true);
    const turn = (tree: Located[]) => tree.find(({ element }) => element.type === ConversationTurn && (element.props.message as Message).role === "assistant")!;
    const streaming = turn(rendered([message(1)], [], { streaming: true, partial: "reply" }));
    const settled = turn(rendered([message(1), { sequence: 2, role: "assistant", content: "reply" }], []));
    expect(settled.path).toEqual(streaming.path);
  });
});
