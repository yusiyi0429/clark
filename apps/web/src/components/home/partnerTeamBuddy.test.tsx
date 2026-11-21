import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TTeamDelivery, TTeamDeliveryRecipient, TTeamDeliveryReply } from "@warmap/contracts";

// 同 partnerTeamCard.behavior.test.tsx：用同步的 hook 替身直接调组件和它的回调，不起浏览器。
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
const api = vi.hoisted(() => ({ reply: vi.fn(), review: vi.fn(), seen: vi.fn(), retryBuddy: vi.fn(), askOwner: vi.fn() }));
vi.mock("@/lib/home/teamDelivery", async (original) => ({ ...(await original<typeof import("@/lib/home/teamDelivery")>()),
  replyTeamDelivery: api.reply, reviewBuddyReply: api.review, markCorrectionSeen: api.seen, retryTeamBuddy: api.retryBuddy, askTeamOwner: api.askOwner,
}));
import { TeamDeliveryCard, buddyLabel, recipientWord } from "./PartnerTeamCard";
import { FAST_FREQUENCY, feedInterval } from "./PartnerTeam";

type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Children.toArray(node).flatMap((child) => isValidElement(child)
  ? [child as Element, ...nodes((child.props as { children?: ReactNode }).children)] : []);
const textOf = (node: ReactNode): string => Children.toArray(node).map((child) => isValidElement(child)
  ? textOf((child.props as { children?: ReactNode }).children) : String(child ?? "")).join("");
const button = (tree: ReactNode, label: string) => nodes(tree).find((node) => node.type === "button" && textOf(node.props.children as ReactNode) === label);
const link = (tree: ReactNode, label: string) => nodes(tree).find((node) => node.type === "a" && textOf(node.props.children as ReactNode) === label);
const click = (tree: ReactNode, label: string) => (button(tree, label)!.props.onClick as () => unknown)();
const history = (tree: ReactNode) => nodes(tree).find((node) => node.type === "details");

const at = "2026-11-20T04:00:00.000Z";
const buddyReply: TTeamDeliveryReply = { id: "reply-b", status: "answered", origin: "buddy", text: "按四件拆，出处：部署报告（11/18）", attachments: [], createdAt: at };
const base: TTeamDeliveryRecipient = { personId: "lin", displayName: "晨星", status: "pending", error: null, replies: [] };
const answered: TTeamDeliveryRecipient = { ...base, buddy: { state: "answered", note: null, askedAt: at }, replies: [buddyReply] };
const delivery = (recipient: TTeamDeliveryRecipient): TTeamDelivery => ({ id: "q", kind: "question", text: "部署要拆几件？", sender: { personId: "me", displayName: "明华" },
  createdAt: at, dueAt: null, sourceUrl: null, attachments: [], recipients: [recipient] });
const saved = vi.fn();
const card = (recipient: TTeamDeliveryRecipient, sent: boolean) => { hooks.position = 0; return TeamDeliveryCard({ delivery: delivery(recipient), sent, onSaved: saved, onForward: vi.fn() }); };
const personElement = (tree: ReactNode) => nodes(tree).find((node) => typeof node.type === "function" && "person" in node.props)!;
const person = (element: Element) => { hooks.position = 0; return (element.type as (props: Element["props"]) => ReactNode)(element.props); };
/** 渲染一位收件人那一行（每次从空状态开始），回一个能重画的函数。 */
const row = (recipient: TTeamDeliveryRecipient, sent: boolean) => {
  const entry = personElement(card(recipient, sent));
  hooks.values = [];
  return () => person(entry);
};
const sub = (tree: ReactNode, has: string) => nodes(tree).find((node) => typeof node.type === "function" && has in node.props)!;
const renderSub = (element: Element) => { hooks.position = 0; return (element.type as (props: Element["props"]) => ReactNode)(element.props); };
const type = (tree: ReactNode, value: string) => (nodes(tree).find((node) => node.type === "textarea")!.props.onChange as (event: unknown) => void)({ target: { value } });
const submit = (tree: ReactNode) => (nodes(tree).find((node) => node.type === "form")!.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });

beforeEach(() => { hooks.position = 0; hooks.values = []; hooks.effects = []; vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("卡上的伙伴答复", () => {
  it("标记的三种说法，发起人和被问的人各一套", () => {
    expect(buddyLabel("晨星", "unseen")).toBe("晨星的伙伴答的，晨星还没看");
    expect(buddyLabel("晨星", "seen")).toBe("晨星的伙伴答的，晨星看过了");
    expect(buddyLabel("晨星", "corrected")).toBe("晨星的伙伴答的，晨星改过");
    expect(buddyLabel("你", "unseen")).toBe("你的伙伴答的，你还没看");
  });

  it("状态词：伙伴在答带已等的时间，转本人带原因，别的照旧", () => {
    const now = Date.parse("2026-11-20T04:00:12Z");
    expect(recipientWord({ ...base, status: "pending", buddy: { state: "answering", note: null, askedAt: "2026-11-20T04:00:00Z" } }, now)).toBe("伙伴在答 · 12 秒");
    expect(recipientWord({ ...base, status: "pending", buddy: { state: "answering", note: null, askedAt: "2026-11-20T03:58:55Z" } }, now)).toBe("伙伴在答 · 1 分 17 秒");
    expect(recipientWord({ ...base, status: "pending", buddy: { state: "handoff", note: "值守安排要本人定", askedAt: "2026-11-20T04:00:00Z", handoffBy: "buddy" } }, now)).toBe("转本人 · 待回复");
    expect(recipientWord({ ...base, status: "answered", buddy: { state: "answered", note: null, askedAt: "2026-11-20T04:00:00Z" } }, now)).toBe("已回复");
    expect(recipientWord({ ...base, status: "pending" }, now)).toBe("已送达 · 待回复");
    // 伙伴答了不算本人回了（A8）
    expect(recipientWord(answered, now)).toBe("已送达 · 待回复");
  });

  it("伙伴答的按 origin 标成伙伴答的，不写成本人回复；被问的人自己看名字换成「你」", () => {
    const sent = row(answered, true)();
    expect(textOf(history(sent)!.props.children as ReactNode)).toContain("晨星的伙伴答的，晨星还没看");
    expect(textOf(sent)).not.toContain("晨星 · 回复");
    expect(textOf(row(answered, false)())).toContain("你的伙伴答的，你还没看");
    const reviewed = { ...answered, replies: [{ ...buddyReply, reviewedAt: at }] };
    expect(textOf(row(reviewed, true)())).toContain("晨星的伙伴答的，晨星看过了");
    const correction: TTeamDeliveryReply = { id: "reply-c", status: "answered", text: "要拆五件", attachments: [], createdAt: at, corrects: "reply-b" };
    const corrected = textOf(row({ ...answered, status: "answered", replies: [{ ...buddyReply, reviewedAt: at }, correction] }, true)());
    expect(corrected).toContain("晨星的伙伴答的，晨星改过");
    expect(corrected).toContain("晨星 · 更正");
    const followUp: TTeamDeliveryReply = { id: "reply-f", status: "follow_up", text: "那回滚怎么做", attachments: [], createdAt: at };
    expect(textOf(row({ ...answered, replies: [buddyReply, followUp] }, false)())).toContain("明华 · 追问");
  });

  it("发起人：伙伴答过的往来默认展开，有「去对话」；伙伴在答时没有", () => {
    const sent = row(answered, true)();
    expect(history(sent)!.props.open).toBe(true);
    expect(link(sent, "去对话")).toBeDefined();
    const plain = row({ ...base, status: "answered", replies: [{ ...buddyReply, origin: undefined }] }, true)();
    expect(history(plain)!.props.open).not.toBe(true);
    expect(link(plain, "去对话")).toBeUndefined();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-11-20T04:00:12Z"));
    const asking = row({ ...answered, buddy: { state: "answering", note: null, askedAt: at } }, true)();
    expect(link(asking, "去对话")).toBeUndefined();
    expect(textOf(asking)).toContain("伙伴在答 · 12 秒");
    // 被问的人那边没有
    expect(link(row(answered, false)(), "去对话")).toBeUndefined();
  });

  it("旧卡不再出『追问』，原位是『去对话』", () => {
    const html = renderToStaticMarkup(<>{row({ ...answered, personId: "third" }, true)()}</>);
    expect(html).not.toContain(">追问<"); expect(html).toContain('href="/me/work/chats/with/third"'); expect(html).toContain("去对话");
  });

  it("被问的人回复照旧能带附件", async () => {
    const filePicker = (tree: ReactNode) => nodes(tree).find((node) => typeof node.type === "function" && "selection" in node.props);
    const owner = row(answered, false);
    await click(owner(), "回复");
    const reply = sub(owner(), "kind");
    expect(reply.props.kind).toBe("answered");
    hooks.values = [];
    expect(filePicker(renderSub(reply))).toBeDefined();
  });

  it("被问的人：最近一条伙伴答复带「没问题」「改一下」；看过的只剩「改一下」；改过的都没有；发起人那边没有", async () => {
    const render = row(answered, false);
    expect(button(render(), "没问题")).toBeDefined();
    expect(button(render(), "改一下")).toBeDefined();
    api.review.mockResolvedValue(delivery(answered));
    await click(render(), "没问题");
    expect(api.review).toHaveBeenCalledWith("q", "reply-b", { verdict: "ok" });
    await vi.waitFor(() => expect(saved).toHaveBeenCalled());

    // 改一下：一个输入框（更正）和「取消」「提交」；没成重试用同一个 clientId
    await click(render(), "改一下");
    const form = sub(render(), "replyId");
    hooks.values = [];
    let tree = renderSub(form);
    expect(textOf(nodes(tree).find((node) => node.type === "label")!.props.children as ReactNode)).toBe("更正");
    expect(nodes(tree).filter((node) => node.type === "textarea")).toHaveLength(1);
    expect(button(tree, "取消")).toBeDefined();
    type(tree, "要拆五件");
    api.review.mockRejectedValueOnce(new Error("这条已经改过了"));
    submit(renderSub(form));
    await vi.waitFor(() => expect(textOf(renderSub(form))).toContain("这条已经改过了"));
    submit(renderSub(form));
    await vi.waitFor(() => expect(api.review).toHaveBeenCalledTimes(3));
    const [first, second] = [api.review.mock.calls[1], api.review.mock.calls[2]];
    expect(first).toEqual(["q", "reply-b", { clientId: expect.any(String), verdict: "corrected", text: "要拆五件" }]);
    expect(second[2].clientId).toBe(first[2].clientId);

    // 点过没问题以后还能改（A9）
    const reviewed = row({ ...answered, replies: [{ ...buddyReply, reviewedAt: at }] }, false)();
    expect(button(reviewed, "没问题")).toBeUndefined();
    expect(button(reviewed, "改一下")).toBeDefined();
    const correction: TTeamDeliveryReply = { id: "reply-c", status: "answered", text: "要拆五件", attachments: [], createdAt: at, corrects: "reply-b" };
    const corrected = row({ ...answered, replies: [{ ...buddyReply, reviewedAt: at }, correction] }, false)();
    expect(button(corrected, "没问题")).toBeUndefined();
    expect(button(corrected, "改一下")).toBeUndefined();
    // 更早的伙伴答复不带：只看最近一条
    const second2: TTeamDeliveryReply = { ...buddyReply, id: "reply-b2" };
    const twice = row({ ...answered, replies: [buddyReply, { id: "reply-f", status: "follow_up", text: "回滚呢", attachments: [], createdAt: at }, second2] }, false)();
    expect(nodes(twice).filter((node) => node.type === "button" && textOf(node.props.children as ReactNode) === "没问题")).toHaveLength(1);
    await click(twice, "没问题");
    expect(api.review).toHaveBeenLastCalledWith("q", "reply-b2", { verdict: "ok" });

    const sent = row(answered, true)();
    expect(button(sent, "没问题")).toBeUndefined();
    expect(button(sent, "改一下")).toBeUndefined();
  });

  it("转本人：两边都写原因；被问的人那边不放「没问题」，「改一下」照旧", () => {
    const handoff: TTeamDeliveryRecipient = { ...answered, buddy: { state: "handoff", note: "值守安排要本人定", askedAt: at, handoffBy: "buddy" } };
    const mine = row(handoff, false)();
    expect(textOf(mine)).toContain("转本人 · 待回复");
    expect(textOf(mine)).toContain("值守安排要本人定");
    expect(button(mine, "没问题")).toBeUndefined();
    expect(button(mine, "改一下")).toBeDefined();
    const asked = row({ ...handoff, buddy: { ...handoff.buddy!, note: "同事请你本人回", handoffBy: "asker" } }, false)();
    expect(textOf(asked)).toContain("同事请你本人回");
    expect(textOf(row(handoff, true)())).toContain("值守安排要本人定");
  });

  it("转本人还没回：问的人那边没有「去对话」；本人回过以后、或伙伴答完没转本人，照旧有", () => {
    const handoff: TTeamDeliveryRecipient = { ...answered, buddy: { state: "handoff", note: "值守安排要本人定", askedAt: at, handoffBy: "buddy" } };
    expect(link(row(handoff, true)(), "去对话")).toBeUndefined();
    expect(link(row({ ...handoff, buddy: { ...handoff.buddy!, note: "伙伴没答上来", handoffBy: "asker" } }, true)(), "去对话")).toBeUndefined();
    const own: TTeamDeliveryReply = { id: "reply-o", status: "answered", text: "我定了，周五值守", attachments: [], createdAt: at };
    expect(link(row({ ...handoff, status: "answered", replies: [buddyReply, own] }, true)(), "去对话")).toBeDefined();
    expect(link(row(answered, true)(), "去对话")).toBeDefined();
  });

  it("发起人：没点过知道了的更正带「知道了」，点了就调接口；点过的不带；被问的人那边不带", async () => {
    const correction: TTeamDeliveryReply = { id: "reply-c", status: "answered", text: "要拆五件", attachments: [], createdAt: at, corrects: "reply-b" };
    const fresh = { ...answered, status: "answered" as const, replies: [{ ...buddyReply, reviewedAt: at }, correction] };
    api.seen.mockResolvedValue(delivery(fresh));
    await click(row(fresh, true)(), "知道了");
    expect(api.seen).toHaveBeenCalledWith("q", "reply-c");
    await vi.waitFor(() => expect(saved).toHaveBeenCalled());
    expect(button(row({ ...fresh, replies: [fresh.replies[0]!, { ...correction, correctionSeenAt: at }] }, true)(), "知道了")).toBeUndefined();
    expect(button(row(fresh, false)(), "知道了")).toBeUndefined();
  });

  it("没答上来：问的人看到原因和「重试」「问本人」；超上限只给「问本人」；没成写在失败行；被问的人那边没有", async () => {
    const failed: TTeamDeliveryRecipient = { ...base, buddy: { state: "failed", note: "伙伴没答上来", askedAt: at } };
    const render = row(failed, true);
    expect(textOf(render())).toContain("伙伴没答上来");
    api.retryBuddy.mockRejectedValueOnce(new Error("这位同事的伙伴现在不能代答，可以直接问本人"));
    await click(render(), "重试");
    expect(api.retryBuddy).toHaveBeenCalledWith("q", "lin");
    await vi.waitFor(() => expect(nodes(render()).some((node) => node.props.role === "alert" && textOf(node.props.children as ReactNode).includes("可以直接问本人"))).toBe(true));
    api.askOwner.mockResolvedValue(delivery(failed));
    await click(render(), "问本人");
    expect(api.askOwner).toHaveBeenCalledWith("q", "lin");
    await vi.waitFor(() => expect(saved).toHaveBeenCalled());

    const limited = row({ ...base, buddy: { state: "limited", note: "今天问这位同事的伙伴已到 10 次", askedAt: at } }, true)();
    expect(textOf(limited)).toContain("今天问这位同事的伙伴已到 10 次");
    expect(button(limited, "重试")).toBeUndefined();
    expect(button(limited, "问本人")).toBeDefined();

    const mine = row(failed, false)();
    expect(button(mine, "重试")).toBeUndefined();
    expect(button(mine, "问本人")).toBeUndefined();
  });

  it("伙伴在答时每秒重画一次，不在答不起定时器", () => {
    const setInterval = vi.fn(() => 7);
    const clearInterval = vi.fn();
    vi.stubGlobal("window", { location: { hash: "" }, setInterval, clearInterval, addEventListener: vi.fn(), removeEventListener: vi.fn(), requestAnimationFrame: vi.fn(), cancelAnimationFrame: vi.fn() });
    card({ ...answered, buddy: { state: "answering", note: null, askedAt: at } }, true);
    const cleanups = hooks.effects.splice(0).map((effect) => effect());
    expect(setInterval).toHaveBeenCalledTimes(1);
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 1_000);
    cleanups.forEach((cleanup) => cleanup?.());
    expect(clearInterval).toHaveBeenCalledWith(7);
    hooks.values = [];
    card(answered, true);
    hooks.effects.splice(0).forEach((effect) => effect());
    expect(setInterval).toHaveBeenCalledTimes(1);
  });

  it("卡上不出省略号", () => {
    const correction: TTeamDeliveryReply = { id: "reply-c", status: "answered", text: "要拆五件", attachments: [], createdAt: at, corrects: "reply-b" };
    for (const recipient of [answered, { ...answered, replies: [buddyReply, correction] }, { ...base, buddy: { state: "failed" as const, note: "伙伴没答上来", askedAt: at } }]) {
      for (const sent of [true, false]) expect(textOf(row(recipient, sent)())).not.toMatch(/…|\.\.\./);
    }
  });
});

describe("刷新的快慢", () => {
  it("有伙伴在答的卡 3 秒一次，没有 20 秒一次", () => {
    const answering = delivery({ ...answered, buddy: { state: "answering", note: null, askedAt: at } });
    expect(FAST_FREQUENCY).toBe(3_000);
    expect(feedInterval({ sent: [answering], received: [] })).toBe(3_000);
    expect(feedInterval({ sent: [], received: [answering] })).toBe(3_000);
    expect(feedInterval({ sent: [delivery(answered)], received: [delivery(base)] })).toBe(20_000);
  });
});
