import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * 手机端规范 §2 / §3.4 / §3.5（docs/superpowers/specs/2026-10-12-mobile-foldable.md）：会议页与议题页的点触下限。
 * 手持（≤959）或触屏（pointer: coarse）下小钮热区 ≥44（--touch-hit，globals.css 只在这两种情形定义）；鼠标的电脑不变，
 * 所以这里一边断言新增的 @media 块，一边断言原有的桌面规则原样还在、阅读容器没有被设成内层滚动框。
 */
const css = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const QUERY = "@media (max-width: 959px), (pointer: coarse) {";

/** 取最后一个手持 / 触屏块（本次新增的都追加在文件末尾），到下一个顶格的 `}` 为止。 */
function touchBlock(source: string): string {
  const start = source.lastIndexOf(QUERY);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  return source.slice(start, end + 2);
}

/** 新增手持块（连同它前面的说明注释）之前的全部内容。 */
function beforeTouch(source: string): string {
  return source.slice(0, source.lastIndexOf("/*", source.lastIndexOf(QUERY)));
}

describe("handheld meeting and issue pages", () => {
  it("meeting: the toc button, the action row and the title pencil reach 44 and wrap instead of overflowing", () => {
    const source = css("./meeting-workspace.module.css");
    const block = touchBlock(source);
    // 「目录」钮：双类名压过 13px 的字号规则，高 44，弹层顺着往下挪。
    expect(block).toMatch(/\.tocToggle\.tocToggle \{[^}]*height: var\(--touch-hit, 44px\)/);
    expect(block).toMatch(/\.tocPanel \{ top: calc\(var\(--touch-hit, 44px\) \+ 6px\)/);
    expect(block).toMatch(/\.tocList button \{ min-height: var\(--touch-hit, 44px\)/);
    // 「结束会议 / 重新预审 / 取消会议」一排：每颗 44 高，字 14，折行。
    expect(block).toMatch(/\.toolbar > button \{ min-height: var\(--touch-hit, 44px\);[^}]*font-size: 14px/);
    expect(block).toMatch(/\.toolbar \{[^}]*gap: 8px/);
    expect(source).toMatch(/\.toolbar\{[^}]*flex-wrap:wrap/);
    expect(block).toMatch(/\.stageActions \{ flex-wrap: wrap; \}/);
    expect(block).toMatch(/\.stageActions button \{ min-height: var\(--touch-hit, 44px\)/);
    // 取消会议仍是次级：没有给 .toolbar 的钮加底色或描边。
    expect(block).not.toMatch(/\.toolbar > button \{[^}]*background/);
    // 编辑会议铅笔与妙记候选弹层的钮。
    expect(block).toMatch(/\.workspace \.titleEdit \{ width: var\(--touch-hit, 44px\); height: var\(--touch-hit, 44px\)/);
    expect(block).toMatch(/\.candidateFooter \{ flex-wrap: wrap; \}/);
    expect(block).toMatch(/\.candidateDiscard, \.candidateCancel, \.candidateConfirm \{[^}]*min-height: var\(--touch-hit, 44px\)/);
  });

  it("meeting: the desktop rules are still there", () => {
    const source = css("./meeting-workspace.module.css");
    expect(source).toContain(".toolbar{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:4px}");
    expect(source).toContain(".toolbar>button{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;");
    expect(source).toContain(".tocBar{position:sticky;top:calc(var(--detail-header-height,48px) + 6px);z-index:3;display:flex;justify-content:flex-end;height:0}");
    expect(source).toContain(".tocToggle{display:inline-flex;align-items:center;gap:6px;height:32px;");
    expect(source).toContain(".stageActions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}");
    expect(source).toContain("@media(pointer:coarse){.workspace .titleEdit{width:40px;height:40px}}");
    // 桌面规则不在任何手持块之外被改写：新块之前的内容原样保留，新块之外没有 var(--touch-hit。
    const outside = beforeTouch(source);
    expect(outside).not.toContain("--touch-hit");
  });

  it("meeting header: the end-meeting button in the timer popover is 44 high on handheld", () => {
    const source = css("./meeting-header.module.css");
    expect(touchBlock(source)).toMatch(/\.end\.end \{[^}]*min-height: var\(--touch-hit, 44px\);[^}]*min-width: 72px/);
    expect(source).toContain(".end.end { justify-self: start; margin-top: 4px; }");
    expect(source).toContain(".capsule { width: 104px; height: 100%; min-height: 44px; border-radius: 22px; }");
    expect(beforeTouch(source)).not.toContain("--touch-hit");
  });

  it("issue header: the more (...) button, its menu rows and the dismiss reason input are 44 on handheld / coarse; the pane-narrow header keeps the button 44", () => {
    const source = css("./issue-more.module.css");
    const block = touchBlock(source);
    expect(block).toMatch(/\.more\.more \{[^}]*width: 44px;[^}]*height: 44px/);
    expect(block).toMatch(/\.list \.row\.row \{[^}]*min-height: 44px/);
    expect(block).toMatch(/\.field input \{ min-height: var\(--touch-hit, 44px\); \}/);
    expect(source).toMatch(/@container pane \(max-width: 599px\) \{\s*\.more\.more \{[^}]*height: 44px/);
    // 默认的桌面尺寸不变：32×32 的钮。
    expect(source.slice(0, source.lastIndexOf(QUERY))).toMatch(/\.more\.more \{[^}]*width: 32px;[^}]*height: 32px/);
  });

  it("issue: the follow-up button and the other reading buttons are 44 high, without turning the reading column into a scroller", () => {
    const source = css("./issue-workspace.module.css");
    const block = touchBlock(source);
    expect(block).toMatch(/\[data-type-scale=doc\] \.reading :global\(\.button\) \{[^}]*min-height: var\(--touch-hit, 44px\)/);
    // 议题页字号只取 --doc-type-* 档（issueTypography.test.ts），所以这个块里不写字号。
    expect(block).not.toMatch(/font-size/);
    expect(block).toMatch(/\[data-type-scale=doc\] \.reading \.judgment > button \{[^}]*min-width: 72px/);
    expect(block).toMatch(/\.workspace \.meetingCard \{ min-height: var\(--touch-hit, 44px\); \}/);
    // 只改尺寸：新块里不出现 overflow / overscroll。
    expect(block).not.toMatch(/overflow|overscroll/);
    // 原有规则。
    expect(source).toContain(".judgment>p{margin:0;font-size:var(--doc-type-body);");
    expect(source).toContain(".judgment>button{margin-top:16px}");
    expect(source).toContain("[data-type-scale=doc] .reading :global(.button){font-size:var(--doc-type-meta);");
    expect(source).toContain("@media(pointer:coarse){.workspace .meetingCard{min-height:44px}}");
    expect(beforeTouch(source)).not.toContain("--touch-hit");
  });

  it("decision layers shared by issue and meeting: evidence chips get a transparent 44 hit area, small buttons reach 44", () => {
    const source = css("./decision-workspace.module.css");
    const block = touchBlock(source);
    // 依据胶囊：版面不变，::after 外扩热区。
    expect(block).toMatch(/\.sourceChip \{ position: relative; \}/);
    expect(block).toMatch(/\.sourceChip::after \{[^}]*position: absolute;[^}]*calc\(\(100% - var\(--touch-hit, 44px\)\) \/ 2\)/);
    expect(block).toMatch(/\.errorLine button, \.knowledgeRetry, \.drawerAction \{ min-height: var\(--touch-hit, 44px\)/);
    expect(block).toMatch(/\.drawerClose \{ width: var\(--touch-hit, 44px\); height: var\(--touch-hit, 44px\)/);
    expect(block).toMatch(/\.returnChip > button \{ min-height: var\(--touch-hit, 44px\)/);
    expect(block).toMatch(/\.inactive > summary \{ padding-block: 13px; \}/);
    expect(block).not.toMatch(/overflow|overscroll/);
    // 原有规则。
    expect(source).toContain(".sourceChip{display:inline-flex;align-items:center;gap:3px;max-width:100%;padding:3px 8px;");
    expect(source).toContain(".drawerClose{display:grid;flex:none;place-items:center;width:30px;height:30px;");
    expect(source).toContain("@container pane (max-width: 700px){.drawer{top:auto;right:8px;bottom:8px;left:8px;width:auto;height:min(82%,640px)}}");
    expect(beforeTouch(source)).not.toContain("--touch-hit");
  });
});
