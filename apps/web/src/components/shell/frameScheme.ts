"use client";

/**
 * 二级页框（DetailFrame）套哪个主题：新首页、登录页的外壳（[data-scheme="auto"]）里跟外观，<html data-color-scheme> 是 dark 就深色；
 * 老页面没有这个外壳，照旧浅色（同 app/scheme-dark.css、ThemeColorSync 的条件）。
 */
import { useSyncExternalStore } from "react";
import { SCHEME_ATTR } from "@/lib/appearanceScript";

export function frameScheme(root: Pick<HTMLElement, "getAttribute"> | null, hasShell: boolean): "light" | "dark" {
  return hasShell && root?.getAttribute(SCHEME_ATTR) === "dark" ? "dark" : "light";
}

const subscribe = (notify: () => void) => {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [SCHEME_ATTR] });
  return () => observer.disconnect();
};
const current = () => frameScheme(document.documentElement, document.querySelector('[data-scheme="auto"]') !== null);
const server = () => "light" as const;

/** 客户端读 <html> 和外壳、换外观时跟着变；服务端渲染是浅色。 */
export function useFrameScheme(): "light" | "dark" {
  return useSyncExternalStore(subscribe, current, server);
}
