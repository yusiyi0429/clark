import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 工作区可能是 CRLF（autocrlf），统一成 LF 再比。
const css = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** 取某个查询块（到下一个顶格 `}` 为止）；块不在就是空串，断言会直接失败。 */
const block = (source: string, head: string) => {
  const start = source.indexOf(head);
  if (start < 0) return "";
  const end = source.indexOf("\n}", start);
  return source.slice(start, end < 0 ? undefined : end + 2);
};

// docs/superpowers/specs/2026-10-12-mobile-foldable.md §2、§3.3、§3.6、§3.9：手持与触屏的点触下限、手持字号。
describe("handheld battlefield CSS", () => {
  it("gives the annotate-to-conversation button a 44 hit area on handheld and touch only", () => {
    const refs = css("./card-references.module.css");
    const touch = block(refs, "@media(max-width:959px),(pointer:coarse){");
    expect(touch).toContain(".quoteButton:not(.corner){position:relative}");
    expect(touch).toContain('.quoteButton::after{content:"";position:absolute;');
    expect(touch).toContain("width:var(--touch-hit,44px);height:var(--touch-hit,44px)");
    // 议题行外壳 overflow:hidden 会裁掉外扩热区：这里按钮本体放到 44，视觉底色挪到 ::before。
    expect(touch).toContain("div[data-urgency]>.quoteButton{width:var(--touch-hit,28px)!important;height:var(--touch-hit,28px)!important}");
    expect(touch).toContain("div[data-urgency]>.quoteButton::before");
    // 鼠标电脑（查询之外）仍是 28 / 手机窄屏 27 的原尺寸。
    const outside = refs.replace(touch, "");
    expect(outside).toContain("width:28px!important;height:28px!important");
    expect(outside).toContain(".quoteButton{width:27px!important;height:27px!important}");
    expect(outside).not.toContain("--touch-hit");
    // 角标变体是 absolute，不能被改成 relative。
    expect(refs).toContain(".corner{position:absolute;right:12px;top:12px}");
  });

  it("makes battlefield issue rows 15px with a 52px minimum on handheld, and tappable rows 44", () => {
    const detail = css("./battlefield-detail.module.css");
    const touch = block(detail, "@media(max-width:959px),(pointer:coarse){\n.mission{");
    expect(touch).toContain(".mission{min-height:var(--touch-hit,44px)");
    expect(touch).toContain(".progressMore{display:inline-flex");
    expect(touch).toContain(".pendingDecisions button,.campaignIssues button{min-height:var(--touch-hit,44px)");
    const hand = block(detail, "@media(max-width:959px){\n.box div[data-urgency]{");
    expect(hand).toContain(".box div[data-urgency]{min-height:52px}");
    expect(hand).toContain(".box div[data-urgency]>button:not([data-reference-id]){height:auto;min-height:52px;font-size:15px}");
    expect(hand).toContain(".box div[data-urgency] small{font-size:14px}");
    expect(hand).toMatch(/\.owner,\.empty,\.metricSources\{font-size:14px\}/);
    expect(hand).toMatch(/\.feedback li>span[^{]*\{font-size:13px\}/);
    // 电脑上的原字号还在（查询外）。
    expect(detail).toContain(".owner{margin:-14px 0 0;font-size:13px;");
    expect(detail).toContain(".mission{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;width:100%;padding:9px 0 4px;");
  });

  it("keeps the segmented view switch and earlier handheld type floors", () => {
    const detail = css("./battlefield-detail.module.css");
    expect(detail).toContain("@media(max-width:959px),(pointer:coarse){.viewSwitch.viewSwitch{margin-bottom:calc((1.4 * var(--type-page, 24px) - 42px) / 2)}");
    expect(detail).toContain("@media(max-width:959px){.milestones.milestones>li,.mission.mission>small,.note.note{font-size:14px}");
    expect(detail).toContain(".campaignStatus.campaignStatus,.campaignDraft.campaignDraft");
    expect(detail).toContain(".detail[data-tab=decisions]{width:100%;max-width:840px;margin-inline:auto}");
  });

});
