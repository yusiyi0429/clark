import { describe, expect, it } from "vitest";

import { compileExpr } from "./expr";

const run = (src: string, vars: Record<string, number> = {}): number | null => {
  const r = compileExpr(src);
  if (!r.ok) throw new Error(`本该编译通过：${r.why}`);
  return r.expr.run(vars);
};

const why = (src: string): string => {
  const r = compileExpr(src);
  if (r.ok) throw new Error("本该被拒");
  return r.why;
};

describe("compileExpr", () => {
  it("先乘除后加减", () => {
    expect(run("2 + 3 * 4")).toBe(14);
    expect(run("(2 + 3) * 4")).toBe(20);
  });

  it("认一元负号", () => {
    expect(run("-3 + 5")).toBe(2);
    expect(run("2 * -3")).toBe(-6);
  });

  it("参数从外面来，缺一个就整条算不出", () => {
    expect(run("price * kw", { price: 0.5, kw: 2 })).toBe(1);
    expect(run("price * kw", { price: 0.5 })).toBeNull();
  });

  it("引到的参数 id 按出现顺序去重", () => {
    const r = compileExpr("a * b / a");
    expect(r.ok && r.expr.ids).toEqual(["a", "b"]);
  });

  it("除零给 null，不给 Infinity", () => {
    // 屏幕上出现 Infinity 时分不出是算式错了还是参数拖到了边界。
    expect(run("10 / x", { x: 0 })).toBeNull();
    expect(run("10 / (a - b)", { a: 3, b: 3 })).toBeNull();
  });

  it("尾巴上剩东西算整条失败，不算前半截能用", () => {
    expect(why("1 + 2 )")).toContain("末尾多出");
    expect(why("1 + 2 3")).toContain("末尾多出");
  });

  it("认不出的写法点名说出来", () => {
    expect(why("Math.pow(2, 3)")).toContain("末尾多出");
    expect(why("price ** 2")).toContain("不认识的写法");
    expect(why("")).toContain("空");
    expect(why("1 +")).toBeTruthy();
    expect(why("(1 + 2")).toContain("右括号");
  });

  it("模型手写的那段 JS 一个字都执行不了", () => {
    for (const src of [
      "process.env.BEDROCK_API_KEY",
      "(function(){return 1})()",
      "fetch('http://x')",
      "a; b",
    ]) {
      expect(compileExpr(src).ok).toBe(false);
    }
  });
});
