"use client";

import { useEffect, useReducer, useRef } from "react";

/**
 * 「先留几秒撤回，到点才提交」：会议页的会后事项（确认 / 忽略 / 推送）和左栏同一个规则（巡检 P1-9）。
 * 撤回就什么都不发；离开页面时还在等的立刻提交。计时器可注入，方便测试。
 */
export const UNDO_WINDOW_MS = 5000;

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
const defaultTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export class UndoWindow<Kind extends string = string> {
  private held = new Map<string, { kind: Kind; handle: unknown; commit: () => void }>();

  constructor(private onChange: () => void, private timers: Timers = defaultTimers, private ms = UNDO_WINDOW_MS) {}

  /** 正在等的那一种（没有就是 null）。 */
  pending(key: string): Kind | null {
    return this.held.get(key)?.kind ?? null;
  }

  hold(key: string, kind: Kind, commit: () => void): void {
    if (this.held.has(key)) return;
    const handle = this.timers.set(() => {
      this.held.delete(key);
      this.onChange();
      commit();
    }, this.ms);
    this.held.set(key, { kind, handle, commit });
    this.onChange();
  }

  undo(key: string): void {
    const entry = this.held.get(key);
    if (!entry) return;
    this.timers.clear(entry.handle);
    this.held.delete(key);
    this.onChange();
  }

  /** 离开页面：还在等的全部立刻提交。 */
  flush(): void {
    const entries = [...this.held.values()];
    this.held.clear();
    for (const entry of entries) {
      this.timers.clear(entry.handle);
      entry.commit();
    }
  }
}

export function useUndoWindow<Kind extends string>(): UndoWindow<Kind> {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const window = useRef<UndoWindow<Kind> | null>(null);
  window.current ??= new UndoWindow<Kind>(rerender);
  useEffect(() => {
    const current = window.current;
    return () => current?.flush();
  }, []);
  return window.current;
}
