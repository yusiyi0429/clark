"use client";

/**
 * 会议页和右列之间的一根线：会议页在录音时说一声「这个对象正在录」，右列据此把 Co-Agent 胶囊摆出来；
 * 麦克风的响度也从这里过，胶囊的光（或眼睛）跟着说话的声音动。两边不在同一棵组件树里，所以用一个很小的共享状态。
 */

import { useSyncExternalStore } from "react";

let listeningScope: string | null = null;
let level = 0;
const scopeListeners = new Set<() => void>();
const levelListeners = new Set<() => void>();

/** 会议页：开始录音时传对象的 scope（`meeting:<id>`），停下时传 null。 */
export function announceListening(scope: string | null) {
  if (listeningScope === scope) return;
  listeningScope = scope;
  if (!scope) level = 0;
  scopeListeners.forEach((notify) => notify());
  levelListeners.forEach((notify) => notify());
}

/** 录音那条麦克风流的响度，0–1。 */
export function announceLevel(next: number) {
  level = next;
  levelListeners.forEach((notify) => notify());
}

const on = (set: Set<() => void>) => (notify: () => void) => {
  set.add(notify);
  return () => set.delete(notify);
};
const subscribeScope = on(scopeListeners);
const subscribeLevel = on(levelListeners);

/** 右列：这个对象此刻是不是在录。 */
export function useListening(scope: string): boolean {
  return useSyncExternalStore(subscribeScope, () => listeningScope === scope, () => false);
}

/** 胶囊：此刻的响度。 */
export function useListeningLevel(): number {
  return useSyncExternalStore(subscribeLevel, () => level, () => 0);
}
