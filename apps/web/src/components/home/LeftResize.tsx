"use client";

/**
 * 左栏宽度能拖（17.2 第 24 条，改掉第 15 条的「不能拖」）：拖左栏右边缘改宽度，240–360；没拖过照 --home-left 的 clamp 随窗口变。
 * 拖过记住本人的宽度（这台浏览器 localStorage，读写都包 try/catch），双击边缘回到默认；键盘聚焦把手后左右键一次 8。手机走抽屉，不画。
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import h from "@/styles/home.module.css";

export const LEFT_MIN = 240;
export const LEFT_MAX = 360;
const KEY = "tianshu-home-left-width-v1";
const STEP = 8;

export const clampLeft = (width: number) => Math.round(Math.min(LEFT_MAX, Math.max(LEFT_MIN, width)));

function readSaved(): number | null {
  try {
    const value = Number(localStorage.getItem(KEY));
    return Number.isFinite(value) && value > 0 ? clampLeft(value) : null;
  } catch { return null; }
}
function writeSaved(width: number | null) {
  try { if (width === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, String(width)); } catch { /* 存不了就只在这一页 */ }
}

/** 本人拖过的宽度（没拖过为 null，用默认）；dragging 时根上停掉列宽的过渡，跟手。 */
export function useLeftWidth() {
  const [width, setWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => { setWidth(readSaved()); }, []);
  return {
    width, dragging, setDragging,
    set: (next: number, persist = true) => { const value = clampLeft(next); setWidth(value); if (persist) writeSaved(value); },
    reset: () => { setWidth(null); writeSaved(null); },
  };
}

/** 左栏右边缘的把手：悬停光标变左右拖、边缘出一条细线；拖、双击、左右键。 */
export function LeftResize({ control }: { control: ReturnType<typeof useLeftWidth> }) {
  const handle = useRef<HTMLDivElement>(null);
  const start = useRef(0);
  // 当前宽度：拖过的照记下的（列宽在过渡时量出来的会落后）；没拖过量左栏。
  const current = () => control.width ?? handle.current?.parentElement?.getBoundingClientRect().width ?? LEFT_MIN;
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    start.current = event.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
    event.currentTarget.setPointerCapture(event.pointerId);
    control.setDragging(true);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!control.dragging) return;
    control.set(event.clientX - start.current, false);
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    if (!control.dragging) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    control.setDragging(false);
    control.set(event.clientX - start.current);
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    control.set(current() + (event.key === "ArrowRight" ? STEP : -STEP));
  };
  return (
    <div ref={handle} className={h.leftHandle} role="separator" aria-orientation="vertical" aria-label="左栏宽度" tabIndex={0}
      aria-valuemin={LEFT_MIN} aria-valuemax={LEFT_MAX} aria-valuenow={Math.round(control.width ?? current())}
      data-dragging={control.dragging ? "" : undefined} data-testid="left-resize"
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={control.reset} onKeyDown={keys} />
  );
}
