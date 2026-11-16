import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { frameScheme } from "./frameScheme";

const root = (scheme: string | null) => ({ getAttribute: (name: string) => (name === "data-color-scheme" ? scheme : null) });

describe("二级页框跟着外观走", () => {
  it("新首页外壳里、外观是深色才套深色；老页面没有外壳，照旧浅色", () => {
    expect(frameScheme(root("dark"), true)).toBe("dark");
    expect(frameScheme(root("light"), true)).toBe("light");
    expect(frameScheme(root("dark"), false)).toBe("light");
    expect(frameScheme(null, true)).toBe("light");
  });

  it("约会议侧栏、会议页换 Mission 的样式只读变量，不写死颜色", () => {
    const css = readFileSync(new URL("../meeting/meeting-decisions.module.css", import.meta.url), "utf8");
    expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  });
});
