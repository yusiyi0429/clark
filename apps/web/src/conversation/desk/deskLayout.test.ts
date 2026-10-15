import { describe, expect, it, vi } from "vitest";
import { applyDeskWidth, DESK_COLUMN_MAX, DESK_COLUMN_MIN, DESK_MATERIAL_MIN, deskColumnWidth, deskPlan, drawerEntryFocus, drawerEscape, drawerShouldReturnFocus, MATERIAL_COLUMN, MATERIAL_MEASURE, materialWidth, readingMeasure, shellMetrics } from "./deskLayout";

describe("深度讨论（并排）的断点与宽度", () => {
  it("外壳边距跟 app-shell 一致：≥1800 16、≤1250 10、其余 14；左侧窄条 56", () => {
    expect(shellMetrics(1920)).toEqual({ edge: 16, mainStart: 88 });
    expect(shellMetrics(1440)).toEqual({ edge: 14, mainStart: 84 });
    expect(shellMetrics(1100)).toEqual({ edge: 10, mainStart: 76 });
  });

  // 收起时对话列：1280–1599 为 400，≥1600 为 440（conversation-column.module.css）。
  const collapsed = (viewport: number) => (viewport >= 1600 ? 440 : 400);

  it("宽度规则表：A 档 clamp(可用 − 656, 640, 760)，B 档 max(⌈55%⌉, 640)", () => {
    const table = [1280, 1366, 1440, 1600, 1920].map((viewport) => {
      const plan = deskPlan(viewport)!;
      const before = materialWidth(viewport, collapsed(viewport));
      return { viewport, tier: plan.tier, column: plan.column, material: plan.material, before, measureBefore: readingMeasure(before), measureAfter: readingMeasure(plan.material) };
    });
    expect(table).toEqual([
      { viewport: 1280, tier: "B", column: 704, material: 478, before: 782, measureBefore: 600, measureAfter: 454 },
      { viewport: 1366, tier: "B", column: 752, material: 516, before: 868, measureBefore: 600, measureAfter: 492 },
      { viewport: 1440, tier: "A", column: 686, material: 656, before: 942, measureBefore: 600, measureAfter: 600 },
      { viewport: 1600, tier: "A", column: 760, material: 742, before: 1062, measureBefore: 600, measureAfter: 600 },
      { viewport: 1920, tier: "A", column: 760, material: 1056, before: 1376, measureBefore: 600, measureAfter: 600 },
    ]);
  });

  it("<1280 不提供；A 档从可用宽度 1296（视口 1394）起，阅读列展开前后同宽", () => {
    expect(deskColumnWidth(0)).toBeNull();
    expect(deskColumnWidth(959)).toBeNull();
    expect(deskColumnWidth(1279)).toBeNull();
    expect(deskPlan(1393)!.tier).toBe("B");
    expect(deskPlan(1394)).toEqual({ tier: "A", column: 640, material: 656 });
    for (let viewport = 1280; viewport <= 2560; viewport++) {
      const plan = deskPlan(viewport)!;
      expect(plan.column).toBeGreaterThanOrEqual(DESK_COLUMN_MIN);
      expect(plan.material).toBeGreaterThanOrEqual(DESK_MATERIAL_MIN);
      if (plan.tier === "A") {
        expect(plan.column).toBeLessThanOrEqual(DESK_COLUMN_MAX);
        expect(plan.material).toBeGreaterThanOrEqual(MATERIAL_COLUMN);
        expect(readingMeasure(plan.material)).toBe(readingMeasure(materialWidth(viewport, collapsed(viewport))));
      } else {
        expect(plan.column * 100).toBeGreaterThanOrEqual(viewport * 55);
        expect(readingMeasure(plan.material)).toBeLessThan(MATERIAL_MEASURE);
      }
    }
  });

  it("阅读列 600 + 左右各 28 = 656；面板略窄（滚动条）时内边距先让到 12，正文仍 600", () => {
    expect(MATERIAL_COLUMN).toBe(656);
    expect(readingMeasure(656)).toBe(600);
    expect(readingMeasure(624)).toBe(600);
    expect(readingMeasure(600)).toBe(576);
  });

  it("展开时把对话列宽度写到宿主的 --conversation-open-width（右列、左侧让位、输入条一起走）；收起清掉", () => {
    const style = { setProperty: vi.fn(), removeProperty: vi.fn() };
    applyDeskWidth(style, 704);
    expect(style.setProperty).toHaveBeenCalledWith("--conversation-open-width", "704px");
    applyDeskWidth(style, null);
    expect(style.removeProperty).toHaveBeenCalledWith("--conversation-open-width");
    expect(() => applyDeskWidth(null, null)).not.toThrow();
  });
});

describe("演示后的右栏抽屉（首演版不渲染）", () => {
  it("抽屉开着时 Esc 先收抽屉（preventDefault，外壳不再收讨论台）；已被处理、组词中、抽屉关着都不管", () => {
    const event = (patch = {}) => ({ key: "Escape", defaultPrevented: false, isComposing: false, preventDefault: vi.fn(), ...patch });
    const open = event();
    expect(drawerEscape(open, true)).toBe(true);
    expect(open.preventDefault).toHaveBeenCalledOnce();
    expect(drawerEscape(event(), false)).toBe(false);
    expect(drawerEscape(event({ defaultPrevented: true }), true)).toBe(false);
    expect(drawerEscape(event({ isComposing: true }), true)).toBe(false);
    expect(drawerEscape(event({ key: "Enter" }), true)).toBe(false);
  });
});

describe("抽屉的焦点", () => {
  type Fake = { contains(other: unknown): boolean; querySelector(selector: string): Fake | null };
  const node = (children: Fake[] = []): Fake => {
    const self: Fake = { contains: (other) => other === self || children.some((child) => child.contains(other)), querySelector: () => children[0] ?? null };
    return self;
  };

  it("打开：焦点进抽屉的第一个可聚焦元素；没有就落在抽屉本身", () => {
    const first = node();
    const drawer = node([first]);
    expect(drawerEntryFocus(drawer)).toBe(first);
    const empty = node();
    expect(drawerEntryFocus(empty)).toBe(empty);
  });

  it("关上：焦点还在抽屉里（或掉到 body / 没有）就回到抽屉键；被条目挪到别处（如提案卡）就不动", () => {
    const row = node();
    const drawer = node([row]);
    const body = node();
    const card = node();
    expect(drawerShouldReturnFocus(row, drawer, body)).toBe(true);
    expect(drawerShouldReturnFocus(body, drawer, body)).toBe(true);
    expect(drawerShouldReturnFocus(null, drawer, body)).toBe(true);
    expect(drawerShouldReturnFocus(card, drawer, body)).toBe(false);
    expect(drawerShouldReturnFocus(row, null, body)).toBe(false);
  });
});
