import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { APPEARANCE_KEY, APPEARANCE_SCRIPT, SCHEME_ATTR, THEME_COLOR } from "./appearanceScript";
import { themeColorOf } from "@/components/ThemeColorSync";
import manifest from "@/app/manifest";
import { schemeOf } from "./appearance";
import { PreferencesPage } from "@/components/home/pages/PreferencesPage";

/** 照首屏那段脚本跑一遍：本地存的、系统深不深，返回写到 <html> 上的值、系统变了以后的值，和写进 <head> 的 theme-color。 */
function runScript(stored: string | null, systemDark: boolean) {
  const attrs: Record<string, string> = {};
  let onChange: (() => void) | null = null;
  const metas: { name: string; content: string }[] = [];
  const query = { matches: systemDark, addEventListener: (_: string, listener: () => void) => { onChange = listener; } };
  const env = {
    document: { documentElement: { setAttribute: (name: string, value: string) => { attrs[name] = value; } },
      createElement: () => ({}), head: { appendChild: (node: { name: string; content: string }) => { metas.push(node); } } },
    window: { matchMedia: () => query },
    localStorage: { getItem: (key: string) => (key === APPEARANCE_KEY ? stored : null) },
  };
  new Function("document", "window", "localStorage", APPEARANCE_SCRIPT)(env.document, env.window, env.localStorage);
  const first = attrs[SCHEME_ATTR];
  query.matches = !systemDark;
  (onChange as (() => void) | null)?.();
  return { first, afterSystemFlip: attrs[SCHEME_ATTR], metas };
}

describe("外观（17.2）：跟随系统 / 浅色 / 深色", () => {
  it("首屏脚本在渲染前按本地存的那份写深浅；跟随系统时系统变了跟着变，选定的不跟", () => {
    expect(runScript(null, true)).toMatchObject({ first: "dark", afterSystemFlip: "light" });
    expect(runScript("system", false)).toMatchObject({ first: "light", afterSystemFlip: "dark" });
    expect(runScript("dark", false)).toMatchObject({ first: "dark", afterSystemFlip: "dark" });
    expect(runScript("light", true)).toMatchObject({ first: "light", afterSystemFlip: "light" });
  });

  it("窗口标题栏、浏览器顶栏的颜色跟着外观（17.2 第 44 条）：首屏脚本在渲染前写一个 theme-color；有新首页那种外壳的页面跟外观，老页面还是原来的色；清单用深色那一套", () => {
    expect(runScript("dark", false).metas).toEqual([{ name: "theme-color", content: "#171919" }]);
    expect(runScript("light", true).metas).toEqual([{ name: "theme-color", content: "#fdfdfe" }]);
    expect(runScript(null, true).metas).toEqual([{ name: "theme-color", content: "#171919" }]);
    expect(themeColorOf("dark", "auto")).toBe(THEME_COLOR.dark);
    expect(themeColorOf("light", "auto")).toBe(THEME_COLOR.light);
    expect(themeColorOf(null, "auto")).toBe(THEME_COLOR.light);
    expect(themeColorOf("dark", "light")).toBe(THEME_COLOR.light);
    expect(themeColorOf("dark", null)).toBe("#1b2543");
    expect(themeColorOf("light", null)).toBe("#1b2543");
    expect(manifest()).toMatchObject({ theme_color: "#171919", background_color: "#171919" });
  });

  it("网页里换外观用同一套算法", () => {
    expect(schemeOf("system", true)).toBe("dark");
    expect(schemeOf("system", false)).toBe("light");
    expect(schemeOf("dark", false)).toBe("dark");
    expect(schemeOf("light", true)).toBe("light");
  });

  it("偏好页：外观三段（跟随系统 / 浅色 / 深色）、通知、缺省预算；不加说明文字", () => {
    const html = renderToStaticMarkup(<PreferencesPage go={() => undefined} />);
    expect(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).toBe("外观 跟随系统 浅色 深色 通知 新 Task 缺省预算 伙伴");
  });
});
