import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFeishuMinuteInboxItem } from "@warmap/contracts";

/* 把通知栏当函数调用：hooks 用按调用顺序存值的小仓库代替；useEffect 在依赖变了时同步跑一次（同 meetingBooking.behavior.test）。 */
const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0, deps: [] as (unknown[] | undefined)[], effectIndex: 0,
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[index]) : next;
    }];
  },
  useEffect(effect: () => void, deps?: unknown[]) {
    const index = hooks.effectIndex++;
    const previous = hooks.deps[index];
    if (previous && deps && deps.every((value, at) => Object.is(value, previous[at]))) return;
    hooks.deps[index] = deps;
    effect();
  },
}));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()),
  useState: hooks.useState, useEffect: hooks.useEffect, useRef: (initial: unknown) => hooks.useState({ current: initial })[0], useCallback: (fn: unknown) => fn }));
const api = vi.hoisted(() => ({ attach: vi.fn(), ignore: vi.fn() }));
vi.mock("./meetingDecisionApi", () => ({ attachFeishuMinute: api.attach, ignoreFeishuMinute: api.ignore }));
vi.mock("./MeetingBookingSheet", () => ({ MeetingBookingSheet: () => null }));

import { ActionNoticeCard, type ActionNotice } from "@/components/ActionNoticeCard";
import { NoticeActions } from "@/components/NoticeActions";
import { MeetingCardNoticeList } from "./MeetingCardNotices";

type Node = { type?: unknown; props?: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  const node = value as Node;
  return node.props ? [node, ...nodes(node.props.children)] : [];
}
const text = (node: Node): string => {
  const children = node.props?.children;
  return (Array.isArray(children) ? children : [children]).map((child) => (typeof child === "string" ? child : child && typeof child === "object" ? text(child as Node) : "")).join("");
};

const item = (overrides: Partial<TFeishuMinuteInboxItem> = {}): TFeishuMinuteInboxItem => ({
  minuteToken: "obcn1", title: "产品周会", startsAt: "2026-10-23T02:02:00.000Z", endsAt: "2026-10-23T03:15:00.000Z",
  attendees: [], otherAttendees: 0, suggestion: { meetingId: "m9", title: "Inception 设计会" }, ...overrides,
});
const dispatchEvent = vi.fn();

/** 渲染一遍：先通知栏这一组，再展开里面那张 ActionNoticeCard。 */
function render(minutes: TFeishuMinuteInboxItem[], onChanged = vi.fn()) {
  hooks.index = 0;
  hooks.effectIndex = 0;
  const list = MeetingCardNoticeList({ meetings: [], minutes, meetingBase: "/me/meetings", onNavigate: () => undefined, onChanged });
  const card = nodes(list).find((node) => node.type === ActionNoticeCard)!;
  const props = card.props as { notices: ActionNotice[]; onSettled(id: string): void };
  return { notices: props.notices, onSettled: props.onSettled, tree: ActionNoticeCard(props as Parameters<typeof ActionNoticeCard>[0]) };
}

beforeEach(() => {
  hooks.values = [];
  hooks.deps = [];
  api.attach.mockReset();
  dispatchEvent.mockReset();
  vi.useFakeTimers();
  vi.stubGlobal("window", { dispatchEvent, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (id: number) => clearTimeout(id) });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("会议记录待整理：卡上办完", () => {
  it("记到成功：回执留着，回执淡出后才通知 meeting-changed 并重取", async () => {
    api.attach.mockResolvedValue({ meetingId: "m9" });
    const minutes = [item()];
    const onChanged = vi.fn();
    const first = render(minutes, onChanged);
    const outcome = await first.notices[0].buttons[0].run();
    expect(api.attach).toHaveBeenCalledWith("obcn1", "m9");
    expect(outcome).toEqual({ ok: true, settled: "已记到「Inception 设计会」" });
    expect(dispatchEvent).not.toHaveBeenCalled();

    const actions = nodes(first.tree).find((node) => node.type === NoticeActions)!;
    (actions.props as { onSettled(text?: string): void }).onSettled(outcome.ok ? outcome.settled : undefined);
    const shown = render(minutes, onChanged);
    const receipt = nodes(shown.tree).find((node) => node.props?.role === "status");
    expect(receipt && text(receipt)).toBe("已记到「Inception 设计会」");
    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1300);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect((dispatchEvent.mock.calls[0][0] as Event).type).toBe("meeting-changed");
    expect(onChanged).toHaveBeenCalled();
  });

  it("办完的那条在重取回来之前不显示；之后的取数里又出现就照常显示", () => {
    const minutes = [item()];
    render(minutes).onSettled("feishu-minute:obcn1");
    expect(render(minutes).notices).toEqual([]);
    expect(render([]).notices).toEqual([]);
    expect(render([item()]).notices.map((notice) => notice.id)).toEqual(["feishu-minute:obcn1"]);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});
