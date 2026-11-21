"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { SCHEME_ATTR, THEME_COLOR } from "@/lib/appearanceScript";

/**
 * 这一页该用哪个色，shell 是外壳上的 data-scheme：带 "auto" 的（新首页、登录页，和 app/scheme-dark.css 同一个条件）跟外观；
 * 带 "light" 的（引导里固定浅色的那几步）是浅色；没有外壳的老页面不跟，还是原来那个色。
 */
export const themeColorOf = (scheme: string | null, shell: string | null) => THEME_COLOR[!shell ? "old" : shell === "auto" && scheme === "dark" ? "dark" : "light"];

/**
 * 浏览器顶栏、装成应用后的窗口标题栏跟着界面变（17.2 第 44 条）：首屏那一下由 lib/appearanceScript 在渲染前写好，
 * 这里管之后的——换外观（本人切、伙伴切、系统变了，都落在 <html data-color-scheme> 上）和换页面（新首页、登录页 ↔ 老页面）。
 */
export function ThemeColorSync() {
  const pathname = usePathname();
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => {
      const color = themeColorOf(root.getAttribute(SCHEME_ATTR), document.querySelector("[data-scheme]")?.getAttribute("data-scheme") ?? null);
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: [SCHEME_ATTR] });
    return () => observer.disconnect();
  }, [pathname]);
  return null;
}
