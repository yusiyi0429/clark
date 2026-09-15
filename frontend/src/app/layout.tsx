import type { Metadata } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { RatingProvider } from "@/components/rating/rating-provider";
import "./globals.css";

/**
 * 正文不加载任何网络字体 —— 拉丁不加载，中文更不加载（H8）。中文字体动辄几 MB，会毁掉
 * 这个 demo 唯一的一次第一印象。字栈在 globals.css 里。
 *
 * 例外只剩一处：字标「天枢」两个字的抖音美好体子集，**800 字节**。
 *
 * 源文件是 2MB 的 DouyinSansBold（OTF）。子集只留 U+5929、U+67A2 两个码位，去掉
 * hinting 和排版特性表之后压成 woff2 —— 比它替掉的那枚 SVG 兽头标记还小。重新生成：
 *
 *   pyftsubset DouyinSansBold.otf --unicodes=U+5929,U+67A2 \
 *     --flavor=woff2 --no-hinting --layout-features='' --name-IDs='' \
 *     --output-file=src/app/fonts/douyin-brand.woff2
 *
 * `display: swap` 会让首帧先落到系统黑体再换 —— 但 next/font 给它发的是 preload，
 * 800 字节是一个包，换字窗口约等于零。反过来用 `block` 才是错的：那会让字标在首屏上
 * 短暂**消失**，而这是整块屏幕上唯一一处品牌物件。
 *
 * 这一处换过两轮：先是 Poppins 拉丁子集（字标那四个字母「TKOS」）+ 抖音美好体的
 * 「景略」两字，然后是行楷的「谛听」两字加一枚兽头标记。现在名字是「天枢」、体是
 * 抖音美好体 —— 每一轮都只留当下在用的那一份，没人用的子集不留在包里。
 */
const douyin = localFont({
  src: "./fonts/douyin-brand.woff2",
  variable: "--font-douyin",
  weight: "700",
  display: "swap",
  // 子集里只有两个字，自动算出的 fallback 度量必然是错的 —— 不注入。
  adjustFontFallback: false,
  // 掉字时落到系统黑体：同一类的几何无衬线，不会突然变成一个楷体字标。
  fallback: ["PingFang SC", "Microsoft YaHei", "Heiti SC", "sans-serif"],
});

export const metadata: Metadata = {
  title: "TKOS",
  description: "把公司的判断变成持久对象。",
};

/**
 * 根布局只管文档骨架。五环节导航在 `(tkos)/layout.tsx` 里 —— 秘书控制台
 * （`/operator`，口述模式的一半，这一版封存）不该套那条导航条。
 *
 * 这里曾经有两段首屏前的脚本：`DESK_PREPAINT`（三栏桌子的栏宽）和 `MODE_PREPAINT`
 * （手动/口述模式）。三栏工作台已整体移除；模式脚本随口述模式一起封存 —— 它会在
 * `<html>` 上加 `dark`，而这一版的五个页面只有纸白一套。`lib/mode.ts` 保留可编译，
 * 语音交互重启时把这一行加回来。
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className={`h-full ${douyin.variable}`}>
      <body className="min-h-full bg-paper">
        <RatingProvider>{children as ReactNode}</RatingProvider>
      </body>
    </html>
  );
}
