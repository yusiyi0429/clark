"use client";

/**
 * 右列是展开着，还是收起（右列缩到 0，阅读页铺满右边，只留浮着的把手和频道钮；代码里这一态叫 strip）。
 * 照搬 clark `conversation/use-column-mode.ts`。
 *
 * **全站一个偏好，不按页记**：人收起右列，是因为今天想看宽一点的内容，不是因为这一页。收起、展开
 * 这两个用户动作都会改写偏好；刷新、换页、换对象都照偏好来。默认展开。
 *
 * **系统永远不自己展开右列**：来了消息只在收起后的频道钮上打角标。
 *
 * ≤759 没有收起这回事：那里右列本来就是浮层，恒为 expanded。
 */

import { useCallback, useSyncExternalStore } from "react";

export type ColumnMode = "expanded" | "strip";

export const COLUMN_MODE_STORAGE = "tianshu-conversation-column-v1";
/** ≤759 右列是浮层。 */
export const NARROW_COLUMN_QUERY = "(max-width:759px)";

/** 存储里读出来的偏好。认不出的一律当展开。 */
export function readColumnMode(raw: string | null | undefined): ColumnMode {
  return raw === "strip" ? "strip" : "expanded";
}

/* ── 偏好：一个模块级的小存储，同页几处、同一台机器的几个标签页读同一份 ── */

let preference: ColumnMode | null = null;
const listeners = new Set<() => void>();

function readPreference(): ColumnMode {
  if (preference === null) {
    try {
      preference = readColumnMode(window.localStorage.getItem(COLUMN_MODE_STORAGE));
    } catch {
      preference = "expanded";
    }
  }
  return preference;
}

function subscribePreference(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== COLUMN_MODE_STORAGE) return;
    preference = readColumnMode(event.newValue);
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** 写偏好（用户动作）。写不进去（隐私模式、存储满）只影响下次打开，这一次照样生效。 */
export function saveColumnMode(mode: ColumnMode) {
  preference = mode;
  try {
    window.localStorage.setItem(COLUMN_MODE_STORAGE, mode);
  } catch {
    /* 偏好写不进去就只在这一页生效 */
  }
  listeners.forEach((listener) => listener());
}

function subscribeNarrow(listener: () => void) {
  const query = window.matchMedia(NARROW_COLUMN_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

/** ≤759：右列是浮层。服务端那一帧按宽屏算，水合后再对。 */
export function useNarrowColumn(): boolean {
  return useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW_COLUMN_QUERY).matches, () => false);
}

/** 此刻右列该是哪一态：窄屏恒展开，否则听偏好。返回的 `setMode` 是用户动作，改写偏好。 */
export function useColumnMode() {
  const stored = useSyncExternalStore(subscribePreference, readPreference, () => "expanded" as ColumnMode);
  const narrow = useNarrowColumn();
  const mode: ColumnMode = narrow ? "expanded" : stored;
  const setMode = useCallback((next: ColumnMode) => saveColumnMode(next), []);
  return { mode, narrow, setMode };
}
