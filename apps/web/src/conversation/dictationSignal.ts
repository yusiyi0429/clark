"use client";

/**
 * 正在听写（任何一个输入框）和当下的音量：新首页的伙伴台据此「跟着声音动」（设计 5.4.2、9.2）。
 * 听写在各个输入框里各自进行，这里只放一份「现在有没有在听、声音多大」，谁要谁订。
 */
import { useSyncExternalStore } from "react";

export type DictationSignal = { level: number } | null;

let current: DictationSignal = null;
const listeners = new Set<() => void>();

export function publishDictation(next: DictationSignal): void {
  if (current === next || (current && next && current.level === next.level)) return;
  current = next;
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** 正在听写时是 { level }（0–1），没在听为 null。 */
export function useDictationSignal(): DictationSignal {
  return useSyncExternalStore(subscribe, () => current, () => null);
}
