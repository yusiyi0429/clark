import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

describe("responsive workspace CSS", () => {
  it("keeps the global conversation dock reachable and aligned below 1000px", () => {
    const source = css("./app-shell.module.css");
    expect(source).not.toContain(':global([data-testid="global-controls"]){display:none}');
    expect(source).toContain("--main-start:calc(20px + max(250px,(100vw - 20px)*.3))");
  });

  it("renders the settings page as a 2448-wide 2×2 grid of 44-high inputs", () => {
    const source = css("./config.module.css");
    expect(source).toContain("max-width:2448px");
    expect(source).toContain(".grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;max-width:2448px;align-items:start}");
    expect(source).toContain("height:44px;border:0;outline:1px solid #d9dde5;border-radius:10px");
    expect(source).toContain("@media(max-width:900px){.grid{grid-template-columns:minmax(0,1fr)}}");
  });

  it("stacks the battlefield management columns below 1100px", () => {
    const source = css("./battlefield-management.module.css");
    expect(source).toContain("@media(max-width:1100px){.body{flex-direction:column}.left{width:100%}.listCard,.relatedCard,.pickCard{height:auto}.confirm{right:24px;left:auto}}");
  });

  it("keeps both scheduled-meeting side panels reachable below 1000px", () => {
    const source = css("./meeting-workspace.module.css");
    expect(source).not.toContain('.advisorShell>:global([data-testid="meeting-chat-sidebar"]){display:none}');
    expect(source).not.toContain(".priorityContent{display:none}");
    // 会前结论栏不再可折叠（pen 无折叠态）；只有对话栏保留 --rail-stub 收起宽度。
    expect(source.match(/width:var\(--rail-stub\);min-width:var\(--rail-stub\)/g)).toBeNull();
    expect(source).toContain("--rail-stub:52px");
  });

  it("stacks the issue workspace to a single column without relative-position overflow", () => {
    const source = css("./issue-workspace.module.css");
    expect(source).not.toContain("left:9px;right:9px;top:9px;bottom:9px");
    const stacked = "@media(max-width:1280px){.workspace{width:100%;padding:16px 20px 40px;overflow:auto}.columns{display:block;overflow:visible}";
    expect(source.lastIndexOf(stacked)).toBeGreaterThan(source.indexOf(".workspace{position:relative"));
  });

  it("clears the floating dock over the stacked narrow notification rail", () => {
    const source = css("./notifications.module.css");
    expect(source).toContain("@media(max-width:690px){.noticeList{padding-bottom:52px}}");
  });

  it("gives the embedded-conversation issue page the full main area like meeting", () => {
    const source = css("./app-shell.module.css");
    expect(source).toContain(
      ".expandedScroll[data-card-kind=meeting],.expandedScroll[data-card-kind=issue]{margin:0;padding:0;overflow:hidden}",
    );
  });

  it("lays every issue status out as the 2480 three-column workbench", () => {
    const source = css("./issue-workspace.module.css");
    expect(source).toContain(".workspace{position:relative;z-index:70;display:flex;flex-direction:column;width:min(2480px,100%);height:100%;margin:auto;box-sizing:border-box;padding:20px 40px 80px");
    expect(source).toContain(".columns{--rail-right:400px;display:grid;grid-template-columns:380px minmax(0,1fr) auto;gap:20px");
    // 旧的双栏 tab 网格与单独的研究阅读列不再存在。
    expect(source).not.toContain("grid-template-columns:minmax(0,1fr) 560px");
    expect(source).not.toContain("data-tab=research");
  });

  it("keeps a dismissed issue summary in the left rail without the old grid areas", () => {
    const source = css("./issue-workspace.module.css");
    expect(source).toContain(".unknown{background:#fff}");
    expect(source).not.toContain("grid-area:");
  });

  it("keeps the Radar feed at the designed 1680 版心 with a ≥40px horizontal gutter", () => {
    const source = css("./radar-feed.module.css");
    expect(source).toContain(".feed{max-width:1680px;margin:auto;padding:0 40px 80px;");
  });

  it("gives the 监测范围 dialog a scrim and a bounded scroll region", () => {
    const source = css("./radar-config.module.css");
    expect(source).toContain(".backdrop{position:fixed;inset:0;z-index:70;background:#0B0F1673;");
    expect(source).toContain(".dialog{position:fixed;inset:0;z-index:71;display:flex;flex-direction:column;");
    expect(source).toContain(".scroll{padding:24px 32px 30px;overflow-y:auto;overscroll-behavior:contain;flex:1;min-height:0;");
    expect(source).not.toContain("::backdrop");
  });

  it("preserves compact Access geometry and 42px coarse-pointer notification controls", () => {
    expect(css("./access.module.css")).toContain("@media (min-width: 561px) {");
    expect(css("./notifications.module.css")).toContain("@media(pointer:coarse){.railLock button{width:42px;height:42px}}");
  });
});
