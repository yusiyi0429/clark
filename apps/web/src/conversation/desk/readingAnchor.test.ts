import { afterEach, describe, expect, it, vi } from "vitest";
import { captureReadingAnchor, holdReadingAnchor, materialScroller, restoreReadingAnchor } from "./readingAnchor";

/** 假的滚动区：块的位置 = 布局位置 − scrollTop + 滚动区上沿；layout() 模拟变窄后重排（每块往下挪）。 */
function page({ scrollTop = 400, blocks = [[0, 100], [100, 300], [300, 340], [340, 600]] as [number, number][] } = {}) {
  const top = 60;
  const nodes = blocks.map(([start, end], index) => ({
    id: index, start, end, isConnected: true,
    getBoundingClientRect: () => ({ top: top + nodes[index].start - scroller.scrollTop, bottom: top + nodes[index].end - scroller.scrollTop, height: nodes[index].end - nodes[index].start }),
    contains: (other: unknown) => other === nodes[index] || (index === 1 && other === nodes[2]),
  }));
  const scroller = {
    scrollTop, scrollHeight: 2000, clientHeight: 600,
    getBoundingClientRect: () => ({ top, bottom: top + 600, height: 600 }),
    querySelectorAll: () => nodes,
    querySelector: () => null,
    scrollTo: vi.fn(({ top: value }: { top: number }) => { scroller.scrollTop = value; }),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  };
  /** 变窄：内容整体重排，第 n 块之前多出 extra。 */
  const reflow = (extra: number) => nodes.forEach((node) => { node.start += extra * (node.id + 1); node.end += extra * (node.id + 1); });
  return { scroller: scroller as unknown as HTMLElement & typeof scroller, nodes, reflow };
}

afterEach(() => vi.unstubAllGlobals());

describe("左侧材料的阅读位置（展开 / 收起深度讨论）", () => {
  it("记下视口顶上那一段（最深的那一块）和它离滚动区上沿多远", () => {
    const { scroller, nodes } = page({ scrollTop: 310 });
    // 视口顶在 310：第 1 块（100–300）已经滚过去；第 2 块之内的第 3 块（300–340）跨过顶线。
    const anchor = captureReadingAnchor(scroller, 0)!;
    expect(anchor.element).toBe(nodes[2]);
    expect(anchor.offset).toBe(-10);
  });

  it("吸顶的块（会议页的议题目录）不当锚：它不随内容走，拿它校正会把左侧滚飞", () => {
    const { scroller, nodes } = page({ scrollTop: 310 });
    // 第 0 块换成吸顶目录里的一行：一直贴在顶上（跨过顶线），文档顺序又在最前。
    const nav = { position: "sticky", parentElement: scroller };
    Object.assign(nodes[0], { parentElement: nav, getBoundingClientRect: () => ({ top: 50, bottom: 90, height: 40 }) });
    nodes.slice(1).forEach((node) => Object.assign(node, { parentElement: scroller }));
    vi.stubGlobal("getComputedStyle", (element: { position?: string }) => ({ position: element.position ?? "static" }));
    const anchor = captureReadingAnchor(scroller, 0)!;
    expect(anchor.element).toBe(nodes[2]);
    expect(anchor.offset).toBe(-10);
  });

  it("还在顶部（没滚过）不用记", () => {
    expect(captureReadingAnchor(page({ scrollTop: 0 }).scroller, 0)).toBeNull();
  });

  it("重排后把那一段放回原来的偏移（瞬时，不走 smooth）", () => {
    const { scroller, reflow } = page({ scrollTop: 310 });
    const anchor = captureReadingAnchor(scroller, 0)!;
    reflow(40);
    restoreReadingAnchor(anchor);
    expect(scroller.scrollTo).toHaveBeenLastCalledWith({ top: 310 + 120, behavior: "instant" });
    expect(anchor.element.getBoundingClientRect().top - 60).toBe(-10);
  });

  it("宽度过渡期间每一帧放回；用户自己滚了就放手", () => {
    const frames: (() => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { scroller, reflow } = page({ scrollTop: 310 });
    const stop = holdReadingAnchor(captureReadingAnchor(scroller, 0)!, 10_000);
    reflow(10); frames.shift()!();
    expect(scroller.scrollTop).toBe(340);
    expect(scroller.addEventListener).toHaveBeenCalledWith("wheel", stop, { passive: true });
    stop();
    reflow(10); frames.shift()?.();
    expect(scroller.scrollTop).toBe(340);
    expect(scroller.removeEventListener).toHaveBeenCalledWith("wheel", stop);
  });

  it("材料区里找真正在滚的那一层；都不能滚就不管", () => {
    vi.stubGlobal("getComputedStyle", (element: { overflow: string }) => ({ overflowY: element.overflow }));
    const still = { scrollHeight: 500, clientHeight: 500, overflow: "auto" };
    const hidden = { scrollHeight: 900, clientHeight: 500, overflow: "hidden" };
    const scrolling = { scrollHeight: 900, clientHeight: 500, overflow: "auto" };
    const panel = (items: unknown[]) => ({ querySelectorAll: () => items }) as unknown as ParentNode;
    expect(materialScroller(panel([still, hidden, scrolling]), [".ts-detail"])).toBe(scrolling);
    expect(materialScroller(panel([still, hidden]), [".ts-detail"])).toBeNull();
    expect(materialScroller(null, [".ts-detail"])).toBeNull();
  });
});
