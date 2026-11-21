import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const hooks = vi.hoisted(() => {
  let slots: unknown[] = [];
  let cursor = 0;
  return {
    begin() { cursor = 0; },
    reset() { slots = []; cursor = 0; },
    useState<T>(initial: T) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index] as T, (value: T) => { slots[index] = value; }] as const;
    },
  };
});
const api = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn() }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => hooks.useState(initial), useRef: (initial: unknown) => ({ current: initial }), useEffect: () => undefined };
});
vi.mock("@/lib/api/client", () => ({ browserApi: api }));

import { AccountMenu, FeishuConnectItem } from "./AccountMenu";

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function label(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(label).join("");
  return isValidElement(node) ? label((node as Element).props.children as ReactNode) : "";
}
function render(role: "ceo" | "member" = "ceo") {
  hooks.begin();
  return AccountMenu({ account: { displayName: "王路遥", role } });
}
const item = (tree: ReactNode, text: string) => elements(tree).find((element) =>
  typeof element.props.onPress === "function" && label(element.props.children as ReactNode) === text);
async function open(role: "ceo" | "member" = "ceo") {
  const tree = render(role);
  const popover = elements(tree).find((element) => typeof element.props.onOpenChange === "function")!;
  (popover.props.onOpenChange as (next: boolean) => void)(true);
  // 打开时读会话、声纹、飞书连接；数据质量开关一个页面只读一次。
  await vi.waitFor(() => expect(api.GET.mock.calls.length).toBeGreaterThanOrEqual(3));
  await Promise.resolve();
  return render(role);
}

afterEach(() => { hooks.reset(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("个人菜单视角和首次引导", () => {
  it("能切的人菜单里有一组两项「管理模式」「工作模式」，现在这个打勾，后面带等你的条数；点另一个切过去；未配置声纹时隐藏入口", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    api.GET.mockImplementation(async (path: string) => ({ response: { ok: true }, data: path === "/api/auth/session"
      ? { authenticated: true, canSwitchView: true } : path === "/api/me/feishu" ? { enabled: true, connected: false }
      : path === "/api/me/work-home/waiting-count" ? { count: 3 } : { configured: false } }));
    api.POST.mockResolvedValue({ response: { ok: true } });
    const tree = await open();
    expect(item(tree, "我的声纹")).toBeUndefined();
    expect(elements(tree).find((element) => element.type === FeishuConnectItem)?.props).toEqual({ connected: false });
    // 管理模式是现在这个：打勾，点了不动；「工作模式」后面是等你的条数，点了切过去。
    expect(item(tree, "管理模式")!.props["aria-current"]).toBe("true");
    (item(tree, "管理模式")!.props.onPress as () => void)();
    expect(api.POST).not.toHaveBeenCalled();
    const work = item(tree, "工作模式")!;
    expect(work.props["aria-current"]).toBeUndefined();
    expect(elements(work).find((element) => element.props["aria-label"] === "3 件等你")?.props.children).toBe(3);
    expect(elements(tree).filter((element) => typeof element.props.onPress === "function").map((element) => label(element.props.children as ReactNode)).join("|")).not.toContain("切换到");
    (work.props.onPress as () => void)();
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("/me"));
    expect(api.POST).toHaveBeenCalledWith("/api/auth/view", { body: { view: "member" } });
  });

  it("已配置声纹才显示入口；重看引导只删本人完成记录并整页打开引导", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    api.DELETE.mockResolvedValue({ response: { ok: true } });
    api.GET.mockImplementation(async (path: string) => ({ response: { ok: true }, data: path === "/api/auth/session"
      ? { authenticated: true, canSwitchView: false } : { configured: true } }));
    const tree = await open("member");
    expect(item(tree, "我的声纹")).toBeDefined();
    expect(item(tree, "管理模式")).toBeUndefined();
    expect(item(tree, "工作模式")).toBeUndefined();
    expect(api.GET).not.toHaveBeenCalledWith("/api/me/work-home/waiting-count");
    (item(tree, "重看首次引导")!.props.onPress as () => void)();
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("/welcome"));
    expect(api.DELETE).toHaveBeenCalledWith("/api/me/onboarding/complete");
  });
});
