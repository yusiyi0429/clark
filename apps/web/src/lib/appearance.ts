"use client";

/**
 * 外观（设计 17.2）：跟随系统 / 浅色 / 深色，存在服务端（GET / PUT /api/me/appearance），换设备一样。
 * 这台电脑上另存一份只为首屏不闪（appearanceScript.ts 在渲染前按它画）；读到服务端的值和本地不一样时以服务端为准，改掉本地那份。
 * 伙伴代本人改了以后网页怎么知道等 17.4 定；现在是刷新、切回这个标签页时重新读一次。
 */
import { useCallback, useEffect, useState } from "react";
import type { TAppearanceSettings } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { APPEARANCE_KEY, SCHEME_ATTR } from "./appearanceScript";
import { useBuddyUi } from "@/lib/buddy/uiEvent";

export type Appearance = TAppearanceSettings["appearance"];

export function readStoredAppearance(): Appearance {
  try {
    const value = localStorage.getItem(APPEARANCE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch { return "system"; }
}

/** 跟随系统时按系统，其余照选的。 */
export const schemeOf = (appearance: Appearance, systemDark: boolean): "dark" | "light" =>
  appearance === "dark" || (appearance === "system" && systemDark) ? "dark" : "light";

/** 存到这台电脑上，马上按它画（和首屏脚本同一套算法；系统变了由首屏脚本挂的监听跟着变）。 */
export function applyStoredAppearance(appearance: Appearance) {
  try { localStorage.setItem(APPEARANCE_KEY, appearance); } catch { /* 存不了就只管这一次 */ }
  const systemDark = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.setAttribute(SCHEME_ATTR, schemeOf(appearance, systemDark));
}

async function readAppearance(): Promise<Appearance | null> {
  const { data, response } = await browserApi.GET("/api/me/appearance");
  return response.ok && data ? data.appearance : null;
}

/**
 * 本人的外观：先用本地那份，读到服务端的就以它为准；切回这个标签页时再读一次。
 * set：马上换（本地先变，不等服务端），再存到服务端；没存成时换回原来的，把错误抛给调用方（原处写「失败 · 重试」）。
 */
export function useAppearance() {
  // 先按「跟随系统」渲染（和服务端渲染一致），挂上以后换成本地那份，再读服务端的。
  const [appearance, setLocal] = useState<Appearance>("system");
  useEffect(() => {
    let alive = true;
    setLocal(readStoredAppearance());
    const load = () => void readAppearance().then((value) => {
      if (!alive || !value) return;
      if (value !== readStoredAppearance()) applyStoredAppearance(value);
      setLocal(value);
    }, () => undefined);
    load();
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive = false; document.removeEventListener("visibilitychange", onVisible); };
  }, []);
  // 伙伴切了外观（17.4 的 ui 事件）：立刻照它换，不用再读。
  useBuddyUi((effect) => {
    if (effect.kind !== "appearance") return;
    applyStoredAppearance(effect.appearance);
    setLocal(effect.appearance);
  });
  const set = useCallback(async (next: Appearance) => {
    const previous = readStoredAppearance();
    applyStoredAppearance(next);
    setLocal(next);
    const { response } = await browserApi.PUT("/api/me/appearance", { body: { appearance: next } }).catch(() => ({ response: null }));
    if (!response?.ok) {
      applyStoredAppearance(previous);
      setLocal(previous);
      throw new Error("没存上，请重试");
    }
  }, []);
  return [appearance, set] as const;
}
