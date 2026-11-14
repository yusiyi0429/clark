import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import type { TTeamDelivery } from "@warmap/contracts";

// Exercise production component callbacks/effects with DOM boundary stubs, without a browser runtime.
const hooks = vi.hoisted(() => ({
  position: 0, values: [] as unknown[], effects: [] as (() => void | (() => void))[],
  useState(initial: unknown) {
    const key = hooks.position++;
    if (!(key in hooks.values)) hooks.values[key] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[key], (next: unknown) => { hooks.values[key] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[key]) : next; }];
  },
  useRef(initial: unknown) {
    const key = hooks.position++;
    if (!(key in hooks.values)) hooks.values[key] = { current: initial };
    return hooks.values[key];
  },
}));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()),
  useState: hooks.useState, useRef: hooks.useRef, useId: () => "reply-field",
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const key = hooks.position++;
    const previous = hooks.values[key] as unknown[] | undefined;
    if (!previous || deps.some((value, index) => !Object.is(value, previous[index]))) hooks.effects.push(effect);
    hooks.values[key] = deps;
  },
}));
const api = vi.hoisted(() => ({ retry: vi.fn(), reply: vi.fn() }));
vi.mock("@/lib/home/teamDelivery", async (original) => ({ ...(await original<typeof import("@/lib/home/teamDelivery")>()),
  retryRecipient: api.retry, replyTeamDelivery: api.reply,
}));
import { TeamDeliveryCard } from "./PartnerTeamCard";

type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Children.toArray(node).flatMap((child) => isValidElement(child)
  ? [child as Element, ...nodes((child.props as { children?: ReactNode }).children)] : []);
const textOf = (node: ReactNode): string => Children.toArray(node).map((child) => isValidElement(child)
  ? textOf((child.props as { children?: ReactNode }).children) : String(child ?? "")).join("");
const button = (tree: ReactNode, label: string) => nodes(tree).find((node) => node.type === "button" && textOf(node.props.children as ReactNode) === label)!;
const recipient = { personId: "lin", displayName: "小林", status: "needs_info" as const, error: null,
  replies: [{ id: "reply-1", status: "needs_info" as const, text: "请补成本范围", attachments: [], createdAt: "2026-11-13T04:00:00Z" }] };
const delivery: TTeamDelivery = { id: "q", kind: "question", text: "给出反馈", sender: { personId: "me", displayName: "发起人" },
  createdAt: "2026-11-13T04:00:00Z", dueAt: null, sourceUrl: null, attachments: [], recipients: [recipient] };
const saved = vi.fn();
const forward = vi.fn();
const card = (item = delivery, sent = false) => { hooks.position = 0; return TeamDeliveryCard({ delivery: item, sent, onSaved: saved, onForward: forward }); };
const personElement = (tree: ReactNode) => nodes(tree).find((node) => typeof node.type === "function" && "person" in node.props)!;
const person = (element: Element) => { hooks.position = 0; return (element.type as (props: Element["props"]) => ReactNode)(element.props); };

beforeEach(() => { hooks.position = 0; hooks.values = []; hooks.effects = []; vi.clearAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

describe("团队卡的历史与当前动作", () => {
  it("默认收起往来，但收件人的回复/澄清入口在历史之外", () => {
    const entry = personElement(card());
    hooks.values = [];
    const tree = person(entry);
    const history = nodes(tree).find((node) => node.type === "details")!;
    expect(history).toBeDefined();
    expect(history.props.open).not.toBe(true);
    expect(textOf(history.props.children as ReactNode)).toContain("1 条往来");
    expect(button(history.props.children as ReactNode, "回复")).toBeUndefined();
    expect(button(tree, "回复")).toBeDefined();
    expect(button(tree, "缺材料或需澄清")).toBeDefined();
    (button(tree, "回复").props.onClick as () => void)();
    expect(nodes(person(entry)).some((node) => typeof node.type === "function" && node.props.kind === "answered")).toBe(true);
  });

  it("发送人的补充说明与失败逐人重试都在历史之外", async () => {
    const clarification = personElement(card(delivery, true));
    hooks.values = [];
    expect(button(person(clarification), "给小林补充说明")).toBeDefined();
    const failedDelivery = { ...delivery, recipients: [{ ...recipient, status: "failed" as const, error: "稍后重试" }] };
    const failed = personElement(card(failedDelivery, true));
    hooks.values = [];
    const tree = person(failed);
    const history = nodes(tree).find((node) => node.type === "details")!;
    expect(button(history.props.children as ReactNode, "重试给小林的投递")).toBeUndefined();
    api.retry.mockResolvedValue(failedDelivery);
    await (button(tree, "重试给小林的投递").props.onClick as () => Promise<void>)();
    await vi.waitFor(() => expect(saved).toHaveBeenCalledWith(failedDelivery));
    expect(api.retry).toHaveBeenCalledWith("q", "lin");
  });

  it("回复失败重试复用原 clientId，成功后才收起表单", async () => {
    const entry = personElement(card());
    hooks.values = [];
    (button(person(entry), "回复").props.onClick as () => void)();
    const formElement = nodes(person(entry)).find((node) => typeof node.type === "function" && node.props.kind === "answered")!;
    hooks.values = [];
    const renderForm = () => { hooks.position = 0; return (formElement.type as (props: Element["props"]) => ReactNode)(formElement.props); };
    let form = renderForm();
    (nodes(form).find((node) => node.type === "textarea")!.props.onChange as (event: unknown) => void)({ target: { value: "已核对" } });
    api.reply.mockRejectedValueOnce(new Error("回复没能送达"));
    form = renderForm();
    (nodes(form).find((node) => node.type === "form")!.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
    await vi.waitFor(() => expect(textOf(renderForm())).toContain("回复没能送达"));
    api.reply.mockResolvedValue(delivery);
    (nodes(renderForm()).find((node) => node.type === "form")!.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
    await vi.waitFor(() => expect(saved).toHaveBeenCalledWith(delivery));
    expect(api.reply.mock.calls[0][1].clientId).toBe(api.reply.mock.calls[1][1].clientId);
    expect(api.reply.mock.calls[1][1]).toMatchObject({ status: "answered", text: "已核对" });
  });

  it("展开历史后仍按原回复文字转发，资料转发保留安全来源", () => {
    const entry = personElement(card(delivery, true));
    hooks.values = [];
    const tree = person(entry);
    const history = nodes(tree).find((node) => node.type === "details")!;
    (button(history.props.children as ReactNode, "转发这条回复").props.onClick as () => void)();
    expect(forward).toHaveBeenLastCalledWith({ text: "请补成本范围" });
    const share = card({ ...delivery, kind: "share", sourceUrl: "https://example.org/original" });
    (button(share, "转发文字和来源").props.onClick as () => void)();
    expect(forward).toHaveBeenLastCalledWith({ text: "给出反馈", sourceUrl: "https://example.org/original" });
  });
});

describe("回复深链", () => {
  it("加载及 hashchange 都展开全部祖先，然后聚焦和定位；不处理其他卡的目标", () => {
    const events = new Map<string, () => void>();
    const outer = { tagName: "DETAILS", open: false, parentElement: null };
    const history = { tagName: "DETAILS", open: false, parentElement: outer };
    const target = { parentElement: history, focus: vi.fn(), scrollIntoView: vi.fn() };
    const container = { contains: vi.fn((value: unknown) => value === target) };
    const location = { hash: "#team-reply-reply-1" };
    vi.stubGlobal("window", { location, requestAnimationFrame: vi.fn((callback: () => void) => { callback(); return 1; }), cancelAnimationFrame: vi.fn(),
      addEventListener: vi.fn((name: string, callback: () => void) => events.set(name, callback)), removeEventListener: vi.fn() });
    vi.stubGlobal("document", { getElementById: vi.fn(() => target) });
    const tree = card();
    const ref = (tree.props as { ref?: { current: unknown } }).ref;
    expect(ref).toBeDefined();
    ref!.current = container;
    const cleanups = hooks.effects.map((effect) => effect());
    expect(history.open).toBe(true); expect(outer.open).toBe(true);
    expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    history.open = false; outer.open = false;
    events.get("hashchange")!();
    expect(history.open).toBe(true); expect(outer.open).toBe(true);
    target.focus.mockClear(); container.contains.mockReturnValue(false);
    events.get("hashchange")!();
    expect(target.focus).not.toHaveBeenCalled();
    location.hash = "#team-reply-%E0%A4%A";
    expect(() => events.get("hashchange")!()).not.toThrow();
    cleanups.forEach((cleanup) => cleanup?.());
    expect(window.removeEventListener).toHaveBeenCalledWith("hashchange", expect.any(Function));
  });

  it("回复晚到时重试当前深链，同一回复的普通刷新不重复夺走焦点", () => {
    let available = false;
    const history = { tagName: "DETAILS", open: false, parentElement: null };
    const target = { parentElement: history, focus: vi.fn(), scrollIntoView: vi.fn() };
    vi.stubGlobal("window", { location: { hash: "#team-reply-reply-1" }, requestAnimationFrame: (callback: () => void) => { callback(); return 1; },
      cancelAnimationFrame: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal("document", { getElementById: vi.fn(() => available ? target : null) });
    const initial = card({ ...delivery, recipients: [{ ...recipient, replies: [] }] });
    (initial.props as { ref: { current: unknown } }).ref.current = { contains: () => true };
    hooks.effects.splice(0).forEach((effect) => effect());
    expect(target.focus).not.toHaveBeenCalled();
    available = true;
    card();
    hooks.effects.splice(0).forEach((effect) => effect());
    expect(history.open).toBe(true); expect(target.focus).toHaveBeenCalledTimes(1);
    card({ ...delivery, text: "刷新后相同回复" });
    hooks.effects.splice(0).forEach((effect) => effect());
    expect(target.focus).toHaveBeenCalledTimes(1);
  });

  it("已定位 A 后新增无关 B 不重开历史或打断输入，明确重新导航才再次定位", () => {
    const events = new Map<string, () => void>();
    const location = { hash: "#team-reply-reply-1" };
    const history = { tagName: "DETAILS", open: false, parentElement: null };
    const target = { parentElement: history, focus: vi.fn(), scrollIntoView: vi.fn() };
    vi.stubGlobal("window", { location, requestAnimationFrame: (callback: () => void) => { callback(); return 1; }, cancelAnimationFrame: vi.fn(),
      addEventListener: (name: string, callback: () => void) => events.set(name, callback), removeEventListener: vi.fn() });
    vi.stubGlobal("document", { getElementById: () => target });
    const initial = card();
    (initial.props as { ref: { current: unknown } }).ref.current = { contains: () => true };
    hooks.effects.splice(0).forEach((effect) => effect());
    expect(target.focus).toHaveBeenCalledTimes(1); expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
    history.open = false; // The user closes A's history and continues composing elsewhere.
    card({ ...delivery, recipients: [{ ...recipient, replies: [...recipient.replies, { ...recipient.replies[0], id: "reply-B" }] }] });
    hooks.effects.splice(0).forEach((effect) => effect());
    expect(history.open).toBe(false);
    expect(target.focus).toHaveBeenCalledTimes(1); expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
    location.hash = "#conversation";
    events.get("hashchange")!();
    location.hash = "#team-reply-reply-1";
    events.get("hashchange")!();
    expect(history.open).toBe(true);
    expect(target.focus).toHaveBeenCalledTimes(2); expect(target.scrollIntoView).toHaveBeenCalledTimes(2);
  });
});
