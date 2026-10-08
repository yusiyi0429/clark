import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

type AnimationStub = { finished: Promise<void>; effect: { getTiming: () => { iterations: number } } };
const ui = vi.hoisted(() => ({
  values: [] as unknown[], index: 0,
  effects: [] as (() => void | (() => void))[], cleanups: [] as (() => void)[],
  listeners: new Map<string, (event: { key: string }) => void>(),
  dialogListeners: new Map<string, (event: { key: string; preventDefault: () => void; stopPropagation: () => void }) => void>(),
  animations: [] as AnimationStub[],
  useState(initial: unknown): [unknown, (value: unknown) => void] {
    const index = ui.index++;
    if (!(index in ui.values)) ui.values[index] = initial;
    return [ui.values[index], (value: unknown) => { ui.values[index] = typeof value === "function" ? value(ui.values[index]) : value; }];
  },
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: ui.useState,
  useRef: (initial: unknown) => ui.useState({ current: initial })[0],
  useEffect: (effect: () => void | (() => void)) => { ui.effects.push(effect); },
}));

import { PagedTourView } from "./PagedTour";
import { MISSION_CARD_TOUR_STEPS } from "./MissionCardScenes";

type ElementProps = { children?: ReactNode; ref?: { current: unknown }; onClick?: () => void; "aria-disabled"?: boolean; onPointerDown?: (event: unknown) => void; onPointerUp?: (event: unknown) => void };
function elements(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<ElementProps>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function copy(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(copy).join("");
  if (isValidElement<ElementProps>(node)) return copy(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
const exit = vi.fn();
const skip = vi.fn();
function render() {
  ui.cleanups.forEach((cleanup) => cleanup());
  ui.index = 0; ui.effects = []; ui.cleanups = [];
  const tree = PagedTourView({ label: "任务卡怎么用", steps: MISSION_CARD_TOUR_STEPS, finish: <button onClick={exit}>开始查看任务</button>, onSkip: skip });
  const dialogRef = elements(tree)[0].props.ref;
  if (dialogRef) dialogRef.current = {
    addEventListener: (name: string, listener: (event: { key: string; preventDefault: () => void; stopPropagation: () => void }) => void) => ui.dialogListeners.set(name, listener),
    removeEventListener: (name: string) => ui.dialogListeners.delete(name),
  };
  const host = elements(tree).find((element) => element.type === "div" && element.props.ref);
  if (host?.props.ref) host.props.ref.current = { getAnimations: () => ui.animations };
  ui.effects.forEach((effect) => { const cleanup = effect(); if (cleanup) ui.cleanups.push(cleanup); });
  return tree;
}
function button(tree: ReactNode, label: string) {
  return elements(tree).find((element) => element.type === "button" && copy(element) === label);
}
function pendingScene() {
  let finish!: () => void;
  const animation = { finished: new Promise<void>((resolve) => { finish = resolve; }), effect: { getTiming: () => ({ iterations: 1 }) } };
  // 光标的无限闪烁不能把「下一步」永远卡住。
  ui.animations = [animation, { finished: new Promise<void>(() => undefined), effect: { getTiming: () => ({ iterations: Infinity }) } }];
  return finish;
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

beforeEach(() => {
  ui.values = []; ui.cleanups = []; ui.listeners.clear(); ui.dialogListeners.clear(); vi.clearAllMocks();
  vi.stubGlobal("window", {
    addEventListener: (name: string, listener: (event: { key: string }) => void) => { ui.listeners.set(name, listener); },
    removeEventListener: (name: string) => { ui.listeners.delete(name); },
  });
});
afterEach(() => { ui.cleanups.forEach((cleanup) => cleanup()); vi.unstubAllGlobals(); });

describe("任务卡演示的完整观看门禁", () => {
  it("按钮与键盘都不能跳过未放完的幕，最后一幕完成才可退出", async () => {
    let finish = pendingScene();
    let tree = render();
    expect(copy(tree)).toContain("第 1 步，共 5 步");
    expect(button(tree, "下一步")?.props["aria-disabled"]).toBe(true);
    button(tree, "下一步")?.props.onClick?.();
    ui.listeners.get("keydown")?.({ key: "ArrowRight" });
    expect(copy(render())).toContain("第 1 步，共 5 步");

    for (let step = 0; step < MISSION_CARD_TOUR_STEPS.length; step++) {
      expect(button(tree, "开始查看任务")).toBeUndefined();
      finish(); await settle();
      tree = render();
      if (step < MISSION_CARD_TOUR_STEPS.length - 1) {
        expect(button(tree, "下一步")?.props["aria-disabled"]).toBe(false);
        button(tree, "下一步")?.props.onClick?.();
        finish = pendingScene(); tree = render();
        expect(copy(tree)).toContain(`第 ${step + 2} 步，共 5 步`);
      }
    }
    button(tree, "开始查看任务")?.props.onClick?.();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("没放完也能跳过直接进入；看完出现出口后不再重复显示跳过", async () => {
    pendingScene();
    let tree = render();
    expect(button(tree, "下一步")?.props["aria-disabled"]).toBe(true);
    button(tree, "跳过，直接进入")?.props.onClick?.();
    expect(skip).toHaveBeenCalledOnce();

    ui.animations = []; tree = render();
    for (let step = 0; step < MISSION_CARD_TOUR_STEPS.length - 1; step++) {
      await settle(); tree = render();
      button(tree, "下一步")?.props.onClick?.(); tree = render();
    }
    await settle(); tree = render();
    expect(button(tree, "开始查看任务")).toBeDefined();
    expect(button(tree, "跳过，直接进入")).toBeUndefined();
  });

  it("可以回看和重播已看过的幕；触屏前进同样遵守观看门禁", async () => {
    const finish = pendingScene();
    let tree = render();
    finish(); await settle(); tree = render();
    ui.listeners.get("keydown")?.({ key: "ArrowRight" });
    pendingScene(); tree = render();
    const stage = elements(tree).find((element) => element.props.onPointerUp);
    stage?.props.onPointerDown?.({ clientX: 200 });
    stage?.props.onPointerUp?.({ clientX: 30, pointerType: "touch" });
    expect(copy(render())).toContain("第 2 步，共 5 步");
    ui.listeners.get("keydown")?.({ key: "ArrowLeft" });
    tree = render();
    expect(copy(tree)).toContain("第 1 步，共 5 步");
    button(tree, "重播")?.props.onClick?.();
    tree = render();
    expect(button(tree, "下一步")?.props["aria-disabled"]).toBe(false);
  });

  it("减少动态效果没有动画时仍需逐页阅读，且不会等待不存在的动画", async () => {
    ui.animations = [];
    let tree = render();
    for (let step = 0; step < MISSION_CARD_TOUR_STEPS.length - 1; step++) {
      await settle(); tree = render();
      expect(button(tree, "开始查看任务")).toBeUndefined();
      button(tree, "下一步")?.props.onClick?.(); tree = render();
    }
    await settle(); tree = render();
    expect(button(tree, "开始查看任务")).toBeDefined();
  });

  it("播放中打开减少动态效果、动画被取消时，下一步不会永久锁住", async () => {
    let cancel!: () => void;
    ui.animations = [{ finished: new Promise<void>((_resolve, reject) => { cancel = () => reject(new Error("animation canceled")); }), effect: { getTiming: () => ({ iterations: 1 }) } }];
    let tree = render();
    expect(button(tree, "下一步")?.props["aria-disabled"]).toBe(true);
    cancel(); await settle(); tree = render();
    expect(button(tree, "下一步")?.props["aria-disabled"]).toBe(false);
    expect(button(tree, "开始查看任务")).toBeUndefined();
  });

  it("Escape 不冒泡到工作区，不能通过返回上一页绕过首次观看", () => {
    pendingScene();
    const tree = render();
    const event = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
    ui.dialogListeners.get("keydown")?.(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });
});
