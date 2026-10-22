"use client";

import { useSyncExternalStore } from "react";

/**
 * 有没有人正拖着文件经过天枢窗口（从桌面、飞书、通知栏拖都算）：能接文件的区域据此一起亮出虚线框。
 * 全页只挂一套 window 监听；拖进拖出按层数计，松手、拖出窗口、取消都归零。
 * 拖着文件在不能接的地方松手时拦下浏览器默认行为，不把文件直接打开、离开天枢。
 */
let depth = 0;
let dragging = false;
const listeners = new Set<() => void>();

const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
const set = (next: boolean) => {
  if (dragging === next) return;
  dragging = next;
  listeners.forEach((listener) => listener());
};
const reset = () => { depth = 0; set(false); };

function onEnter(event: DragEvent) {
  if (!hasFiles(event)) return;
  depth += 1;
  set(true);
}
function onLeave(event: DragEvent) {
  if (!hasFiles(event)) return;
  depth = Math.max(0, depth - 1);
  if (depth === 0) set(false);
}
function onOver(event: DragEvent) {
  if (hasFiles(event)) event.preventDefault();
}
function onDrop(event: DragEvent) {
  if (hasFiles(event)) event.preventDefault();
  reset();
}

function subscribe(listener: () => void) {
  if (!listeners.size) {
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragend", reset);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    window.removeEventListener("dragenter", onEnter);
    window.removeEventListener("dragleave", onLeave);
    window.removeEventListener("dragover", onOver);
    window.removeEventListener("drop", onDrop);
    window.removeEventListener("dragend", reset);
    reset();
  };
}

export function useFileDrag(): boolean {
  return useSyncExternalStore(subscribe, () => dragging, () => false);
}
