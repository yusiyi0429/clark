import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { ReduceMotionSync } from "@/components/ReduceMotionSync";
import { ThemeColorSync } from "@/components/ThemeColorSync";
import { APPEARANCE_SCRIPT } from "@/lib/appearanceScript";
import "./globals.css";

/** 字标「天枢」两字的抖音美好体子集（800 字节）；正文只用系统字栈（clark 同）。 */
const douyin = localFont({
  src: "./fonts/douyin-brand.woff2",
  variable: "--font-douyin",
  weight: "700",
  display: "swap",
  adjustFontFallback: false,
  fallback: ["PingFang SC", "Microsoft YaHei", "Heiti SC", "sans-serif"],
});

export const metadata: Metadata = {
  title: "TKOS",
  description: "把公司的判断变成持久对象。",
  robots: { index: false, follow: false },
  // 苹果手机「添加到主屏幕」后全屏打开；状态栏透明叠在深色画布上（刘海由页面留白，见 viewportFit）。
  appleWebApp: { capable: true, title: "天枢", statusBarStyle: "black-translucent" },
};

/**
 * 弹出软键盘时让整页（外壳是 100dvh）一起缩到键盘上方：底部的输入条、对话记录层跟着上来，不被键盘盖住。
 * Android / 鸿蒙的 Chromium 内核浏览器默认只缩视觉视口，固定在底部的输入条会被推到键盘后面；iOS Safari 忽略这一项。
 * viewportFit cover：页面铺到刘海和底部横条下面，各处用 safe-area-inset 自己留白。
 * 顶栏、窗口标题栏的颜色（theme-color）不在这里写死：跟着外观变，由首屏脚本和 ThemeColorSync 写。
 */
export const viewport: Viewport = { width: "device-width", initialScale: 1, interactiveWidget: "resizes-content", viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-color-scheme 由下面的脚本在渲染前写上（外观，17.2），服务端渲染时没有：不算水合不一致。
    <html lang="zh-CN" data-theme="tianshu" className={`h-full ${douyin.variable}`} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: APPEARANCE_SCRIPT }} /></head>
      <body className="min-h-full bg-paper">
        <ReduceMotionSync />
        <ThemeColorSync />
        {children}
      </body>
    </html>
  );
}
