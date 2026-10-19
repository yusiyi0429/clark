import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Windows 检出（autocrlf）是 CRLF，断言按 LF 书写：读入后统一换行。
const css = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** 取出以 header 开头的整个 at-rule 块（按花括号配对），找不到返回 undefined。 */
function block(source: string, header: string): string | undefined {
  const start = source.lastIndexOf(header);
  if (start < 0) return undefined;
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && (depth -= 1) === 0) return source.slice(open + 1, i);
  }
  return undefined;
}

/** 手机端雷达（docs/superpowers/specs/2026-10-12-mobile-foldable.md §2 §3.7 §3.8）。 */
describe("handheld radar CSS", () => {
  const source = css("./radar-feed.module.css");

  it("collapses the toolbar into two rows with the same rules for single screen and the dual-screen pane", () => {
    const media = block(source, "@media (max-width: 599px) {\n  .feed .toolbar {");
    const container = block(source, "@container pane (max-width: 599px)");
    expect(media).toBeTruthy();
    expect(container).toBeTruthy();
    // 双屏右页（pane 容器）与单屏必须是同一套。
    expect(container).toBe(media);
    // 第一行：不折行、横向滑动、藏滚动条、子项不收缩。
    expect(media).toMatch(/\.toolbarGroups \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto;[^}]*scrollbar-width: none/);
    expect(media).toContain(".toolbarGroups::-webkit-scrollbar { display: none; }");
    expect(media).toContain(".feed .toolbarGroups > * { flex: none; }");
    expect(media).toContain(".feed .toolbarGroups .filters { flex-wrap: nowrap; }");
    // 第二行：占整行，竖线隐藏，监测范围 / 发现更多只留图标（font-size:0，不 display:none 以保留读屏名）。
    expect(media).toMatch(/\.toolbarActions \{[^}]*width: 100%/);
    expect(media).toContain(".toolbarRule { display: none; }");
    expect(media).toMatch(/\.toolbarActions > button \{[^}]*width: 44px;[^}]*height: 44px;[^}]*font-size: 0;/);
    expect(media).toMatch(/\.toolbarActions > button svg \{ width: 18px; height: 18px; \}/);
    expect(media).toContain(".toolbarRule + button { margin-left: auto; }");
    expect(media).not.toMatch(/\.toolbarActions > button \{[^}]*display: none/);
  });

  it("keeps toolbar buttons at the touch hit size on handheld or coarse pointers only", () => {
    const touch = block(source, "@media (max-width: 959px), (pointer: coarse) {\n  .feed .toolbar button");
    expect(touch).toBeTruthy();
    expect(touch).toContain(".feed .toolbar button { min-height: var(--touch-hit, 36px); font-size: 14px; }");
    // 信号阅读页头收藏钮 44×44。
    expect(touch).toMatch(/\.article \.meta button \{[^}]*width: var\(--touch-hit, 36px\);[^}]*height: var\(--touch-hit, 36px\);/);
  });

  it("reads the signal summary at 16px with 13px labels on handheld", () => {
    const handheld = block(source, "@media (max-width: 959px) {\n  .reader .article .brief > p");
    expect(handheld).toBeTruthy();
    expect(handheld).toMatch(/\.brief > p \{ font-size: 16px !important; line-height: 1\.7 !important; \}/);
    expect(handheld).toMatch(/\.briefLabel \{ font-size: 13px; \}/);
    // 「战略锚点」那行。
    expect(handheld).toMatch(/\.briefTag \{ font-size: 13px;/);
    // 原文正文 16.5 不动。
    expect(source).toContain("@media(max-width:599px){.article .body>p{font-size:16.5px!important");
  });

  it("leaves the desktop defaults untouched", () => {
    expect(source).toContain(".feed{max-width:772px;padding-bottom:120px}");
    expect(source).toContain(".feed{max-width:1150px;margin:auto;padding:0 4px 80px;color:#25262b}");
    expect(source).toContain(".toolbar{flex-wrap:nowrap}");
    expect(source).toContain(".toolbarRule{width:1px;height:18px;margin:0 4px;background:#dfe3ea}");
    expect(source).toContain(".article .brief>p{margin:0!important;font-size:14px!important;line-height:1.75!important;color:#4a515d}");
    expect(source).toContain(".brief .briefLabel{margin-right:8px;font-size:12px;");
    // 新规则都包在手持 / 触屏 / 手机宽的查询里，没有裸写在顶层。
    expect(source.slice(source.indexOf("手机端雷达（docs/")).match(/^\.(feed|reader|article)[^\n]*\{/gm)).toBeNull();
  });
});
