import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { diffLayout, type DiffMode, type FileChanges } from "@/lib/local/fileChanges";
import { edited, REPORT } from "@/lib/local/fileChanges.fixture";
import { ChangeView } from "./ChangeView";

const render = (data: Pick<FileChanges, "before" | "after" | "changes">, mode: DiffMode = "markdown") =>
  renderToStaticMarkup(<ChangeView sections={diffLayout(data, mode)!} mode={mode} />);
const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;

describe("预览里「改动」开着时的正文（第 72 条）", () => {
  it("周报：全文都在；只有那几个字被标出来，表格那一格标在格子里，别处的「良好」不标", () => {
    const html = render(edited(REPORT, [["11 月 13 日（周五）", "11 月 18 日（周三）"], ["良好", "优秀", 1]]));
    expect(html).toMatch(/新首页定在 <del class="[^"]*" data-change="c1" data-anchor="c1">11 月 13 日（周五）<\/del><ins class="[^"]*" data-change="c1">11 月 18 日（周三）<\/ins>上线/);
    expect(html).toMatch(/<td>交付质量<\/td><td>良好<\/td>/);
    expect(html).toMatch(/<td>进展评估<\/td><td><del [^>]*data-change="c2" data-anchor="c2">良好<\/del><ins [^>]*data-change="c2">优秀<\/ins><\/td>/);
    expect(html).toMatch(/<td>协作<\/td><td>良好<\/td>/);
    expect(count(html, /<del /g)).toBe(2);
    expect(count(html, /<ins /g)).toBe(2);
    expect(count(html, /data-anchor=/g)).toBe(2);
    // 不折叠：开头、结尾没改的都在。
    expect(html).toContain("<h1>十一月第二周周报</h1>");
    expect(html).toContain("照整版清单在本地测一遍");


  });

  it("同一段里两处：各标各的，各有自己的 data-change", () => {
    const html = render(edited("开头。\n\n新首页定在周五上线，切换跟着走。\n\n结尾。\n", [["定在", "计划于"], ["跟着走", "同步进行"]]));
    expect(html).toMatch(/<p>新首页<del[^>]*data-change="c1"[^>]*>定在<\/del><ins[^>]*>计划于<\/ins>周五上线，切换<del[^>]*data-change="c2"[^>]*>跟着走<\/del><ins[^>]*>同步进行<\/ins>。<\/p>/);
  });

  it("纯新增一整段：整段垫底色；纯删除一整段：整段淡色划线", () => {
    const added = render({ before: "甲。\n\n乙。\n", after: "甲。\n\n## 新的一节\n\n乙。\n", changes: [{ id: "a", before: { start: 4, end: 4 }, after: { start: 4, end: 13 } }] });
    expect(added).toMatch(/<div class="[^"]*blockIns[^"]*" data-change="a" data-anchor="a" data-block="ins"><h2>新的一节<\/h2><\/div>/);
    expect(added).not.toContain('data-block="del"');
    const removed = render(edited("甲。\n\n要删的一段。\n\n乙。\n", [["要删的一段。\n\n", ""]]));
    expect(removed).toMatch(/blockDel[^"]*" data-change="c1" data-anchor="c1" data-block="del"><p>要删的一段。<\/p><\/div>/);
    expect(removed).not.toContain('data-block="ins"');
  });

  it("跨了结构（删掉标题的井号）退成整块：改前那块划掉、改后那块垫底色，不在字里乱标", () => {
    const html = render(edited("前面。\n\n## 三、上线安排\n\n后面。\n", [["## ", ""]]));
    expect(html).toMatch(/data-block="del"><h2>三、上线安排<\/h2><\/div><div class="[^"]*" data-change="c1" data-block="ins"><p>三、上线安排<\/p><\/div>/);
    expect(html).not.toMatch(/<del /);
  });

  it("新建的文件整份垫底色；删掉的文件整份划掉", () => {
    const fresh = "# 新文件\n\n内容。\n";
    expect(render({ before: null, after: fresh, changes: [{ id: "n", before: { start: 0, end: 0 }, after: { start: 0, end: fresh.length } }] }))
      .toMatch(/data-block="ins"><h1>新文件<\/h1>\s*<p>内容。<\/p><\/div>$/);
    expect(render({ before: "旧的。\n", after: null, changes: [{ id: "d", before: { start: 0, end: 4 }, after: { start: 0, end: 0 } }] }))
      .toMatch(/^<div [^>]*data-block="del"><p>旧的。<\/p><\/div>$/);
  });

  it("纯文本、CSV 等宽：只标改了的字", () => {
    const html = render(edited("项,评估\n交付质量,良好\n进展评估,良好\n", [["良好", "优秀", 1]]), "text");
    expect(html).toMatch(/<pre class="[^"]*">项,评估\n交付质量,良好<\/pre><pre class="[^"]*">进展评估,<span><del [^>]*>良好<\/del><ins [^>]*>优秀<\/ins><\/span><\/pre>/);
  });

  it("Word 转出来的标题、列表里改字照样只标那几个字", () => {
    const html = render(edited("# 合同\n\n- 付款期限：30 天\n- 违约金：5%\n", [["30", "45"]]));
    expect(html).toMatch(/<li>付款期限：<del[^>]*>30<\/del><ins[^>]*>45<\/ins> 天<\/li>/);
  });
});
