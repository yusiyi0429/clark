import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { markOverflow } from "./overflowFade";

const css = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = (file: string) => [...css(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1].trim().replace(/\s+/g, " "), body: match[2] }));
const VERTICAL = /mask-image:\s*linear-gradient\(to bottom/;

describe("预览的渐隐（本人 11/18）", () => {
  it("没超出的摘要不渐隐，超出才渐隐", () => {
    const box = (scrollHeight: number, clientHeight: number) => {
      const marks = new Set<string>();
      return { scrollHeight, clientHeight, marks, toggleAttribute: (name: string, on: boolean) => { if (on) marks.add(name); else marks.delete(name); return on; } };
    };
    const short = box(44, 44);
    markOverflow(short);
    expect(short.marks.has("data-over")).toBe(false);
    const long = box(90, 44);
    markOverflow(long);
    expect(long.marks.has("data-over")).toBe(true);
    // 又变短了（窗口变宽、内容换了）：收回。
    markOverflow(Object.assign(long, { scrollHeight: 44 }));
    expect(long.marks.has("data-over")).toBe(false);

    // 新首页自己的样式：往下渐隐的 mask 只挂在 [data-over] 上。
    for (const file of ["styles/home.module.css", "styles/home-pages.module.css", "styles/conversation-bubbles.module.css"]) {
      const fades = rules(file).filter((rule) => VERTICAL.test(rule.body));
      expect(fades.length).toBeGreaterThan(0);
      expect(fades.filter((rule) => !rule.selector.split(",").every((part) => part.includes("[data-over]"))).map((rule) => rule.selector)).toEqual([]);
    }
    // 共用模块的覆盖也只在 [data-over] 上渐隐（修复第 2 轮），见 sharedFade.test.tsx。
  });
});
