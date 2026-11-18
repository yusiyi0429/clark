import { beforeEach, describe, expect, it, vi } from "vitest";

/* 没有 jsdom：圆环当函数调用，hooks 用按调用顺序存值的小仓库代替（同 meetingStart.test），点按钮直接调它的 onPress。 */
const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0,
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[index]) : next;
    }];
  },
}));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useState: hooks.useState }));
vi.mock("./NameTip", () => ({ useHoverTip: () => ({ ref: null, props: {}, tip: null }) }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast", () => ({ showWorkspaceToast: toast }));

import { HeroButton } from "@/components/HeroButton";
import { contextUsage } from "@/lib/local/sessionView";
import { ContextRing } from "./InputFooter";

type Node = { type?: unknown; props?: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  const node = value as Node;
  return node.props ? [node, ...nodes(node.props.children)] : [];
}
const text = (node: Node): string => [node.props?.children].flat(Infinity)
  .map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : child && typeof child === "object" ? text(child as Node) : "")).join("");
const render = (props: Parameters<typeof ContextRing>[0]) => { hooks.index = 0; return nodes(ContextRing(props)); };
const button = (tree: Node[]) => tree.find((node) => node.type === HeroButton)!;

beforeEach(() => { hooks.values = []; toast.mockReset(); });

describe("子会话上下文圆环点开能压缩（本人 11/18）", () => {
  it("点上下文圆环出占用和压缩", async () => {
    // 占用写成「已用 / 上限」，单位万、取整
    const half = contextUsage({ usedTokens: 500_000, maxTokens: 1_000_000 })!;
    expect(half.amount).toBe("50 万 / 100 万");
    expect(contextUsage({ usedTokens: 166_000, maxTokens: 200_000 })!.amount).toBe("17 万 / 20 万");
    let finish: () => void = () => undefined;
    const onCompact = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const tree = render({ ...half, onCompact });
    // 圆环本身是能点的按钮（还是那颗圆环加百分比），点开一个小浮层：两行，占用和「压缩」，不写别的
    const trigger = tree.find((node) => node.props?.["data-testid"] === "context-usage")!;
    expect(trigger.props!["aria-label"]).toBe("上下文 50%，50 万 / 100 万");
    expect(text(trigger)).toBe("50%");
    const pop = tree.find((node) => node.props?.["data-testid"] === "context-pop")!;
    expect(text(pop)).toBe("50 万 / 100 万压缩");
    expect(button(tree).props!.isDisabled).toBe(false);
    // 点压缩：进行中照现有按钮的写法（点不了、写「正在压缩」），压完回来
    (button(tree).props!.onPress as () => void)();
    expect(onCompact).toHaveBeenCalledTimes(1);
    expect(button(render({ ...half, onCompact })).props).toMatchObject({ isDisabled: true, children: "正在压缩" });
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 压完以后圆环跟着新占用（调用方换了 context）
    const after = render({ ...contextUsage({ usedTokens: 30_000, maxTokens: 1_000_000 })!, onCompact });
    expect(button(after).props).toMatchObject({ isDisabled: false, children: "压缩" });
    expect(text(after.find((node) => node.props?.["data-testid"] === "context-pop")!)).toBe("3 万 / 100 万压缩");
    // 会话在跑一轮时点不了
    expect(button(render({ ...half, busy: true, onCompact })).props!.isDisabled).toBe(true);
    // 没压成：一句「没压缩成」
    const failing = vi.fn(async () => { throw new Error("409"); });
    (button(render({ ...half, onCompact: failing })).props!.onPress as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toast).toHaveBeenCalledWith({ text: "没压缩成" });
    // 不能压（别的电脑上看）时照旧只是一颗圆环，没有浮层
    expect(render({ ...half }).some((node) => node.props?.["data-testid"] === "context-pop")).toBe(false);
  });
});
