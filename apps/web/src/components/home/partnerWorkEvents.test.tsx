import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TPartnerWorkEvent } from "@warmap/contracts";

/** 没有 jsdom：带 data-testid 的元素的 props 从 JSX 运行时截下来，直接调它们的处理器（同 threadChip.test）。 */
const tap = vi.hoisted(() => ({ props: new Map<string, Record<string, unknown>[]>() }));
const capture = vi.hoisted(() => <T,>(fn: T) => ((type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
  if (typeof props?.["data-testid"] === "string") tap.props.set(props["data-testid"] as string, [...(tap.props.get(props["data-testid"] as string) ?? []), props]);
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

import type { SubSession } from "@/lib/home/types";
import { workEventBlocks } from "./PartnerWorkEvents";
import type { SideDetail } from "./SideDetail";
import { rightOpener } from "./ThreadChip";

const event = (extra: Partial<TPartnerWorkEvent> = {}): TPartnerWorkEvent => ({
  id: "e1", at: "2026-11-18T02:00:00.000Z", projectId: "p1", projectName: "品牌建设", title: "首页换深色", detail: "卡在字体授权",
  subjectKind: "topic", subjectId: "t1", waitingId: null, ...extra,
});
const sub = { id: "t1", kind: "topic" } as SubSession;
const side = () => ({ open: false, toggle: vi.fn(), node: null, shown: null, show: vi.fn(), wide: false, setWide: vi.fn(), openThread: vi.fn() }) as SideDetail & { openThread: ReturnType<typeof vi.fn> };
const text = (html: string) => html.replace(/<[^>]+>/g, "").trim();
const lines = (items: TPartnerWorkEvent[], go = vi.fn(), open?: Parameters<typeof workEventBlocks>[3]) => {
  tap.props.clear();
  return workEventBlocks(items, [], go, open).map((block) => renderToStaticMarkup(<>{block.node}</>));
};
const click = (index = 0) => (tap.props.get("work-event")?.[index]?.onClick as () => void)();

describe("主线里的会话事件（本人 11/18）", () => {
  it("主线事件行：电脑上点了在右边开，不跳走；首页数据里找不到的照旧跳", () => {
    // 电脑上、首页数据里有这个会话：在右边开；从主线开的带上项目名。
    const panel = side();
    const go = vi.fn();
    lines([event({ fromMain: true })], go, rightOpener(panel, [sub]));
    click();
    expect(panel.openThread).toHaveBeenCalledWith({ kind: "topic", id: "t1" }, "品牌建设");
    expect(go).not.toHaveBeenCalled();
    // 不是从主线开的：照样在右边开，不带项目名。
    const plain = side();
    lines([event()], go, rightOpener(plain, [sub]));
    click();
    expect(plain.openThread).toHaveBeenCalledWith({ kind: "topic", id: "t1" }, undefined);
    // 首页数据里找不到（卡、别的会话）：照旧跳过去。
    const missing = side();
    lines([event({ subjectKind: "card", subjectId: "c9" })], go, rightOpener(missing, [sub]));
    click();
    expect(missing.openThread).not.toHaveBeenCalled();
    expect(go).toHaveBeenCalledWith("/me/work/cards/c9");
    // 手机上（没有右边的面板位）、不给打开函数：照旧跳。
    const phone = vi.fn();
    lines([event()], phone, rightOpener(null, [sub]));
    click();
    expect(phone).toHaveBeenCalledWith("/me/work/topics/t1");
    const bare = vi.fn();
    lines([event()], bare);
    click();
    expect(bare).toHaveBeenCalledWith("/me/work/topics/t1");
  });

  it("做完一轮的行：项目名 · 会话名 · 做完一轮：摘要；没有摘要不带冒号", () => {
    const [withSummary, noSummary, stuck] = lines([
      event({ id: "a", done: true, fromMain: true, detail: "换好了深色，等你看一眼" }),
      event({ id: "b", done: true, fromMain: true, detail: "" }),
      event({ id: "c", fromMain: true }),
    ]);
    expect(text(withSummary!)).toBe("品牌建设 · 首页换深色 · 做完一轮：换好了深色，等你看一眼");
    expect(text(noSummary!)).toBe("品牌建设 · 首页换深色 · 做完一轮");
    // 卡住、提问那几条照旧：项目名 · 会话名 · 说明。
    expect(text(stuck!)).toBe("品牌建设 · 首页换深色 · 卡在字体授权");
    // 不出省略号：长摘要放不下就换行，原样全写。
    const long = "换好了深色".repeat(40);
    expect(text(lines([event({ done: true, detail: long })])[0]!)).toContain(long);
    expect(text(lines([event({ done: true, detail: long })])[0]!)).not.toContain("…");
  });
});
