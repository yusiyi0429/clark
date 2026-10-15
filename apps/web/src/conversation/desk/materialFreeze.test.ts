import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deskPlan, MATERIAL_COLUMN, materialWidth } from "./deskLayout";
import { materialColumns, measureSettledColumns, planColumnLocks, settledMaterialWidth, SHIFT_FADE, shiftMaterialColumns } from "./materialFreeze";

function fakeStyle() {
  const props = new Map<string, { value: string; priority: string }>();
  return {
    props,
    setProperty(name: string, value: string, priority = "") { props.set(name, { value, priority }); },
    removeProperty(name: string) { props.delete(name); return ""; },
    getPropertyValue(name: string) { return props.get(name)?.value ?? ""; },
    getPropertyPriority(name: string) { return props.get(name)?.priority ?? ""; },
  };
}

/**
 * 假的左侧材料：面板宽跟着外壳的让位一帧一帧变（naturalWidth）；临时量结束后的宽时按行内 width 算。
 * 阅读列（议题页那种）整宽 = min(656, 面板宽)，锁住时就是锁住的宽。每一帧记一次阅读列宽，变了算一次重排。
 */
function fakeMaterial(naturalWidth: number) {
  const state = { natural: naturalWidth };
  const panelStyle = fakeStyle();
  const panelWidth = () => (panelStyle.props.has("width") ? parseFloat(panelStyle.getPropertyValue("width")) : state.natural);
  const panel = { style: panelStyle, dataset: {} as DOMStringMap };
  const columnStyle = fakeStyle();
  const column = {
    style: columnStyle,
    dataset: {} as DOMStringMap,
    getBoundingClientRect: () => ({ width: columnStyle.props.has("width") ? parseFloat(columnStyle.getPropertyValue("width")) : Math.min(MATERIAL_COLUMN, panelWidth()) }),
  };
  const scroller = { style: fakeStyle() };
  const animations: unknown[] = [];
  const fadeTarget = { animate: (keyframes: Keyframe[]) => { animations.push(keyframes); return {}; } };
  const frames: number[] = [column.getBoundingClientRect().width];
  return {
    panel, column, scroller, fadeTarget, animations, frames,
    /** 外壳让位过渡的一帧：面板宽变到 next，记下这一帧阅读列的宽。 */
    frame(next: number) { state.natural = next; frames.push(column.getBoundingClientRect().width); },
    /** 阅读列宽变了几次。 */
    changes: () => frames.slice(1).filter((width, index) => Math.abs(width - frames[index]) >= 0.5).length,
  };
}

/** 240ms 的让位按 10 帧走完（线性就够：只看阅读列宽变没变）。 */
function animate(f: ReturnType<typeof fakeMaterial>, from: number, to: number, steps = 10) {
  for (let i = 1; i <= steps; i++) f.frame(from + ((to - from) * i) / steps);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("planColumnLocks", () => {
  it("宽度要变的阅读列锁在结束后的宽；都不变就不锁、不算重排", () => {
    expect(planColumnLocks([656, 656], [656, 656.3])).toEqual({ locks: [null, null], reflow: false });
    expect(planColumnLocks([656, 300], [478, 300])).toEqual({ locks: [478, null], reflow: true });
  });
});

describe("settledMaterialWidth", () => {
  it("按此刻的宽与右边距换算新右边距下的宽（过渡中途也对）", () => {
    // 1440：主区 942 + 400 让位 → 深度讨论 686 → 656
    expect(settledMaterialWidth(942, 400, 686)).toBe(656);
    // 过渡到一半（右边距 543、宽 799）反悔收起 → 942
    expect(settledMaterialWidth(799, 543, 400)).toBe(942);
  });
});

describe("measureSettledColumns", () => {
  it("临时把面板设成结束后的宽量阅读列，量完还原面板自己的行内样式", () => {
    const f = fakeMaterial(782);
    f.panel.style.setProperty("right", "4px");
    expect(measureSettledColumns(f.panel, [f.column], 478)).toEqual([478]);
    expect(f.panel.style.getPropertyValue("right")).toBe("4px");
    expect(f.panel.style.props.has("width")).toBe(false);
  });
});

describe("shiftMaterialColumns", () => {
  const run = (viewport: number, direction: "open" | "close") => {
    const plan = deskPlan(viewport)!;
    const collapsed = materialWidth(viewport, viewport >= 1600 ? 440 : 400);
    const [from, to] = direction === "open" ? [collapsed, plan.material] : [plan.material, collapsed];
    const f = fakeMaterial(from);
    const onReflow = vi.fn();
    shiftMaterialColumns(f.panel, [f.column], to, 260, { onReflow, scroller: f.scroller, fadeTarget: f.fadeTarget });
    const firstFrame = f.column.getBoundingClientRect().width;
    animate(f, from, to);
    vi.advanceTimersByTime(260);
    const settledFrames = f.frames.length;
    f.frame(to);
    f.frame(to);
    return { f, onReflow, firstFrame, settledFrames, plan, from, to };
  };

  it("A 档（1440 / 1600 / 1920）：展开、收起阅读列宽度都不变，不锁、不淡入、不放回", () => {
    for (const viewport of [1440, 1600, 1920]) {
      for (const direction of ["open", "close"] as const) {
        const { f, onReflow, plan } = run(viewport, direction);
        expect(plan.tier).toBe("A");
        expect(f.changes()).toBe(0);
        expect(new Set(f.frames)).toEqual(new Set([MATERIAL_COLUMN]));
        expect(f.animations).toEqual([]);
        expect(onReflow).not.toHaveBeenCalled();
        expect(f.column.dataset.deskColumnLock).toBeUndefined();
      }
    }
  });

  it("B 档（1280 / 1366）展开：第一帧就落到结束后的宽，只变这一次；结束解锁后不再变", () => {
    for (const viewport of [1280, 1366]) {
      const { f, onReflow, firstFrame, settledFrames, plan } = run(viewport, "open");
      expect(plan.tier).toBe("B");
      expect(firstFrame).toBe(plan.material);
      // frames[0] 是开始前；之后每一帧都是结束后的宽。
      expect(f.frames.slice(1).every((width) => width === plan.material)).toBe(true);
      // 只在开始（frames[0] → 第一帧）变一次。
      expect(f.changes()).toBe(1);
      expect(f.frames[0]).toBe(MATERIAL_COLUMN);
      expect(f.frames.length).toBeGreaterThan(settledFrames);
      expect(onReflow).toHaveBeenCalledTimes(1);
      expect(f.animations).toEqual([[{ opacity: SHIFT_FADE.from }, { opacity: 1 }]]);
      expect(SHIFT_FADE.ms).toBeLessThanOrEqual(200);
      expect(f.column.dataset.deskColumnLock).toBeUndefined();
      expect(f.column.style.props.size).toBe(0);
      expect(f.scroller.style.props.size).toBe(0);
    }
  });

  it("B 档收起：开始即切回 656，过渡中藏在对话列下面的部分逐渐露出，结束后不再变", () => {
    const { f, onReflow, firstFrame, plan } = run(1280, "close");
    expect(plan.tier).toBe("B");
    expect(firstFrame).toBe(MATERIAL_COLUMN);
    expect(f.frames[0]).toBe(plan.material);
    expect(f.frames.slice(1).every((width) => width === MATERIAL_COLUMN)).toBe(true);
    expect(f.changes()).toBe(1);
    expect(onReflow).toHaveBeenCalledTimes(1);
    // 锁住期间不出横向滚动条
    expect(f.scroller.style.props.size).toBe(0);
  });

  it("锁住期间：阅读列行内 !important 定宽、滚动层不横向滚；提前结束立刻解锁并还原原有行内样式", () => {
    const f = fakeMaterial(782);
    f.column.style.setProperty("max-width", "700px");
    const stop = shiftMaterialColumns(f.panel, [f.column], 478, 260, { scroller: f.scroller });
    expect(f.column.style.getPropertyValue("width")).toBe("478px");
    expect(f.column.style.getPropertyPriority("width")).toBe("important");
    expect(f.column.dataset.deskColumnLock).toBe("true");
    expect(f.scroller.style.getPropertyValue("overflow-x")).toBe("hidden");
    expect(f.panel.dataset.deskColumnShift).toBe("true");
    stop();
    expect(f.column.style.getPropertyValue("max-width")).toBe("700px");
    expect(f.column.style.props.has("width")).toBe(false);
    expect(f.scroller.style.props.size).toBe(0);
    expect(f.panel.dataset.deskColumnShift).toBeUndefined();
    vi.advanceTimersByTime(500);
    expect(f.column.style.getPropertyValue("max-width")).toBe("700px");
  });

  it("减少动效：不锁、不淡入，瞬时切换并放回一次阅读位置", () => {
    const f = fakeMaterial(782);
    const onReflow = vi.fn();
    shiftMaterialColumns(f.panel, [f.column], 478, 260, { reducedMotion: true, onReflow, fadeTarget: f.fadeTarget });
    expect(onReflow).toHaveBeenCalledTimes(1);
    expect(f.column.style.props.size).toBe(0);
    expect(f.animations).toEqual([]);
    f.frame(478);
    expect(f.frames).toEqual([656, 478]);
  });
});

describe("materialColumns", () => {
  const el = (name: string, header = false) => ({ name, matches: (selector: string) => header && selector === ".ts-detail-header" });
  it("页面标了 data-material-column 就用那几块；没标退回滚动层的直接子块（吸顶页头除外）", () => {
    const marked = [el("reading")];
    expect(materialColumns({ querySelectorAll: () => marked }, { children: [el("x")] })).toEqual(marked);
    const children = [el("header", true), el("body"), el("footer")];
    expect(materialColumns({ querySelectorAll: () => [] }, { children }).map((c) => c.name)).toEqual(["body", "footer"]);
    expect(materialColumns(null, null)).toEqual([]);
  });
});
