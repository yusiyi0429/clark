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

  it("新首页深色下，主题外框里的输入框、右侧浮出面板也换深色（globals.css 在外框里把输入框变量重设成浅色）", () => {
    const DARK = ':root[data-theme="tianshu"][data-color-scheme="dark"]:has([data-scheme="auto"])';
    const scheme = readFileSync(new URL("../../app/scheme-dark.css", import.meta.url), "utf8");
    const fields = scheme.split("}").find((block) => block.includes(`${DARK} [data-ts-theme]`)) ?? "";
    for (const name of ["--field-bg", "--field-ink", "--field-placeholder", "--field-border", "--field-border-focus"]) expect(fields).toContain(`${name}:`);
    const panel = readFileSync(new URL("../ui/side-panel.module.css", import.meta.url), "utf8");
    // 页头那层渐变读 --ts-reading-surface（运行时没定义，退回浅色 #fcfdfe）：深色时面板里给它同一个底色。
    expect(panel).toContain(`:global(${DARK}) .panel { background: var(--surface); --ts-reading-surface: var(--surface); }`);
    // header-capsule 把页头标题和返回键写死成浅色用的深字（同会议页 meeting-view 的覆盖）。
    expect(panel).toContain(`:global(${DARK}) .panel :global(.ts-detail-header > h1) { color: var(--ink); }`);
    expect(panel).toContain(`:global(${DARK}) .panel :global(.ts-detail-header > .ts-row > .button:first-child) { color: var(--ink-muted); }`);
  });
});
