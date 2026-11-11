import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { diffLayout, type DiffMode, type FileChanges } from "@/lib/local/fileChanges";
import { edited } from "@/lib/local/fileChanges.fixture";
import { ChangeView, navStops } from "./ChangeView";

const REPORT = [
  "# 十一月周报", "", "## 一、本周做了什么", "", "契约交了。", "", "## 二、卡在哪", "", "兜底还在做。", "",
  "## 三、上线安排", "", "新首页定在 11 月 13 日（周五）上线，Nexus 的切换跟着走。", "", "上线前一天在预发走一遍全链。", "",
  "## 四、要协调的", "", "溪南：预发全链的时间。", "", "晨星：一次运行的合同。", "",
  "## 五、各项评估", "", "| 项 | 评估 |", "| --- | --- |", "| 交付质量 | 良好 |", "| 进展评估 | 良好 |", "",
].join("\n");

const render = (data: Pick<FileChanges, "before" | "after" | "changes">, mode: DiffMode = "markdown", revert: boolean = true) => {
  const sections = diffLayout(data, mode)!;
  return renderToStaticMarkup(<ChangeView sections={sections} mode={mode} current={navStops(sections)[0]?.key ?? null} revert={revert ? { disabled: false, run: vi.fn() } : null} />);
};
const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;

describe("预览里的「改动」照排好版的样子画（第 72 条）", () => {
  it("周报：只有那几个字被标出来，表格那一格标在格子里，交付质量那一格的「良好」不标；没改的收着", () => {
    const html = render(edited(REPORT, [["11 月 13 日（周五）", "11 月 18 日（周三）"], ["良好", "优秀", 1]]));
    expect(html).toMatch(/新首页定在 <del class="[^"]*" data-change="c1" data-anchor="c1">11 月 13 日（周五）<\/del><ins class="[^"]*" data-change="c1">11 月 18 日（周三）<\/ins>上线/);
    expect(html).toMatch(/<td>交付质量<\/td><td>良好<\/td>/);
    expect(html).toMatch(/<td>进展评估<\/td><td><del [^>]*data-change="c2"[^>]*>良好<\/del><ins [^>]*>优秀<\/ins><button[^>]*data-testid="revert-change"[^>]*>恢复这处<\/button><\/td>/);
    expect(count(html, /<del /g)).toBe(2);
    expect(count(html, /<ins /g)).toBe(2);
    expect(count(html, /恢复这处/g)).toBe(2);
    // 开头收起四行，「三、上线安排」前面留两块；两处之间不到 2+2 块的不收。
    expect(html).toContain("没改的 4 行");
    expect(html).toContain("<h2>三、上线安排</h2>");
    expect(html).not.toContain("契约交了");
    // 走到的第一处那一段淡底。
    expect(html).toMatch(/data-on="" data-region="c1"/);
  });

  it("同一段里两处：一段里两个「恢复这处」各跟在自己那处后面", () => {
    const html = render(edited("开头。\n\n新首页定在周五上线，切换跟着走。\n\n结尾。\n", [["定在", "计划于"], ["跟着走", "同步进行"]]));
    expect(html).toMatch(/<p>新首页<del[^>]*>定在<\/del><ins[^>]*>计划于<\/ins><button[^>]*>恢复这处<\/button>周五上线，切换<del[^>]*>跟着走<\/del><ins[^>]*>同步进行<\/ins><button[^>]*>恢复这处<\/button>。<\/p>/);
  });

  it("纯新增一整段：整块标绿；纯删除一整段：整块划掉；都在下面给「恢复这处」", () => {
    const added = render({ before: "甲。\n\n乙。\n", after: "甲。\n\n## 新的一节\n\n乙。\n", changes: [{ id: "a", before: { start: 4, end: 4 }, after: { start: 4, end: 13 } }] });
    expect(added).toMatch(/<div class="[^"]*" data-block="ins"><h2>新的一节<\/h2><\/div>/);
    expect(added).not.toContain('data-block="del"');
    expect(count(added, /恢复这处/g)).toBe(1);
    const removed = render(edited("甲。\n\n要删的一段。\n\n乙。\n", [["要删的一段。\n\n", ""]]));
    expect(removed).toMatch(/data-block="del"><p>要删的一段。<\/p><\/div>/);
    expect(removed).not.toContain('data-block="ins"');
  });

  it("跨了结构（删掉标题的井号）退成整块：改前那块划掉、改后那块标绿，不在字里乱标", () => {
    const html = render(edited("前面。\n\n## 三、上线安排\n\n后面。\n", [["## ", ""]]));
    expect(html).toMatch(/data-block="del"><h2>三、上线安排<\/h2><\/div><div class="[^"]*" data-block="ins"><p>三、上线安排<\/p><\/div>/);
    expect(html).not.toMatch(/<del /);
  });

  it("新建的文件、删掉的文件：整份一块；不给「恢复这处」时没有按钮", () => {
    const fresh = "# 新文件\n\n内容。\n";
    const html = render({ before: null, after: fresh, changes: [{ id: "n", before: { start: 0, end: 0 }, after: { start: 0, end: fresh.length } }] }, "markdown", false);
    expect(html).toMatch(/data-block="ins"><h1>新文件<\/h1>\s*<p>内容。<\/p><\/div>/);
    expect(html).not.toContain("恢复这处");
    const gone = render({ before: "旧的。\n", after: null, changes: [{ id: "d", before: { start: 0, end: 4 }, after: { start: 0, end: 0 } }] }, "markdown", false);
    expect(gone).toMatch(/data-block="del"><p>旧的。<\/p><\/div>/);
  });

  it("纯文本、CSV 等宽：只标改了的字", () => {
    const html = render(edited("项,评估\n交付质量,良好\n进展评估,良好\n", [["良好", "优秀", 1]]), "text");
    expect(html).toMatch(/<pre class="[^"]*">项,评估\n交付质量,良好<\/pre>/);
    expect(html).toMatch(/<pre class="[^"]*">进展评估,<span><del [^>]*>良好<\/del><ins [^>]*>优秀<\/ins><\/span><\/pre>/);
  });

  it("上一处、下一处：能只标字的每处一站，整块标的一段一站", () => {
    const sections = diffLayout(edited("开头。\n\n新首页定在周五上线，切换跟着走。\n\n## 标题\n\n结尾。\n", [["定在", "计划于"], ["跟着走", "同步进行"], ["## ", ""]]), "markdown")!;
    expect(navStops(sections)).toEqual([{ key: "c1", ids: ["c1"] }, { key: "c2", ids: ["c2"] }, { key: "c3", ids: ["c3"] }]);
  });
});
