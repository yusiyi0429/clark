"use client";

/**
 * 栏宽能拖：左栏（17.2 第 24 条，改掉第 15 条的「不能拖」）拖右边缘，240–360；没拖过照 --home-left 的 clamp 随窗口变。
 * 右边的面板（11/11）拖左边缘，260–560；没拖过照 --home-right（288）。放文件时另记一个宽（第 73 条），360–1400，没拖过约占展示区一半（--home-file）。窗口窄时右栏让中栏至少留 480（CSS 里夹，见 home.module.css .app）。
 * 拖过记住本人的宽度（这台浏览器 localStorage，读写都包 try/catch），双击边缘回到默认；键盘聚焦把手后左右键一次 8。手机走抽屉，不画。
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import h from "@/styles/home.module.css";

export const LEFT_MIN = 240;
export const LEFT_MAX = 360;
export const RIGHT_MIN = 260;
export const RIGHT_MAX = 560;
const STEP = 8;

type Spec = { key: string; min: number; max: number };
const LEFT: Spec = { key: "tianshu-home-left-width-v1", min: LEFT_MIN, max: LEFT_MAX };
const RIGHT: Spec = { key: "tianshu-home-right-width-v1", min: RIGHT_MIN, max: RIGHT_MAX };
const FILE: Spec = { key: "tianshu-home-file-width-v1", min: 360, max: 1400 };

const clampTo = (spec: Spec, width: number) => Math.round(Math.min(spec.max, Math.max(spec.min, width)));
export const clampLeft = (width: number) => clampTo(LEFT, width);
export const clampRight = (width: number) => clampTo(RIGHT, width);

function readSaved(spec: Spec): number | null {
  try {
    const value = Number(localStorage.getItem(spec.key));
    return Number.isFinite(value) && value > 0 ? clampTo(spec, value) : null;
  } catch { return null; }
}
function writeSaved(spec: Spec, width: number | null) {
  try { if (width === null) localStorage.removeItem(spec.key); else localStorage.setItem(spec.key, String(width)); } catch { /* 存不了就只在这一页 */ }
}

/** 本人拖过的宽度（没拖过为 null，用默认）；dragging 时根上停掉列宽的过渡，跟手。 */
function useColumnWidth(spec: Spec) {
  const [width, setWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => { setWidth(readSaved(spec)); }, [spec]);
  return {
    width, dragging, setDragging, min: spec.min, max: spec.max,
    set: (next: number, persist = true) => { const value = clampTo(spec, next); setWidth(value); if (persist) writeSaved(spec, value); },
    reset: () => { setWidth(null); writeSaved(spec, null); },
  };
}
export const useLeftWidth = () => useColumnWidth(LEFT);
export const useRightWidth = () => useColumnWidth(RIGHT);
export const useFileWidth = () => useColumnWidth(FILE);
type Control = ReturnType<typeof useColumnWidth>;

/**
 * 栏边缘的把手：悬停光标变左右拖、边缘出一条细线；拖、双击、左右键。
 * side 是把手在哪一栏：左栏的把手在右边缘（往右拖变宽），右栏的在左边缘（往左拖变宽）。
 */
function ColumnResize({ control, side, label }: { control: Control; side: "left" | "right"; label: string }) {
  const handle = useRef<HTMLDivElement>(null);
  const edge = useRef(0);
  const grow = side === "left" ? 1 : -1;
  // 当前宽度：拖过的照记下的（列宽在过渡时量出来的会落后）；没拖过量这一栏。
  const current = () => control.width ?? handle.current?.parentElement?.getBoundingClientRect().width ?? control.min;
  const widthAt = (x: number) => (x - edge.current) * grow;
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = event.currentTarget.parentElement?.getBoundingClientRect();
    // 栏的另一边不动：左栏量左边，右栏量右边。
    edge.current = (side === "left" ? rect?.left : rect?.right) ?? 0;
    event.currentTarget.setPointerCapture(event.pointerId);
    control.setDragging(true);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!control.dragging) return;
    control.set(widthAt(event.clientX), false);
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    if (!control.dragging) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    control.setDragging(false);
    control.set(widthAt(event.clientX));
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    control.set(current() + (event.key === "ArrowRight" ? STEP : -STEP) * grow);
  };
  return (
    <div ref={handle} className={side === "left" ? h.leftHandle : h.rightHandle} role="separator" aria-orientation="vertical" aria-label={label} tabIndex={0}
      aria-valuemin={control.min} aria-valuemax={control.max} aria-valuenow={Math.round(control.width ?? current())}
      data-dragging={control.dragging ? "" : undefined} data-testid={`${side}-resize`}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={control.reset} onKeyDown={keys} />
  );
}

export const LeftResize = ({ control }: { control: Control }) => <ColumnResize control={control} side="left" label="左栏宽度" />;
export const RightResize = ({ control }: { control: Control }) => <ColumnResize control={control} side="right" label="右栏宽度" />;
