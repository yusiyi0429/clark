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

import { AccountMenu } from "./AccountMenu";

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
  await vi.waitFor(() => expect(api.GET).toHaveBeenCalledTimes(2));
  await Promise.resolve();
  return render(role);
}

afterEach(() => { hooks.reset(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("个人菜单视角和首次引导", () => {
  it("只给双身份者显示切换，未配置声纹时隐藏入口；成功后整页去 DRI 工作台", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    api.GET.mockImplementation(async (path: string) => ({ response: { ok: true }, data: path === "/api/auth/session"
      ? { authenticated: true, canSwitchView: true } : { configured: false } }));
    api.POST.mockResolvedValue({ response: { ok: true } });
    const tree = await open();
    expect(item(tree, "我的声纹")).toBeUndefined();
    expect(item(tree, "切换到 DRI 工作台")).toBeDefined();
    (item(tree, "切换到 DRI 工作台")!.props.onPress as () => void)();
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
    expect(item(tree, "切换到 CEO 工作台")).toBeUndefined();
    (item(tree, "重看首次引导")!.props.onPress as () => void)();
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("/welcome"));
    expect(api.DELETE).toHaveBeenCalledWith("/api/me/onboarding/complete");
  });
});
