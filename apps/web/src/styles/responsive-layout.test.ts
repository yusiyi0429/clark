import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

describe("responsive workspace CSS", () => {
  it("keeps the global conversation dock reachable and aligned below 1000px", () => {
    const source = css("./app-shell.module.css");
    expect(source).not.toContain(':global([data-testid="global-controls"]){display:none}');
    expect(source).toContain("--main-start:calc(20px + max(250px,(100vw - 20px)*.3))");
  });

  it("keeps both scheduled-meeting side panels reachable below 1000px", () => {
    const source = css("./meeting-workspace.module.css");
    expect(source).not.toContain('.advisorShell>:global([data-testid="meeting-chat-sidebar"]){display:none}');
    expect(source).not.toContain(".priorityContent{display:none}");
    // 会前结论栏不再可折叠（pen 无折叠态）；只有对话栏保留 --rail-stub 收起宽度。
    expect(source.match(/width:var\(--rail-stub\);min-width:var\(--rail-stub\)/g)).toBeNull();
    expect(source).toContain("--rail-stub:52px");
  });

  it("insets the narrow issue workspace without relative-position overflow", () => {
    const source = css("./issue-workspace.module.css");
    expect(source).not.toContain("left:9px;right:9px;top:9px;bottom:9px");
    const inset = ".workspace{width:min(1680px,calc(100% - 18px));height:calc(100% - 18px);margin:9px auto";
    expect(source.lastIndexOf(inset)).toBeGreaterThan(source.indexOf("@media(max-width:1280px)"));
  });

  it("clears the floating dock over the stacked narrow notification rail", () => {
    const source = css("./notifications.module.css");
    expect(source).toContain("@media(max-width:690px){.noticeList{padding-bottom:52px}}");
  });

  it("symmetrizes the narrow issue gutter so the workspace stays viewport-centered", () => {
    const source = css("./app-shell.module.css");
    expect(source).toContain(
      "@media(max-width:1250px){.expandedScroll[data-card-kind=issue]{padding-right:18px}}",
    );
    expect(source).toContain(
      "@media(max-width:690px){.expandedScroll[data-card-kind=issue]{padding-right:12px}}",
    );
  });

  it("renders the research tab as a single max-width reading column without touching the summary grid", () => {
    const source = css("./issue-workspace.module.css");
    expect(source).toContain("@media(min-width:1281px){\n .columns[data-tab=research]{display:flex;flex-direction:column;gap:18px}");
    expect(source).toContain(".columns[data-tab=research] .reading{display:block;width:100%;max-width:980px;margin:0 auto");
    // 总结与判断 tab 的 1680 双栏（左 1fr、右 560px）保持原样。
    expect(source).toContain("grid-template-columns:minmax(0,1fr) 560px");
  });

  it("keeps a dismissed issue summary in the judgment column", () => {
    expect(css("./issue-workspace.module.css")).toContain(".unknown{grid-area:judgment;");
  });

  it("keeps the Radar feed at the designed 1680 版心 with a ≥40px horizontal gutter", () => {
    const source = css("./radar-feed.module.css");
    expect(source).toContain(".feed{max-width:1680px;margin:auto;padding:0 40px 80px;");
  });

  it("preserves compact Access geometry and 42px coarse-pointer notification controls", () => {
    expect(css("./access.module.css")).toContain("@media (min-width: 561px) {");
    expect(css("./notifications.module.css")).toContain("@media(pointer:coarse){.railLock button{width:42px;height:42px}}");
  });
});
