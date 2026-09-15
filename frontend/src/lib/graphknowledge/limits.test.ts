import { describe, expect, it } from "vitest";

import { P3_MAX_QUERY_CHARS, clip } from "./limits";

describe("clip", () => {
  it("上限是 100 —— 这是服务端的约束，不是我们的选择", () => {
    expect(P3_MAX_QUERY_CHARS).toBe(100);
  });

  it("没超长就只折空白：换行与全角竖线一律折成单个空格", () => {
    expect(clip("一 二\n三｜四")).toBe("一 二 三 四");
  });

  it("超长时断在句读上，不把最后一个词切成两半", () => {
    const long = "甲".repeat(50) + "。" + "乙".repeat(60);
    expect(clip(long)).toBe("甲".repeat(50) + "。");
  });

  it("整句没有标点就硬切到上限", () => {
    expect(clip("丙".repeat(120))).toHaveLength(100);
  });

  it("句读太靠前（< 10 字）就当没找到，硬切 —— 断出两个字的检索式没有意义", () => {
    expect(clip("，" + "丁".repeat(120))).toHaveLength(100);
  });
});
