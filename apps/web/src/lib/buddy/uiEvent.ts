"use client";

/**
 * 伙伴动作在界面上的效果（17.4，对话流的 ui 事件）：对话层收到后在窗口上发一个 BUDDY_UI_EVENT，
 * 外壳接 open（打开某一处）和首页那几块的 refresh，外观由 useAppearance 接，偏好页接 settings、trash 的 refresh。
 */
import { useEffect, useRef } from "react";
import type { TBuddyUiEffect } from "@warmap/contracts";

export const BUDDY_UI_EVENT = "buddy-ui";

export function emitBuddyUi(effect: TBuddyUiEffect) {
  window.dispatchEvent(new CustomEvent(BUDDY_UI_EVENT, { detail: effect }));
}

/** 收到伙伴的界面效果就调一次（回调总用最新的，不跟着重挂监听）。 */
export function useBuddyUi(onEffect: (effect: TBuddyUiEffect) => void) {
  const ref = useRef(onEffect);
  ref.current = onEffect;
  useEffect(() => {
    const listener = (event: Event) => ref.current((event as CustomEvent<TBuddyUiEffect>).detail);
    window.addEventListener(BUDDY_UI_EVENT, listener);
    return () => window.removeEventListener(BUDDY_UI_EVENT, listener);
  }, []);
}
