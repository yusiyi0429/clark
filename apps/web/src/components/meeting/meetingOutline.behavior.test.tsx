import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0,
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[index]) : next;
    }];
  },
}));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()),
  useState: hooks.useState, useEffect: () => undefined, useLayoutEffect: () => undefined, useCallback: (fn: unknown) => fn,
  useRef: (initial: unknown) => ({ current: initial }), useId: () => "toc-panel" }));

import { MeetingOutline, pickOutline, type OutlineActive, type OutlineItem } from "./MeetingOutline";

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

const items: OutlineItem[] = [
  { key: "overview", label: "会议概况", short: "会议概况", hint: "建议补充后上会" },
  { key: "issue:a", label: "是否把验收清单前置", short: "议题 1 / 2", hint: "待决定", tone: "pending",
    children: [{ key: "issue:a:judgment", label: "核心判断" }, { key: "issue:a:history", label: "历史与变化" }] },
  { key: "issue:b", label: "华东渠道补贴", short: "议题 2 / 2", hint: "已决定", tone: "decided", children: [{ key: "issue:b:judgment", label: "核心判断" }] },
];
const onJump = vi.fn();
const render = (active: OutlineActive = { key: "issue:a", sub: "issue:a:history" }) => {
  hooks.index = 0;
  return MeetingOutline({ items, active, onJump, label: "议题目录" });
};
const toggleOf = (tree: unknown) => nodes(tree).find((node) => node.type === "button" && node.props?.["aria-expanded"] !== undefined)!;
const panelOf = (tree: unknown) => nodes(tree).find((node) => node.props?.role === "dialog");

beforeEach(() => {
  hooks.values = [];
  vi.clearAllMocks();
});

describe("目录（feedback 10）", () => {
  it("窄屏：一颗「目录」钮写着当前位置；点开浮层列出章节，当前议题展开小节；点一项定位并收起", () => {
    let tree = render();
    const toggle = toggleOf(tree);
    expect(toggle.props!["aria-expanded"]).toBe(false);
    expect(text(toggle)).toBe("目录议题 1 / 2");
    expect(panelOf(tree)).toBeUndefined();

    (toggle.props!.onClick as () => void)();
    tree = render();
    expect(toggleOf(tree).props!["aria-expanded"]).toBe(true);
    const panel = panelOf(tree)!;
    expect(panel.props!["aria-label"]).toBe("议题目录");
    const choices = nodes(panel).filter((node) => node.type === "button");
    // 只有当前议题展开小节；别的议题不展开，目录不变长。
    expect(choices.map(text)).toEqual(["会议概况建议补充后上会", "是否把验收清单前置待决定", "核心判断", "历史与变化", "华东渠道补贴已决定"]);
    expect(choices[1].props!["aria-current"]).toBe("location");
    expect(choices[3].props!["data-active"]).toBe(true);

    (choices[3].props!.onClick as () => void)();
    expect(onJump).toHaveBeenCalledWith("issue:a", "issue:a:history");
    tree = render();
    expect(panelOf(tree)).toBeUndefined();

    (toggleOf(tree).props!.onClick as () => void)();
    (nodes(panelOf(render())).filter((node) => node.type === "button")[4].props!.onClick as () => void)();
    expect(onJump).toHaveBeenLastCalledWith("issue:b");
  });

  it("宽屏：同一份目录放在左侧 nav 里，高亮当前议题", () => {
    const tree = render({ key: "issue:b", sub: null });
    const nav = nodes(tree).find((node) => node.type === "nav")!;
    expect(nav.props!["aria-label"]).toBe("议题目录");
    const choices = nodes(nav).filter((node) => node.type === "button");
    expect(choices.filter((node) => node.props!["data-active"] === true).map(text)).toEqual(["华东渠道补贴已决定"]);
    (choices[0].props!.onClick as () => void)();
    expect(onJump).toHaveBeenCalledWith("overview");
  });

  it("scroll-spy：取最后一个越过页头分界线的章节；滚到底时取最后一个露出来的章节", () => {
    const sections = [{ key: "overview", top: -400 }, { key: "issue:a", top: 20 }, { key: "issue:b", top: 700 }];
    expect(pickOutline(sections, 80, false, 900)).toBe("issue:a");
    expect(pickOutline(sections, 80, true, 900)).toBe("issue:b");
    expect(pickOutline([{ key: "overview", top: 300 }], 80, false, 900)).toBe("overview");
    expect(pickOutline([], 80, false, 900)).toBeNull();
  });
});
