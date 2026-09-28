import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { ReduceMotionSync } from "@/components/ReduceMotionSync";
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
};

/**
 * 弹出软键盘时让整页（外壳是 100dvh）一起缩到键盘上方：底部的输入条、对话记录层跟着上来，不被键盘盖住。
 * Android / 鸿蒙的 Chromium 内核浏览器默认只缩视觉视口，固定在底部的输入条会被推到键盘后面；iOS Safari 忽略这一项。
 */
export const viewport: Viewport = { width: "device-width", initialScale: 1, interactiveWidget: "resizes-content" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" data-theme="tianshu" className={`h-full ${douyin.variable}`}>
      <body className="min-h-full bg-paper">
        <ReduceMotionSync />
        {children}
      </body>
    </html>
  );
}
