import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalContext, type LocalRunnerState } from "@/lib/local/LocalRunnerProvider";
import type { LocalPhase } from "@/lib/local/connection";
import { createMockRunner } from "@/lib/local/mock";
import { PhaseLine, installCommand } from "./PluginsPage";

const state = (phase: LocalPhase, extra: Partial<LocalRunnerState> = {}): LocalRunnerState => ({
  runner: createMockRunner(), phase, version: phase === "ready" ? "0.1.0" : null, status: null, models: [], sources: null, folders: [], sessions: [], pairing: null, error: null,
  refresh: vi.fn(), pair: vi.fn(), unpair: vi.fn(), pickFolder: vi.fn(), createFolder: vi.fn(), setIncludePersonal: vi.fn(), ...extra,
});
const render = (value: LocalRunnerState, handheld = false) => renderToStaticMarkup(<LocalContext.Provider value={value}><PhaseLine handheld={handheld} /></LocalContext.Provider>);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("插件页：连本机的几种状态", () => {
  it("浏览器在问：亮「等浏览器授权」，画出那个框，「允许」亮着", () => {
    const html = render(state("prompt"));
    expect(html).toContain('data-testid="local-prompt"');
    expect(text(html)).toContain("等浏览器授权");
    expect(html).toContain("允许");
    expect(text(html)).toContain("重试");
  });
  it("拒过：指到地址栏左边的站点设置，应用窗口在「⋮ › 应用信息」", () => {
    const html = render(state("blocked"));
    expect(html).toContain('data-testid="local-blocked"');
    expect(text(html)).toContain("站点设置");
    expect(text(html)).toContain("本地网络访问 › 允许");
    expect(text(html)).toContain("应用信息");
  });
  it("连上了：没配对给「配对」，配对中显示确认码；配好了写版本", () => {
    expect(text(render(state("unpaired")))).toContain("配对");
    expect(text(render(state("unpaired", { pairing: { code: "4821", state: "waiting" } })))).toContain("确认码 4821");
    expect(text(render(state("ready")))).toContain("v0.1.0");
  });
  it("没装或没开：给安装命令和「复制」，不写为什么", () => {
    const html = render(state("offline"));
    expect(html).toContain('data-testid="local-offline"');
    expect(text(html)).toContain("复制");
    expect(text(html)).toContain("重试");
    expect(text(html)).not.toContain("等浏览器授权");
    expect(installCommand()).toMatch(/^irm .*\/install\.ps1 \| iex$/);
  });
  it("手机上不引导连本机", () => {
    expect(text(render(state("offline"), true))).toBe("在电脑上用");
  });
});
