"use client";

import { createContext, useContext } from "react";

/**
 * 新首页任何地方不出省略号（本人 11/18）。外壳（HomeShell）给 true；新旧界面共用的组件用它去掉文案里的「…」，
 * 旧界面（没有这个外壳）照旧。
 */
export const NoEllipsis = createContext(false);

const drop = (text: string) => text.replace(/…+$/u, "");
const keep = (text: string) => text;

/** 在不在新首页的外壳里：新首页里文字不截、不拼「…」，放不下交给样式换行。 */
export function useNoEllipsis(): boolean {
  return useContext(NoEllipsis);
}

/** 新首页里去掉末尾的「…」（「保存中…」→「保存中」），旧界面原样。 */
export function useDots(): (text: string) => string {
  return useNoEllipsis() ? drop : keep;
}
