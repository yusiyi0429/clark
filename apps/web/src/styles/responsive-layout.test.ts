import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

describe("responsive workspace CSS", () => {
  it("follows the ts-design responsive contract: phone notices-home, fold keeps the normal overview", () => {
    const source = css("./app-shell.module.css");
    // 全局输入条在各宽度都可达（clark / ts-design v0.4：手机首页、平板总览与桌面均显示 ConversationDock）。
    expect(source).not.toContain(':global([data-testid="global-controls"]){display:none}');
    // 691–1000 未提供专属阅读桌面：沿用普通总览，不隐藏首页板与通知栏（clark 的空白折叠态即此处缺陷）。
    expect(source).not.toMatch(/max-width:1000px\)\{[^}]*\.homeSurface\{display:none\}/);
    expect(source).not.toContain(".foldMaterialSurface");
    // ≤690：通知即首页；打开详情是 48px 窄条 + 正文。
    expect(source).toMatch(/@media\(max-width:690px\)\{\s*\.shell\{[^}]*display:block/);
    expect(source).toContain(".shell[data-detail-open=true]{--main-start:62px;--shell-edge:8px;--strip-width:48px;--notice-width:48px}");
    // 任何详情打开时，通知栏在所有宽度折成窄条。
    expect(source).toContain(".shell[data-detail-open=true]{--notice-width:var(--strip-width)}");
  });

  it("renders the settings page as a 2448-wide 2×2 grid of 44-high inputs", () => {
    const source = css("./config.module.css");
    expect(source).toContain("max-width:2448px");
    expect(source).toContain(".grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;max-width:2448px;align-items:start}");
    expect(source).toContain("height:44px;border:0;outline:1px solid #d9dde5;border-radius:10px");
    expect(source).toContain("@media(max-width:900px){.grid{grid-template-columns:minmax(0,1fr)}.tall,.ltco{height:auto}}");
  });

  it("stacks the battlefield management columns below 1100px", () => {
    const source = css("./battlefield-management.module.css");
    expect(source).toContain("@media(max-width:1100px){.body{flex-direction:column}.left{width:100%}.listCard,.relatedCard,.pickCard{height:auto}.confirm{right:24px;left:auto}}");
  });

  it("lays the home battlefield grid as clark's 2/1 columns with 公司能力 as the last cell", () => {
    const source = css("./home-board.module.css");
    expect(source).toContain(".battlefields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr))");
    expect(source).toContain(".battlefields { grid-template-columns:minmax(0,1fr); }");
    // 公司能力与战场卡同宽：永远只占一格，同一行按最高的那张拉齐（不再在偶数战场时独占一行）。
    expect(source).not.toContain("grid-column:1/-1");
    expect(source).toContain("align-items:stretch");
  });

  it("keeps both scheduled-meeting side panels reachable below 1000px", () => {
    const source = css("./meeting-workspace.module.css");
    expect(source).not.toContain('.advisorShell>:global([data-testid="meeting-chat-sidebar"]){display:none}');
    expect(source).not.toContain(".priorityContent{display:none}");
    // 会前结论栏不再可折叠（pen 无折叠态）；只有对话栏保留 --rail-stub 收起宽度。
    expect(source.match(/width:var\(--rail-stub\);min-width:var\(--rail-stub\)/g)).toBeNull();
    expect(source).toContain("--rail-stub:52px");
  });

  it("renders the issue workspace inside the shell panel with clark's header and reading column", () => {
    const source = css("./issue-workspace.module.css");
    expect(source).toContain(".workspace{display:flex;flex-direction:column;flex:1;height:100%;min-height:0;overflow:hidden;border-radius:inherit;background:#f8f8fa");
    expect(source).toContain("min-height:96px;box-sizing:border-box;padding:25px 27px;background:linear-gradient(145deg,#ffffffa6,#eef1f6a3)");
    expect(source).toContain(".reading{position:relative;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;padding:24px 28px 48px;min-height:0;line-height:1.8;font-size:16px}");
    expect(source).not.toContain("position:fixed");
  });

  it("clears the global dock on the phone notices-home (clark --notice-bottom-inset)", () => {
    expect(css("./notifications.module.css")).toContain("padding:78px 16px var(--notice-bottom-inset,52px)");
    expect(css("./app-shell.module.css")).toContain("--notice-bottom-inset:calc(112px + env(safe-area-inset-bottom))");
  });

  it("drops the scroll padding for the signal reader (clark data-radar-reader-layout)", () => {
    const source = css("./app-shell.module.css");
    expect(source).toContain(".expandedScroll[data-radar-reader-layout=true]{margin:0;padding:0;overflow:hidden;display:flex;min-width:0}");
    expect(source).toContain(".shell[data-topic-rail=true] .expandedScroll[data-radar-reader-layout=true]{padding:0}");
  });

  it("keeps the radar list and reader on clark's single 772px reading column", () => {
    const source = css("./radar-feed.module.css");
    expect(source).toContain(".feed{max-width:772px;padding-bottom:120px}");
    expect(source).toContain(".reader .article{max-width:772px;padding:22px 26px 40px}");
  });

  it("gives the read-only 监测范围 dialog clark's modal surface and a bounded scroll region", () => {
    const source = css("./anchor-editor.module.css");
    expect(source).toContain(".dialog{position:relative;margin:auto;width:min(780px,calc(100vw - 48px))");
    expect(source).toContain(".scroll{padding:24px 32px 30px;overflow-y:auto;overscroll-behavior:contain;min-height:0;");
  });

  it("uses clark's light-blue lock screen (contour + glint) and 42px coarse-pointer notification controls", () => {
    const access = css("./access.module.css");
    expect(access).toContain("linear-gradient(180deg, #87aef4, #8fa5f0 58%, #adb6ec)");
    expect(access).toContain("animation: contourDraw 1.85s 0.5s forwards");
    expect(access).toContain(".passwordField {");
    expect(css("./notifications.module.css")).toContain("@media(pointer:coarse){.railLock button{width:42px;height:42px;margin:0}}");
  });

  it("stacks the Mission pages: 390 筛选/列表、1217 编辑器与 650 侧栏", () => {
    const overview = css("./mission-overview.module.css");
    expect(overview).toContain(".filters{flex:none;display:flex;flex-direction:column;gap:16px;box-sizing:border-box;width:390px;height:1106px");
    expect(overview).toContain("@media(max-width:1100px){.body{flex-direction:column}.filters{width:100%;height:auto}.listCard{height:auto}");

    const detail = css("./mission-detail.module.css");
    expect(detail).toContain(".sidebar{display:flex;flex:none;flex-direction:column;gap:16px;width:650px;max-width:100%}");
    expect(detail).toContain("@media(max-width:1280px){.body{flex-direction:column}.sidebar{width:100%}}");

    const management = css("./mission-management.module.css");
    expect(management).toContain("width:690px;height:1217px");
    expect(management).toContain("@media(max-width:1400px){.body{flex-direction:column}.listCard,.editor{width:100%;height:auto}");
    expect(management).toContain(".fieldRow[data-columns=two]{grid-template-columns:repeat(2,minmax(0,1fr))}");
  });
});
