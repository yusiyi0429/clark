import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { TFriendView } from "@warmap/contracts";

// 同步的钩子：useState 按位置存值，useEffect 依赖变了才跑（读数据靠它）。
const hooks = vi.hoisted(() => ({
  position: 0, values: [] as unknown[],
  useState(initial: unknown) {
    const key = hooks.position++;
    if (!(key in hooks.values)) hooks.values[key] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[key], (next: unknown) => { hooks.values[key] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[key]) : next; }];
  },
  useEffect(effect: () => unknown, deps?: unknown[]) {
    const key = hooks.position++;
    const before = hooks.values[key] as unknown[] | undefined;
    if (before && deps && deps.every((dep, index) => Object.is(dep, before[index]))) return;
    hooks.values[key] = deps ?? [];
    effect();
  },
}));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useState: hooks.useState, useEffect: hooks.useEffect }));

/** 没有 jsdom：带 data-testid 的原生元素的 props 从 JSX 运行时截下来，直接调它们的处理器。 */
const tap = vi.hoisted(() => ({ props: new Map<string, Record<string, unknown>[]>() }));
const capture = vi.hoisted(() => <T,>(fn: T) => ((type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
  const id = props?.["data-testid"];
  if (typeof type === "string" && typeof id === "string") tap.props.set(id, [...(tap.props.get(id) ?? []), props]);
  return (fn as unknown as (...args: unknown[]) => unknown)(type, props, ...rest);
}) as unknown as T);
vi.mock("react/jsx-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-runtime")>();
  return { ...actual, jsx: capture(actual.jsx), jsxs: capture(actual.jsxs) };
});
vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-dev-runtime")>();
  return { ...actual, jsxDEV: capture(actual.jsxDEV) };
});
vi.mock("@/components/HeroButton", () => ({
  HeroButton: ({ onPress, isDisabled, children, ...rest }: { onPress?: () => void; isDisabled?: boolean; children: ReactNode }) =>
    <button type="button" disabled={isDisabled} onClick={onPress} {...rest}>{children}</button>,
}));

const api = vi.hoisted(() => ({
  readFriend: vi.fn(), acceptFriend: vi.fn(), setFriendGrant: vi.fn(), removeFriend: vi.fn(), requestFriend: vi.fn(),
  readFriendSettings: vi.fn(), saveFriendSettings: vi.fn(),
}));
vi.mock("@/lib/home/colleagueChats", async (original) => ({ ...(await original<typeof import("@/lib/home/colleagueChats")>()), ...api }));
import { FriendPanel, FriendRequestView, FriendSettingsSections, GrantRows } from "./FriendSheet";
import { useHomeRefreshEvents } from "./HomeShell";
import { COLLEAGUE_CHATS_CHANGED } from "@/lib/home/colleagueChats";
import { TEAM_DELIVERY_CHANGED } from "@/lib/home/teamDelivery";

const person = { personId: "p", displayName: "晨星", left: false };
const friend = (fields: Partial<TFriendView>): TFriendView => ({ person, relation: "friends", theirs: { agentAsk: true }, mine: { agentAsk: true }, ...fields });
const render = (node: ReactNode) => { hooks.position = 0; tap.props.clear(); return renderToStaticMarkup(<>{node}</>); };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
/** 带 onChange / onClick 的那一个（只看的勾选框没有）。 */
const handler = (id: string, name: "onChange" | "onClick") => {
  const found = (tap.props.get(id) ?? []).find((props) => typeof props[name] === "function");
  expect(found, `${id} 没有 ${name}`).toBeTruthy();
  return found![name] as (event?: unknown) => unknown;
};

beforeEach(() => {
  hooks.position = 0; hooks.values = []; tap.props.clear();
  vi.resetAllMocks();
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

describe("好友：勾选单、有人加我、加好友设置、好友面板", () => {
  it("勾选单：锁定两行没有勾选框，只有『他的伙伴替他来问』能勾，没做出来的行不画", () => {
    const html = render(<GrantRows value={{ agentAsk: true }} onChange={() => undefined} />);
    expect(html.match(/data-locked/g)).toHaveLength(2);
    expect(html.match(/type="checkbox"/g)).toHaveLength(1);
    for (const word of ["问我的伙伴", "读我放出来的资料", "他的伙伴替他来问"]) expect(html).toContain(word);
    for (const word of ["给我派活", "先验一遍", "约我的时间"]) expect(html).not.toContain(word);
  });

  it("有人加我：『开放』带上勾的结果，『暂不』调删除", async () => {
    api.readFriend.mockResolvedValue(friend({ relation: "pending_in", theirs: null, mine: null }));
    api.readFriendSettings.mockResolvedValue({ admission: "auto", defaults: { agentAsk: true } });
    api.acceptFriend.mockResolvedValue(friend({}));
    api.removeFriend.mockResolvedValue(friend({ relation: "none", theirs: null, mine: null }));
    const go = vi.fn();
    render(<FriendRequestView personId="p" go={go} />);
    await flush();
    const html = render(<FriendRequestView personId="p" go={go} />);
    expect(html).toContain("晨星 想加你好友");
    expect(html).toContain("开放给晨星");
    handler("grant-agent-ask", "onChange")({ target: { checked: false } });
    render(<FriendRequestView personId="p" go={go} />);
    handler("friend-open", "onClick")();
    await flush();
    expect(api.acceptFriend).toHaveBeenCalledWith("p", { agentAsk: false });
    expect(go).toHaveBeenCalledWith("/me/work/chats/with/p");
    render(<FriendRequestView personId="p" go={go} />);
    handler("friend-later", "onClick")();
    await flush();
    expect(api.removeFriend).toHaveBeenCalledWith("p");
  });

  it("加好友设置：两档单选，缺省直接通过，改了就存", async () => {
    api.readFriendSettings.mockResolvedValue({ admission: "auto", defaults: { agentAsk: true } });
    api.saveFriendSettings.mockImplementation(async (settings: unknown) => settings);
    render(<FriendSettingsSections />);
    await flush();
    const html = render(<FriendSettingsSections />);
    expect(html).toMatch(/加我好友[\s\S]*直接通过[\s\S]*要我同意[\s\S]*新好友默认开放[\s\S]*他的伙伴替他来问/);
    expect(html).toMatch(/<input[^>]*data-testid="admission-auto"[^>]*checked=""/);
    expect(html).not.toMatch(/<input[^>]*data-testid="admission-approve"[^>]*checked=""/);
    handler("admission-approve", "onChange")();
    await flush();
    expect(api.saveFriendSettings).toHaveBeenCalledWith({ admission: "approve", defaults: { agentAsk: true } });
  });

  it("好友面板：两列，改我的那列调 grant，最下面『删除好友』", async () => {
    api.readFriend.mockResolvedValue(friend({}));
    api.setFriendGrant.mockResolvedValue(friend({ mine: { agentAsk: false } }));
    render(<FriendPanel personId="p" onClose={() => undefined} />);
    await flush();
    const html = render(<FriendPanel personId="p" onClose={() => undefined} />);
    expect(html).toMatch(/他开给我的[\s\S]*我开给他的[\s\S]*删除好友/);
    handler("grant-agent-ask", "onChange")({ target: { checked: false } });
    await flush();
    expect(api.setFriendGrant).toHaveBeenCalledWith("p", { agentAsk: false });
  });

  it("首页跟着同事对话变了重读：办完好友请求、回了一句，「等你」那一行跟着消掉", () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const refresh = vi.fn();
    hooks.position = 0;
    useHomeRefreshEvents(refresh);
    target.dispatchEvent(new Event(COLLEAGUE_CHATS_CHANGED));
    expect(refresh).toHaveBeenCalledTimes(1);
    target.dispatchEvent(new Event(TEAM_DELIVERY_CHANGED));
    expect(refresh).toHaveBeenCalledTimes(2);
    // 重画一次不重复挂（不然一次变化重读好几遍）。
    hooks.position = 0;
    useHomeRefreshEvents(refresh);
    target.dispatchEvent(new Event(COLLEAGUE_CHATS_CHANGED));
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
