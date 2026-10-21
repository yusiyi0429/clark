import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ellipsis } from "lucide-react";
import type { TMeetingCardDraft, TMeetingCardSync, TMeetingCardView } from "@warmap/contracts";

/* 把组件当函数调用、点里面的按钮：hooks 用一个按调用顺序存值的小仓库代替（同 meetingWorldBar.behavior.test）。 */
const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0, refs: [] as { current: unknown }[], refIndex: 0,
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[index]) : next;
    }];
  },
  useRef(initial: unknown) {
    return (hooks.refs[hooks.refIndex++] ??= { current: initial });
  },
}));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()),
  useState: hooks.useState, useRef: hooks.useRef, useEffect: () => undefined, useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn() }));
const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ browserApi: { GET: api.get, PUT: api.put, POST: api.post } }));

import { ActionItemRow } from "./ActionItemRow";
import { CardItemMenu } from "./CardItemMenu";
import { InlineText } from "./InlineText";
import { MeetingRecordCard } from "./MeetingRecordCard";
import { ObjectChangeDiff } from "./ObjectChangeDiff";
import { RecordCardFooter } from "./RecordCardFooter";
import { RecordSection } from "./RecordSection";

type Node = { type?: unknown; props?: Record<string, unknown> };
/** 展开会议卡自己的子组件（库组件不展开），按渲染顺序深度优先，hooks 顺序和真渲染一致。 */
const PARTS = new Set<unknown>([ActionItemRow, CardItemMenu, InlineText, ObjectChangeDiff, RecordCardFooter, RecordSection]);
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
  return (Array.isArray(children) ? children : [children]).map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : child && typeof child === "object" ? text(child as Node) : "")).join("");
};

const SOURCE = { id: "src-1", url: "https://example.feishu.cn/minutes/abc", title: "渠道预算会", contentHash: "a".repeat(64), sourceVersion: null, capturedAt: "2026-10-20T15:00:00+08:00" };
const SEC_1 = { id: "sec-1", heading: "预算", body: "二期预算定为 80 万。已定。", sourceRefs: [{ sourceId: "src-1", locator: "turn-0001..turn-0002" }] };
const SEC_2 = { id: "sec-2", heading: "排期", body: "十一月上线。未定。", sourceRefs: [] };
const CHANGE = { id: "chg-1", targetRef: "obj-1#b1/c1", targetTitle: "接口全量切到 v2 · result", expectedVersion: 4, before: { text: "九月完成" },
  after: { text: "十一月完成" }, basisSectionIds: ["sec-1"], stale: false };
const draft = (overrides: Partial<TMeetingCardDraft> = {}): TMeetingCardDraft => ({
  schemaVersion: "meeting-card.v1", meetingId: "m1", title: "渠道预算会", occurredAt: "2026-10-20T14:00:00+08:00",
  participants: [{ name: "林晓", personRef: null }], relatedObjectRefs: ["obj-1"], summary: "定了两期投入。",
  sections: [SEC_1, SEC_2], sources: [SOURCE], objectChanges: [CHANGE], ...overrides,
});
const confirmedOf = (source: TMeetingCardDraft, revision = 1): NonNullable<TMeetingCardView["confirmed"]> => ({
  payload: { ...source, revision, relatedObjectRefs: ["obj-1@4"], objectChanges: source.objectChanges.map(({ stale: _stale, ...change }) => change) },
  confirmation: { revision, confirmedBy: "p1", confirmedAt: "2026-10-20T10:42:00.000Z", payloadHash: "b".repeat(64) },
  kind: "first",
  actionItems: [],
});
const SYNCED: TMeetingCardSync = { revision: 1, writeToWorld: true, event: { status: "succeeded", eventId: "ev-1", error: null },
  objects: [{ changeId: "chg-1", title: "接口全量切到 v2 · result", status: "updated", actualVersion: 5, error: null }] };
const view = (overrides: Partial<TMeetingCardView> = {}): TMeetingCardView => ({
  draft: draft(), draftVersion: 3, draftStatus: "draft_ready", actionItems: [], confirmed: null, sync: null, targetOptions: [], canEdit: true, draftChange: "none", ...overrides,
});
const ok = (data: TMeetingCardView) => ({ data, response: { ok: true, status: 200 } });

const PEOPLE = [{ personId: "p1", displayName: "林晓" }, { personId: "p2", displayName: "周舟" }];
const ITEM = { id: "act-1", text: "提交排期", ownerPersonId: null, dueDate: null, basisSectionIds: ["sec-2"], taskId: null };
const render = (initial: TMeetingCardView) => {
  hooks.index = 0;
  hooks.refIndex = 0;
  return nodes(expand(MeetingRecordCard({ meetingId: "m1", initial, people: PEOPLE })));
};
const button = (tree: Node[], label: string) => tree.find((node) => node.type === "button" && text(node) === label);
const click = (node: Node | undefined) => (node!.props!.onClick as () => void)();
const hasText = (tree: Node[], value: string) => tree.some((node) => typeof node.type === "string" && text(node) === value);

beforeEach(() => {
  hooks.values = []; hooks.refs = [];
  api.get.mockReset(); api.put.mockReset(); api.post.mockReset();
  vi.stubGlobal("window", { dispatchEvent: vi.fn(), location: { assign: vi.fn() } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("会议卡：整卡编辑、确认、修改、同步状态", () => {
  it("点确认带上草稿版本", async () => {
    const initial = view();
    api.post.mockResolvedValue(ok(view({ confirmed: confirmedOf(draft()), sync: { ...SYNCED, event: { status: "pending", eventId: null, error: null } } })));
    expect(hasText(render(initial), "待确认")).toBe(true);
    click(button(render(initial), "确认这份记录"));
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/meetings/{id}/card/confirm",
      { params: { path: { id: "m1" } }, body: { draftVersion: 3, writeToWorld: true } }));
    await vi.waitFor(() => expect(hasText(render(initial), "会议事件 · 写入中")).toBe(true));
    const after = render(initial);
    expect(hasText(after, "已确认 · v1 · 10/20 18:42")).toBe(true);
    expect(button(after, "修改")).toBeDefined();
    expect(button(after, "确认这份记录")).toBeUndefined();
  });

  it("草稿过期提示查看最新", async () => {
    const initial = view();
    api.post.mockResolvedValue({ error: { code: "DRAFT_CHANGED", message: "会议卡已被修改，请查看最新内容", view: view({ draftVersion: 4 }) }, response: { ok: false, status: 409 } });
    click(button(render(initial), "确认这份记录"));
    await vi.waitFor(() => expect(hasText(render(initial), "内容已更新")).toBe(true));
    api.get.mockResolvedValue(ok(view({ draftVersion: 4, draft: draft({ summary: "别人改过的摘要。" }) })));
    click(button(render(initial), "查看最新"));
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/meetings/{id}/card", { params: { path: { id: "m1" } } }));
    await vi.waitFor(() => expect(hasText(render(initial), "内容已更新")).toBe(false));
    expect(render(initial).some((node) => node.type === "textarea" && node.props?.value === "别人改过的摘要。")).toBe(true);
  });

  it("存草稿后和确认版的差别变了才通知页头重读", async () => {
    vi.useFakeTimers();
    const confirmed = { confirmed: confirmedOf(draft()), sync: SYNCED };
    const initial = view({ ...confirmed, draftChange: "none" });
    const changed = (window.dispatchEvent as ReturnType<typeof vi.fn>);
    const edit = (value: string) => (render(initial).find((node) => node.type === "textarea" && node.props?.["aria-label"] === "第 1 段正文")!.props!
      .onChange as (event: unknown) => void)({ target: { value } });
    click(button(render(initial), "修改"));
    api.put.mockResolvedValue(ok(view({ ...confirmed, draftVersion: 4, draftChange: "content" })));
    edit("二期预算定为 90 万。已定。");
    await vi.advanceTimersByTimeAsync(900);
    expect(changed.mock.calls.map(([event]) => (event as Event).type)).toEqual(["meeting-changed"]);
    api.put.mockResolvedValue(ok(view({ ...confirmed, draftVersion: 5, draftChange: "content" })));
    edit("二期预算定为 95 万。已定。");
    await vi.advanceTimersByTimeAsync(900);
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("改一段正文自动保存", async () => {
    vi.useFakeTimers();
    const initial = view();
    api.put.mockResolvedValue(ok(view({ draftVersion: 4 })));
    const body = render(initial).find((node) => node.type === "textarea" && node.props?.["aria-label"] === "第 1 段正文")!;
    (body.props!.onChange as (event: unknown) => void)({ target: { value: "二期预算定为 90 万。已定。" } });
    expect(api.put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(900);
    expect(api.put).toHaveBeenCalledTimes(1);
    const [path, request] = api.put.mock.calls[0] as [string, { params: unknown; body: { draftVersion: number; draft: TMeetingCardDraft } }];
    expect(path).toBe("/api/meetings/{id}/card/draft");
    expect(request.params).toEqual({ path: { id: "m1" } });
    expect(request.body.draftVersion).toBe(3);
    expect(request.body.draft.sections[0].body).toBe("二期预算定为 90 万。已定。");
    expect(request.body).not.toHaveProperty("actionItems");
  });

  it("修改时标出差异且要选原因", async () => {
    const original = draft();
    const edited = draft({ sections: [SEC_1, { ...SEC_2, body: "十二月上线。已定。" }] });
    const initial = view({ draft: edited, confirmed: confirmedOf(original), sync: SYNCED, draftChange: "content" });
    const tree = render(initial);
    expect(hasText(tree, "修改中")).toBe(true);
    expect(tree.filter((node) => node.props?.["data-changed"] !== undefined).map((node) => node.props!["aria-label"])).toEqual(["第 2 段"]);
    expect(button(tree, "确认修改")!.props!.disabled).toBe(true);
    const followup = tree.find((node) => node.type === "input" && node.props?.type === "radio" && node.props?.value === "followup")!;
    expect(tree.filter((node) => node.type === "input" && node.props?.type === "radio").every((node) => node.props!.checked === false)).toBe(true);
    (followup.props!.onChange as () => void)();

    api.post.mockResolvedValue(ok(view({ draft: edited, confirmed: { ...confirmedOf(edited, 2), kind: "followup" }, sync: { ...SYNCED, revision: 2 } })));
    const chosen = render(initial);
    expect(button(chosen, "确认修改")!.props!.disabled).toBe(false);
    click(button(chosen, "确认修改"));
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/meetings/{id}/card/confirm",
      { params: { path: { id: "m1" } }, body: expect.objectContaining({ draftVersion: 3, writeToWorld: true, kind: "followup" }) }));
  });

  it("目标未定可以选目标", async () => {
    const undecided = { ...CHANGE, targetRef: null, targetTitle: null, expectedVersion: null, before: null };
    const option = { targetRef: "obj-1#b1/c1", title: "接口全量切到 v2 · result", componentType: "result", text: "九月完成" };
    const initial = view({ draft: draft({ objectChanges: [undecided] }), targetOptions: [option] });
    api.put.mockResolvedValue(ok(view({ draftVersion: 4 })));
    const tree = render(initial);
    expect(hasText(tree, "目标未定")).toBe(true);
    const picker = tree.find((node) => node.props?.["aria-label"] === "选目标" && "options" in node.props)!;
    (picker.props!.onChange as (value: string) => void)(option.targetRef);
    await vi.waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const request = api.put.mock.calls[0][1] as { body: { draft: TMeetingCardDraft } };
    expect(request.body.draft.objectChanges[0].targetRef).toBe(option.targetRef);
  });

  it("删掉被行动项引为依据的段落：行动项跟着去掉那段一起交，没引的不交", async () => {
    const item = { id: "act-1", text: "提交排期", ownerPersonId: null, dueDate: null, basisSectionIds: ["sec-1", "sec-2"], taskId: null };
    const initial = view({ actionItems: [item] });
    api.put.mockResolvedValue(ok(view({ draftVersion: 4, draft: draft({ sections: [SEC_2] }), actionItems: [{ ...item, basisSectionIds: ["sec-2"] }] })));
    // 两段、一条行动项、一条对象修改各有「⋯ 删除」，第一个是第 1 段的。
    const remove = render(initial).filter((node) => node.props?.onPress && text(node) === "删除");
    expect(remove).toHaveLength(4);
    (remove[0].props!.onPress as () => void)();
    await vi.waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const request = api.put.mock.calls[0][1] as { body: { draft: TMeetingCardDraft; actionItems?: unknown } };
    expect(request.body.draft.sections.map((section) => section.id)).toEqual(["sec-2"]);
    expect(request.body.draft.objectChanges[0].basisSectionIds).toEqual([]);
    expect(request.body.actionItems).toEqual([{ ...item, basisSectionIds: ["sec-2"] }]);
  });

  it("存的时候又改了：等这次存完，下一次带它回来的版本和新文字", async () => {
    vi.useFakeTimers();
    const initial = view();
    let finishFirst!: (value: unknown) => void;
    api.put.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; })).mockResolvedValueOnce(ok(view({ draftVersion: 5 })));
    const typeBody = (value: string) =>
      (render(initial).find((node) => node.type === "textarea" && node.props?.["aria-label"] === "第 1 段正文")!.props!.onChange as (event: unknown) => void)({ target: { value } });
    typeBody("二期预算定为 85 万。");
    await vi.advanceTimersByTimeAsync(900);
    expect(api.put).toHaveBeenCalledTimes(1);
    typeBody("二期预算定为 85 万。已定。");
    await vi.advanceTimersByTimeAsync(900);
    expect(api.put).toHaveBeenCalledTimes(1);
    finishFirst(ok(view({ draftVersion: 4 })));
    await vi.waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    const second = (api.put.mock.calls[1][1] as { body: { draftVersion: number; draft: TMeetingCardDraft } }).body;
    expect(second.draftVersion).toBe(4);
    expect(second.draft.sections[0].body).toBe("二期预算定为 85 万。已定。");
  });

  it("没填实际时间：按钮旁边选时间，先存时间再确认", async () => {
    const initial = view({ draft: draft({ occurredAt: null }) });
    const timed = draft({ occurredAt: "2026-10-01T09:00:00+08:00" });
    api.put.mockResolvedValue(ok(view({ draftVersion: 4, draft: timed })));
    api.post.mockResolvedValue(ok(view({ draftVersion: 4, draft: timed, confirmed: confirmedOf(timed), sync: SYNCED })));
    const tree = render(initial);
    expect(button(tree, "确认这份记录")!.props!.disabled).toBe(true);
    const pickers = tree.filter((node) => node.props?.label === "实际" && typeof node.props?.onChange === "function");
    expect(pickers).toHaveLength(1);
    (pickers[0].props!.onChange as (value: string) => void)("2026-10-01T09:00");
    await vi.waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect((api.put.mock.calls[0][1] as { body: { draft: TMeetingCardDraft } }).body.draft.occurredAt).toBe("2026-10-01T09:00:00+08:00");
    await vi.waitFor(() => expect(button(render(initial), "确认这份记录")!.props!.disabled).toBe(false));
    click(button(render(initial), "确认这份记录"));
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect((api.post.mock.calls[0][1] as { body: unknown }).body).toEqual({ draftVersion: 4, writeToWorld: true });
    expect(api.put.mock.invocationCallOrder[0]).toBeLessThan(api.post.mock.invocationCallOrder[0]);
  });

  it("没挂对象又要写进本体：开关旁标「未挂对象」、不能确认；选不写进本体就能确认", () => {
    const initial = view({ draft: draft({ relatedObjectRefs: [] }) });
    const tree = render(initial);
    expect(hasText(tree, "未挂对象")).toBe(true);
    expect(button(tree, "确认这份记录")!.props!.disabled).toBe(true);
    click(tree.find((node) => node.props?.role === "switch"));
    const off = render(initial);
    expect(hasText(off, "未挂对象")).toBe(false);
    expect(button(off, "确认这份记录")!.props!.disabled).toBe(false);
  });

  it("确认出错只显示标签：本体读不了是「本体暂不可用」，时间不对把时间标红", async () => {
    const initial = view();
    api.post.mockResolvedValueOnce({ error: { code: "WORLD_UNAVAILABLE", message: "World read failed: ETIMEDOUT" }, response: { ok: false, status: 503 } });
    click(button(render(initial), "确认这份记录"));
    await vi.waitFor(() => expect(hasText(render(initial), "本体暂不可用")).toBe(true));
    expect(render(initial).some((node) => text(node).includes("ETIMEDOUT"))).toBe(false);

    api.post.mockResolvedValueOnce({ error: { code: "OCCURRED_AT_REQUIRED", message: "实际时间要填且不能在将来" }, response: { ok: false, status: 400 } });
    click(button(render(initial), "确认这份记录"));
    await vi.waitFor(() => expect(render(initial).some((node) => node.props?.["data-invalid"] !== undefined)).toBe(true));
    const after = render(initial);
    expect(after.some((node) => text(node).includes("将来"))).toBe(false);
    expect(button(after, "确认这份记录")!.props!.disabled).toBe(true);
  });

  it("修改中：改过的段落，确认版原文划线显示在新文字正上方；没改的只显示一次", () => {
    const edited = draft({ sections: [SEC_1, { ...SEC_2, body: "十二月上线。已定。" }] });
    const tree = render(view({ draft: edited, confirmed: confirmedOf(draft()), sync: SYNCED, draftChange: "content" }));
    const second = nodes(tree.find((node) => node.props?.["aria-label"] === "第 2 段"));
    const struck = second.findIndex((node) => node.type === "del");
    expect(text(second[struck])).toBe("十一月上线。未定。");
    expect(struck).toBeLessThan(second.findIndex((node) => node.type === "textarea" && node.props?.["aria-label"] === "第 2 段正文"));
    expect(second.filter((node) => node.type === "del")).toHaveLength(1);
    expect(nodes(tree.find((node) => node.props?.["aria-label"] === "第 1 段")).some((node) => node.type === "del")).toBe(false);
  });

  it("对象修改可以删；修改中删掉的整条划线留在原处", async () => {
    api.put.mockResolvedValue(ok(view({ draftVersion: 4, draft: draft({ objectChanges: [] }) })));
    const initial = view();
    // 两段和一条对象修改各有「⋯ 删除」，最后一个是对象修改的。
    (render(initial).filter((node) => node.props?.onPress && text(node) === "删除").at(-1)!.props!.onPress as () => void)();
    await vi.waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect((api.put.mock.calls[0][1] as { body: { draft: TMeetingCardDraft } }).body.draft.objectChanges).toEqual([]);

    hooks.values = []; hooks.refs = [];
    const editing = render(view({ draft: draft({ objectChanges: [] }), confirmed: confirmedOf(draft()), sync: SYNCED, draftChange: "content" }));
    const gone = editing.find((node) => node.type === "article" && node.props?.["data-deleted"] !== undefined)!;
    expect(gone.props!["aria-label"]).toBe("接口全量切到 v2 · result");
    expect(nodes(gone).some((node) => node.type === "textarea")).toBe(false);
  });

  it("只读的人也看同步状态，没有重试", () => {
    const tree = render(view({ canEdit: false, confirmed: confirmedOf(draft()), sync: { ...SYNCED, event: { status: "failed", eventId: null, error: "本体超时" } } }));
    expect(hasText(tree, "会议事件 · 写入失败 · 本体超时")).toBe(true);
    expect(hasText(tree, "接口全量切到 v2 · result · 已更新")).toBe(true);
    expect(button(tree, "重试")).toBeUndefined();
  });

  it("同步行只显示短标签：连不上本体照写；没细分的失败不重复「写入失败」", () => {
    const tree = render(view({ canEdit: false, confirmed: confirmedOf(draft()), sync: { ...SYNCED, event: { status: "failed", eventId: null, error: "连不上本体" },
      objects: [{ ...SYNCED.objects[0], status: "failed", error: "写入失败" }] } }));
    expect(hasText(tree, "会议事件 · 写入失败 · 连不上本体")).toBe(true);
    // 写失败的修改：待重新确认（下次确认换新键再提交）。
    expect(hasText(tree, "接口全量切到 v2 · result · 待重新确认")).toBe(true);
    hooks.values = []; hooks.refs = [];
    // 天枢以自己身份改不了的正式块：已确认、待同步，不算失败。
    const pendingSync = render(view({ canEdit: false, confirmed: confirmedOf(draft()), sync: { ...SYNCED,
      objects: [{ ...SYNCED.objects[0], status: "not_allowed", error: "已确认、待同步 · 正式块" }] } }));
    expect(hasText(pendingSync, "接口全量切到 v2 · result · 已确认、待同步 · 正式块")).toBe(true);
    hooks.values = []; hooks.refs = [];
    const generic = render(view({ canEdit: false, confirmed: confirmedOf(draft()), sync: { ...SYNCED, event: { status: "failed", eventId: null, error: "写入失败" } } }));
    expect(hasText(generic, "会议事件 · 写入失败")).toBe(true);
  });

  it("事件写失败可以重试", async () => {
    const initial = view({ confirmed: confirmedOf(draft()), sync: { ...SYNCED, event: { status: "failed", eventId: null, error: "本体超时" } } });
    api.post.mockResolvedValue(ok(view({ confirmed: confirmedOf(draft()), sync: { ...SYNCED, event: { status: "pending", eventId: null, error: null } } })));
    const tree = render(initial);
    expect(hasText(tree, "会议事件 · 写入失败 · 本体超时")).toBe(true);
    expect(hasText(tree, "接口全量切到 v2 · result · 已更新")).toBe(true);
    click(button(tree, "重试"));
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/meetings/{id}/card/retry", { params: { path: { id: "m1" } } }));
  });

  it("行动项可以改负责人", async () => {
    const initial = view({ actionItems: [ITEM] });
    api.put.mockResolvedValue(ok(view({ draftVersion: 4, actionItems: [{ ...ITEM, ownerPersonId: "p2" }] })));
    const tree = render(initial);
    expect(hasText(tree, "依据：第 2 段")).toBe(true);
    const owner = tree.find((node) => node.props?.["aria-label"] === "第 1 条负责人" && "options" in node.props)!;
    expect(owner.props!.options).toEqual([{ value: "p1", label: "林晓" }, { value: "p2", label: "周舟" }]);
    (owner.props!.onChange as (value: string) => void)("p2");
    await vi.waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const request = api.put.mock.calls[0][1] as { body: { actionItems: { ownerPersonId: string | null }[] } };
    expect(request.body.actionItems[0].ownerPersonId).toBe("p2");
  });

  it("加一条行动项，写了事项才存", async () => {
    vi.useFakeTimers();
    const initial = view({ actionItems: [ITEM] });
    api.put.mockResolvedValue(ok(view({ draftVersion: 4 })));
    click(button(render(initial), "加一条"));
    const fresh = render(initial).find((node) => node.type === "textarea" && node.props?.["aria-label"] === "第 2 条事项")!;
    expect(fresh).toBeDefined();
    await vi.advanceTimersByTimeAsync(900);
    expect(api.put).not.toHaveBeenCalled();
    (fresh.props!.onChange as (event: unknown) => void)({ target: { value: "约客户演示" } });
    await vi.advanceTimersByTimeAsync(900);
    expect(api.put).toHaveBeenCalledTimes(1);
    const items = (api.put.mock.calls[0][1] as { body: { actionItems: { id: string; text: string; taskId: string | null }[] } }).body.actionItems;
    expect(items.map((item) => item.text)).toEqual(["提交排期", "约客户演示"]);
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
    expect(items[1].taskId).toBeNull();
  });

  it("已派的显示标签；只读的人只看", () => {
    const sent = { ...ITEM, ownerPersonId: "p2", taskId: "task-1" };
    const editor = render(view({ actionItems: [sent, { ...ITEM, id: "act-2", text: "补预算表" }] }));
    const sentTag = (tree: Node[], label: string) => hasText(nodes(tree.find((node) => node.props?.["aria-label"] === label)), "已派");
    expect(sentTag(editor, "第 1 条")).toBe(true);
    expect(sentTag(editor, "第 2 条")).toBe(false);

    hooks.values = []; hooks.refs = [];
    const confirmed = { ...confirmedOf(draft()), actionItems: [sent] };
    const reader = render(view({ canEdit: false, actionItems: [sent, { ...ITEM, id: "act-2", text: "补预算表" }], confirmed, sync: SYNCED }));
    expect(hasText(reader, "提交排期")).toBe(true);
    expect(hasText(reader, "已派")).toBe(true);
    expect(hasText(reader, "周舟")).toBe(true);
    expect(hasText(reader, "补预算表")).toBe(false);
    expect(button(reader, "加一条")).toBeUndefined();
    expect(reader.some((node) => node.props?.["aria-label"] === "第 1 条负责人")).toBe(false);
  });

  it("修改中：改过的行动项原文划线在新文字上方", () => {
    const tree = render(view({ actionItems: [{ ...ITEM, text: "提交排期和预算" }], confirmed: { ...confirmedOf(draft()), actionItems: [ITEM] }, sync: SYNCED, draftChange: "items" }));
    expect(hasText(tree, "修改中")).toBe(true);
    const row = tree.find((node) => node.props?.["aria-label"] === "第 1 条" && node.props?.["data-changed"] !== undefined)!;
    const inside = nodes(row);
    const struck = inside.findIndex((node) => node.type === "del");
    expect(text(inside[struck])).toBe("提交排期");
    expect(struck).toBeLessThan(inside.findIndex((node) => node.type === "textarea" && node.props?.["aria-label"] === "第 1 条事项"));
  });

  it("服务端说只改了行动项（items）：没有修改原因和本体开关，确认不带 kind", async () => {
    const confirmed = { ...confirmedOf(draft()), actionItems: [ITEM] };
    const initial = view({ actionItems: [ITEM, { ...ITEM, id: "act-2", text: "补预算表" }], confirmed, sync: SYNCED, draftChange: "items" });
    api.post.mockResolvedValue(ok(view({ actionItems: initial.actionItems, confirmed: { ...confirmed, actionItems: initial.actionItems }, sync: SYNCED })));
    const tree = render(initial);
    expect(hasText(tree, "修改中")).toBe(true);
    expect(tree.some((node) => node.type === "input" && node.props?.type === "radio")).toBe(false);
    expect(tree.some((node) => node.props?.role === "switch")).toBe(false);
    expect(button(tree, "确认修改")!.props!.disabled).toBe(false);
    click(button(tree, "确认修改"));
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect((api.post.mock.calls[0][1] as { body: unknown }).body).toEqual({ draftVersion: 3, writeToWorld: true });
  });

  it("服务端说会议内容也改了（content，比如挂点变了）：本地只改了行动项也要选原因，确认带 kind", async () => {
    // 挂点这类卡上看不出来的变化：本地草稿和确认版一样，只有行动项不同；以服务端的 draftChange 为准。
    const confirmed = { ...confirmedOf(draft()), actionItems: [ITEM] };
    const initial = view({ actionItems: [{ ...ITEM, text: "提交排期和预算" }], confirmed, sync: SYNCED, draftChange: "content" });
    api.post.mockResolvedValue(ok(view({ confirmed: { ...confirmedOf(draft(), 2), kind: "followup" }, sync: { ...SYNCED, revision: 2 } })));
    const tree = render(initial);
    expect(hasText(tree, "修改中")).toBe(true);
    expect(button(tree, "确认修改")!.props!.disabled).toBe(true);
    (tree.find((node) => node.type === "input" && node.props?.type === "radio" && node.props?.value === "followup")!.props!.onChange as () => void)();
    click(button(render(initial), "确认修改"));
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect((api.post.mock.calls[0][1] as { body: unknown }).body).toEqual({ draftVersion: 3, writeToWorld: true, kind: "followup" });
  });

  it("只改了依据也标出来", () => {
    const tree = render(view({ actionItems: [{ ...ITEM, basisSectionIds: ["sec-1"] }], confirmed: { ...confirmedOf(draft()), actionItems: [ITEM] }, sync: SYNCED, draftChange: "items" }));
    expect(tree.some((node) => node.props?.["aria-label"] === "第 1 条" && node.props?.["data-changed"] !== undefined)).toBe(true);
  });

  it("空着的新一条不拦住别的保存；离开后标红", async () => {
    const initial = view({ actionItems: [ITEM] });
    api.put.mockResolvedValue(ok(view({ draftVersion: 4, actionItems: [{ ...ITEM, ownerPersonId: "p2" }] })));
    click(button(render(initial), "加一条"));
    const owner = render(initial).find((node) => node.props?.["aria-label"] === "第 1 条负责人" && "options" in node.props)!;
    (owner.props!.onChange as (value: string) => void)("p2");
    await vi.waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const sent = (api.put.mock.calls[0][1] as { body: { actionItems: { id: string; ownerPersonId: string | null }[] } }).body.actionItems;
    expect(sent).toEqual([{ ...ITEM, ownerPersonId: "p2" }]);

    const blankRow = () => render(initial).find((node) => node.props?.["aria-label"] === "第 2 条")!;
    const blankText = () => nodes(blankRow()).find((node) => node.type === "textarea")!;
    expect(blankText().props!["aria-invalid"]).toBeUndefined();
    (blankRow().props!.onBlur as (event: unknown) => void)({ currentTarget: { contains: () => false }, relatedTarget: null });
    expect(blankText().props!["aria-invalid"]).toBe(true);
  });

  it("只读的人没有编辑控件", () => {
    const noEdits = (tree: Node[]) => {
      expect(button(tree, "确认这份记录")).toBeUndefined();
      expect(button(tree, "修改")).toBeUndefined();
      expect(tree.some((node) => node.type === Ellipsis)).toBe(false);
      expect(tree.some((node) => node.type === "textarea" || node.type === "input")).toBe(false);
    };
    const pending = render(view({ canEdit: false }));
    expect(hasText(pending, "待确认")).toBe(true);
    noEdits(pending);

    hooks.values = []; hooks.refs = [];
    const confirmed = render(view({ canEdit: false, draft: draft({ summary: "还没确认的新摘要。" }), confirmed: confirmedOf(draft()) }));
    expect(hasText(confirmed, "定了两期投入。")).toBe(true);
    expect(hasText(confirmed, "还没确认的新摘要。")).toBe(false);
    expect(hasText(confirmed, "待确认")).toBe(false);
    noEdits(confirmed);
  });
});
