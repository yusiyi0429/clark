/**
 * 图表色板的对比度闸。
 *
 * ## 为什么这条值得单测
 *
 * 这个文件测的东西**在屏幕上看不出来**，正合 `vitest.config.ts` 开头那条口径。
 *
 * 色板是 2026-08-30 那次改版按「对比度」而不是「明度」解出来的：每一条对纸色和
 * 面色都留了余量。而它最可能的坏法是一句无害的需求 —— 「再鲜艳一点」。
 * 在 OKLCH 里把彩度往上推、或者把明度往上提，屏幕上确实更好看，
 * 而 WCAG 那条 3:1 就是这么被越过去的：**没有任何视觉症状，只是色盲用户和
 * 强光下的人读不出哪根柱子是哪根。**
 *
 * 所以这里不测「颜色等于某个 hex」（那种测试只会在改色时无意义地红一次，
 * 然后被人顺手改成新值），测的是**那条线本身**。
 *
 * ## 3:1 是哪来的
 *
 * WCAG 2.2 SC 1.4.11「非文本对比度」，Level AA：用户界面组件与图形对象要对
 * 相邻颜色达到至少 3:1，而且**不许四舍五入** —— 2.999:1 不算达标。
 * 图形对象的定义明写包含「复杂图示中理解内容所必需的部分，例如图里的每一条线」。
 *
 * 同一条规范也澄清了一件事：**系列与系列之间不要求 3:1**，只要求各自对背景。
 * 所以这里只比背景，不两两互比。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const CSS = readFileSync(fileURLToPath(new URL("./globals.css", import.meta.url)), "utf8");

/** 取一个顶层令牌的值。只认 `--name: value;` 这一种写法，取第一处定义。 */
function token(name: string): string {
  const m = CSS.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`globals.css 里找不到令牌 --${name}`);
  return m[1].trim();
}

/** sRGB 分量 → 线性光。WCAG 2.x 相对亮度公式的那一段。 */
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`不是六位十六进制颜色：${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => toLinear(parseInt(h.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** WCAG 1.4.11 对图形对象的下限。**不四舍五入** —— 所以这里用 `>=` 比原值。 */
const FLOOR = 3;

const SERIES = ["c1", "c2", "c3", "c4", "c5", "c6"] as const;
/** 柱子实际坐在哪两种底上：面色是卡片，纸色是卡片外那层。两个都要过。 */
const GROUNDS = ["paper", "surface"] as const;

describe("图表色板", () => {
  it("六条分类色都在", () => {
    // 少一条就说明有人删了色板里的一格，而 `barVars` 是按 6 取模循环的 ——
    // 少一格会让第 6 个系列取到 `var(--c6)` 这个不存在的变量，屏幕上那根柱子直接没颜色。
    for (const s of SERIES) expect(token(s)).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it.each(SERIES)("%s 对纸色和面色都不低于 3:1", (s) => {
    const c = token(s);
    for (const g of GROUNDS) {
      const r = contrast(c, token(g));
      expect(
        r,
        `--${s} (${c}) 对 --${g} (${token(g)}) 只有 ${r.toFixed(2)}:1，低于 WCAG 1.4.11 的 3:1`,
      ).toBeGreaterThanOrEqual(FLOOR);
    }
  });

  it("暗端比本色更暗 —— 渐变只许往暗走", () => {
    /*
     * 这一条钉的是**方向**，不是数值。
     *
     * 第一版是有 `-lit` 那一档的（本色往亮里加 0.05），上面那条对比度测试当场把它
     * 抓了出来：`--c4-lit` 对纸色只有 2.96:1。根因不是那个数取大了 —— 六条本色是
     * 按对比度解出来的，离线最近的那条往上没有空间。
     *
     * 所以口径改成「只往暗走」，而这条测试守的就是这个口径：**浅底上颜色越深，
     * 对比度只增不减**，往暗走的渐变永远不会把任何一条带到线下。哪天有人为了
     * 「再亮一点」把暗端调得比本色浅，这里会红。
     */
    for (const s of SERIES) {
      const base = relativeLuminance(token(s));
      const dim = relativeLuminance(token(`${s}-dim`));
      expect(dim, `--${s}-dim 不比 --${s} 更暗`).toBeLessThan(base);
    }
  });

  it("序列色阶是单调的 —— 一个量从小到大，颜色不许中途回头", () => {
    /*
     * 序列色阶用来表示「一个量的大小」。它唯一的硬要求是**单调**：
     * 中间某一档比它两边都亮或都暗，读的人就会以为那一档是个极值。
     *
     * 这种坏法在色板表上完全看不出来（六个色块摆在一起是好看的），
     * 只有真拿去画一张热力图才会现形 —— 而那时已经在屏幕上了。
     */
    const lum = [1, 2, 3, 4, 5, 6].map((i) => relativeLuminance(token(`seq-${i}`)));
    for (let i = 1; i < lum.length; i += 1) {
      expect(lum[i], `--seq-${i + 1} 不比 --seq-${i} 更暗，色阶在这里回头了`).toBeLessThan(
        lum[i - 1],
      );
    }
  });
});
