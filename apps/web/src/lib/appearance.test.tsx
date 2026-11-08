import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { APPEARANCE_KEY, APPEARANCE_SCRIPT, SCHEME_ATTR } from "./appearanceScript";
import { schemeOf } from "./appearance";
import { Preferences } from "@/components/home/Preferences";

/** 照首屏那段脚本跑一遍：本地存的、系统深不深，返回写到 <html> 上的值和系统变了以后的值。 */
function runScript(stored: string | null, systemDark: boolean) {
  const attrs: Record<string, string> = {};
  let onChange: (() => void) | null = null;
  const query = { matches: systemDark, addEventListener: (_: string, listener: () => void) => { onChange = listener; } };
  const env = {
    document: { documentElement: { setAttribute: (name: string, value: string) => { attrs[name] = value; } } },
    window: { matchMedia: () => query },
    localStorage: { getItem: (key: string) => (key === APPEARANCE_KEY ? stored : null) },
  };
  new Function("document", "window", "localStorage", APPEARANCE_SCRIPT)(env.document, env.window, env.localStorage);
  const first = attrs[SCHEME_ATTR];
  query.matches = !systemDark;
  (onChange as (() => void) | null)?.();
  return { first, afterSystemFlip: attrs[SCHEME_ATTR] };
}

describe("外观（17.2）：跟随系统 / 浅色 / 深色", () => {
  it("首屏脚本在渲染前按本地存的那份写深浅；跟随系统时系统变了跟着变，选定的不跟", () => {
    expect(runScript(null, true)).toEqual({ first: "dark", afterSystemFlip: "light" });
    expect(runScript("system", false)).toEqual({ first: "light", afterSystemFlip: "dark" });
    expect(runScript("dark", false)).toEqual({ first: "dark", afterSystemFlip: "dark" });
    expect(runScript("light", true)).toEqual({ first: "light", afterSystemFlip: "light" });
  });

  it("网页里换外观用同一套算法", () => {
    expect(schemeOf("system", true)).toBe("dark");
    expect(schemeOf("system", false)).toBe("light");
    expect(schemeOf("dark", false)).toBe("dark");
    expect(schemeOf("light", true)).toBe("light");
  });

  it("偏好页：外观三段（跟随系统 / 浅色 / 深色）、通知、缺省预算；不加说明文字", () => {
    const html = renderToStaticMarkup(<Preferences />);
    expect(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).toBe("外观 跟随系统 浅色 深色 通知 缺省预算");
  });
});
