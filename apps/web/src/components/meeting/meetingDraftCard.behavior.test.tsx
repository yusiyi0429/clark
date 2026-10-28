import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TConversationCard, TWorldAnchorOption } from "@warmap/contracts";

/* 把卡当函数调用：hooks 用按调用顺序存值的小仓库代替；useEffect 在依赖变了时同步跑一次（同 meetingBooking.behavior.test）。 */
const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0, deps: [] as (unknown[] | undefined)[], effectIndex: 0,
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[index]) : next;
    }];
  },
  useRef(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
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
  useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect, useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn }));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ browserApi: { GET: api.get, POST: api.post } }));
const workspace = vi.hoisted(() => ({ navigate: vi.fn(), viewerId: "p-ceo" as string | null, bookMeetingFrom: vi.fn() }));
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => workspace }));

import { MeetingDraftCard } from "./MeetingDraftCard";
import { WorldAnchorPicker } from "./WorldAnchorPicker";

type Node = { type?: unknown; props?: Record<string, unknown> };
type Draft = Extract<TConversationCard, { kind: "meeting_draft" }>;
const PARTS = new Set<unknown>([WorldAnchorPicker]);
function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand);
  if (!value || typeof value !== "object") return value;
  const node = value as Node;
  if (typeof node.type === "function" && PARTS.has(node.type)) return expand((node.type as (props: unknown) => unknown)(node.props));
  return node.props ? { ...node, props: { ...node.props, children: expand(node.props.children) } } : value;
}
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
const click = (node: Node | undefined) => (node!.props!.onClick as (event?: unknown) => void)({ preventDefault() {} });
const button = (tree: Node[], label: string) => tree.find((node) => node.type === "button" && text(node) === label);

/** CEO 在 10/26 说「明天下午三点跟人豪、斯一、王总约半小时」：王总没对上，默认不挂。 */
const CEO_DRAFT: Draft = {
  kind: "meeting_draft", draftId: "8f9c2c55-6d3c-4a51-9a7e-3d9a3c1e0001", title: "新 Chat 切换",
  scheduledAt: "2026-10-27T15:00:00+08:00", endsAt: "2026-10-27T15:30:00+08:00",
  host: { personId: "p-ceo", displayName: "刘明华" },
  participants: [{ personId: "p-renhao", displayName: "刘人豪" }, { personId: "p-siyi", displayName: "于斯一" }],
  unresolved: [{ name: "王总", reason: "not_found" }], anchor: null,
};
/** 成员的：都对上了，默认挂自己的 Mission。 */
const MEMBER_DRAFT: Draft = { ...CEO_DRAFT, draftId: "8f9c2c55-6d3c-4a51-9a7e-3d9a3c1e0002", host: { personId: "p-member", displayName: "孙铭泽" },
  unresolved: [], anchor: { kind: "mission", id: "m-chat", title: "新 Chat 上线" } };
const MISSION: TWorldAnchorOption = { kind: "mission", id: "m-ceo", title: "CEO 的 Mission", brief: null, lifecycle: "confirmed", ownerId: "p-ceo", parentId: null };

let booked: { id: string; title: string; href: string } | null = null;
const render = (card: Draft) => {
  hooks.index = 0;
  hooks.effectIndex = 0;
  return nodes(expand(MeetingDraftCard({ card })));
};
const settled = async (card: Draft) => vi.waitFor(() => expect(button(render(card), "约好")?.props?.disabled ?? "booked").not.toBe(undefined));

beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
  hooks.values = []; hooks.deps = [];
  booked = null;
  api.get.mockReset(); api.post.mockReset(); workspace.navigate.mockReset(); workspace.bookMeetingFrom.mockReset();
  workspace.viewerId = "p-ceo";
  api.get.mockImplementation(async (path: string) => path === "/api/meeting-drafts/{draftId}"
    ? { data: { meeting: booked }, response: { ok: true, status: 200 } }
    : path === "/api/people/directory"
      ? { data: { people: [{ personId: "p-ceo", displayName: "刘明华" }] }, response: { ok: true, status: 200 } }
      : { data: { options: [MISSION] }, response: { ok: true, status: 200 } });
});

describe("对话里的会议卡", () => {
  it("名称、时间、主持人、参会人、挂到；没对上的人名标出来，有没对上的或没挂点约不了", async () => {
    // 读到约好没有之前，两个按钮都不能点。
    const first = render(CEO_DRAFT);
    expect(button(first, "约好")!.props!.disabled).toBe(true);
    expect(button(first, "修改")!.props!.disabled).toBe(true);
    await vi.waitFor(() => expect(button(render(CEO_DRAFT), "修改")!.props!.disabled).toBe(false));
    const tree = render(CEO_DRAFT);
    expect(text(tree.find((node) => node.type === "h3")!)).toBe("新 Chat 切换");
    const rows = Object.fromEntries(tree.filter((node) => node.type === "dt").map((dt, index) => [text(dt), tree.filter((node) => node.type === "dd")[index]]));
    expect(Object.keys(rows)).toEqual(["时间", "主持人", "参会人", "所属"]);
    expect(text(rows["时间"])).toBe("10 月 27 日 周二 15:00–15:30");
    expect(text(rows["主持人"])).toBe("刘明华");
    expect(nodes(rows["参会人"]).filter((node) => node.type === "li").map(text)).toEqual(["刘人豪", "于斯一", "王总？"]);
    expect(nodes(rows["参会人"]).find((node) => text(node) === "王总？")!.props!["data-unresolved"]).toBe("not_found");
    expect(button(tree, "选择")).toBeTruthy();
    expect(button(tree, "约好")!.props!.disabled).toBe(true);
    expect(api.get).toHaveBeenCalledWith("/api/meeting-drafts/{draftId}", { params: { path: { draftId: CEO_DRAFT.draftId } } });
  });

  it("CEO 在卡上选挂点后能约；「约好」连点只发一次，约好后原地变成已约、带去会议页的链接", async () => {
    const card: Draft = { ...CEO_DRAFT, unresolved: [] };
    await settled(card);
    click(button(render(card), "选择"));
    await vi.waitFor(() => expect(render(card).some((node) => node.props?.["aria-label"] === "搜对象")).toBe(true));
    expect(api.get).toHaveBeenCalledWith("/api/world-anchor-options", { params: { query: { period: "2026-10" } } });
    click(render(card).find((node) => node.type === "button" && text(node).includes("CEO 的 Mission")));
    expect(text(render(card).find((node) => node.props?.["data-anchor-row"] !== undefined)!)).toContain("CEO 的 Mission");

    let finish!: () => void;
    api.post.mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ data: { card: { objectRef: { id: "meet-1" }, title: "新 Chat 切换", navigation: [{ href: "/meetings/meet-1" }] } }, response: { ok: true, status: 200 } });
    }));
    const tree = render(card);
    click(button(tree, "约好"));
    click(button(tree, "约好"));
    click(button(render(card), "约好"));
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith("/api/meetings", { body: {
      title: "新 Chat 切换", scheduledAt: "2026-10-27T15:00:00+08:00", endsAt: "2026-10-27T15:30:00+08:00", leadDriId: "p-ceo",
      participants: ["p-renhao", "p-siyi"], anchors: [{ kind: "mission", id: "m-ceo" }], draftId: card.draftId } });
    finish();
    await vi.waitFor(() => expect(render(card).find((node) => node.type === "section")!.props!["data-status"]).toBe("booked"));
    const after = render(card);
    expect(button(after, "约好")).toBeUndefined();
    expect(button(after, "修改")).toBeUndefined();
    const link = after.find((node) => node.type === "a")!;
    expect(link.props!.href).toBe("/meetings/meet-1");
    click(link);
    expect(workspace.navigate).toHaveBeenCalledWith("/meetings/meet-1");
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it("刷新、重放历史：按 draftId 读回已约，不再出「约好」", async () => {
    booked = { id: "meet-9", title: "新 Chat 切换", href: "/me/meetings/meet-9" };
    workspace.viewerId = "p-member";
    await vi.waitFor(() => expect(render(MEMBER_DRAFT).find((node) => node.type === "section")!.props!["data-status"]).toBe("booked"));
    const tree = render(MEMBER_DRAFT);
    expect(button(tree, "约好")).toBeUndefined();
    expect(button(tree, "更换")).toBeUndefined();
    expect(tree.find((node) => node.type === "a")!.props!.href).toBe("/me/meetings/meet-9");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("改：打开约会议面板，草稿整份填进去；面板里约好后（meeting-changed）卡读回已约", async () => {
    workspace.viewerId = "p-member";
    await settled(MEMBER_DRAFT);
    expect(button(render(MEMBER_DRAFT), "约好")!.props!.disabled).toBe(false);
    click(button(render(MEMBER_DRAFT), "修改"));
    expect(workspace.bookMeetingFrom).toHaveBeenCalledWith({ draftId: MEMBER_DRAFT.draftId, title: "新 Chat 切换",
      scheduledAt: MEMBER_DRAFT.scheduledAt, endsAt: MEMBER_DRAFT.endsAt, leadDriId: "p-member", participants: ["p-renhao", "p-siyi"],
      anchors: [{ kind: "mission", id: "m-chat", title: "新 Chat 上线" }] });
    booked = { id: "meet-2", title: "新 Chat 切换", href: "/me/meetings/meet-2" };
    (window as unknown as EventTarget).dispatchEvent(new Event("meeting-changed"));
    await vi.waitFor(() => expect(render(MEMBER_DRAFT).find((node) => node.type === "a")?.props?.href).toBe("/me/meetings/meet-2"));
  });
});
