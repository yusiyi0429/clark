// 两种互相独立的办法生成内容相同的文件：一份测试里手搭，一份用 python-docx / openpyxl 存（fixtures/docText，见 make_samples.py）。
// 转出来的文字必须逐字节一样。
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { docToText } from "../src/docText/index.js";
import { makeDocx, makeXlsx, p } from "./docTextFiles.js";

const sample = (name: string) => fileURLToPath(new URL(`./fixtures/docText/${name}`, import.meta.url));

function md(r: ReturnType<typeof docToText>): string {
  if (!r.ok) throw new Error(r.message);
  return r.markdown;
}

describe("手搭的和 python 库存的，转出来一样", () => {
  it("Word：python-docx", () => {
    const tc = (t: string) => `<w:tc>${p(t)}</w:tc>`;
    const body =
      p("周报", '<w:pStyle w:val="Title"/>') +
      p("本周进展", '<w:pStyle w:val="Heading1"/>') +
      '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>新首页</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>按计划</w:t></w:r><w:r><w:t>推进。</w:t></w:r></w:p>' +
      "<w:p><w:r><w:t>A &amp; B &lt;C&gt;</w:t><w:tab/><w:t>D</w:t><w:br/><w:t>第二行</w:t></w:r></w:p>" +
      p("首页", '<w:pStyle w:val="ListBullet"/>') +
      p("右栏", '<w:pStyle w:val="ListBullet"/>') +
      p("先对样例", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>') +
      p("再上预发", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>') +
      p("细节", '<w:pStyle w:val="Heading2"/>') +
      `<w:tbl><w:tr>${tc("事项")}${tc("进展评估")}</w:tr><w:tr>${tc("新首页")}${tc("良好")}</w:tr></w:tbl>`;
    const fromPython = md(docToText(sample("python-docx.docx")));
    expect(fromPython).toBe(md(docToText(makeDocx(body), "docx")));
    expect(fromPython).toContain("A & B \\<C\\>\tD\n第二行");
  });

  it("Excel：openpyxl（公式不带缓存值、日期是自定义格式、字符串走共享表）", () => {
    const data =
      '<row r="1"><c r="A1" t="inlineStr"><is><t>项目</t></is></c><c r="B1" t="inlineStr"><is><t>金额</t></is></c><c r="C1" t="inlineStr"><is><t>日期</t></is></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>新首页</t></is></c><c r="B2"><v>1200</v></c><c r="C2" s="1"><v>46337</v></c></row>' +
      '<row r="3"><c r="A3" t="inlineStr"><is><t>右栏</t></is></c><c r="B3"><v>800.5</v></c><c r="C3" s="1"><v>46337.5</v></c></row>' +
      '<row r="4"><c r="A4" t="inlineStr"><is><t>合计</t></is></c><c r="B4"><f>SUM(B2:B3)</f><v>2000.5</v></c><c r="C4" t="b"><v>1</v></c></row>' +
      '<row r="6"><c r="A6" t="inlineStr"><is><t>合并说明</t></is></c></row>';
    const handmade = makeXlsx([
      { name: "预算", data, after: '<mergeCells count="1"><mergeCell ref="A6:B6"/></mergeCells>' },
      { name: "备注", data: '<row r="2"><c r="B2" t="inlineStr"><is><t>隐藏表里的字</t></is></c></row>', state: "hidden" },
    ]);
    const fromPython = docToText(sample("openpyxl.xlsx"));
    expect(md(fromPython)).toBe(md(docToText(handmade, "xlsx")));
    expect(fromPython.ok && fromPython.kind === "xlsx" && fromPython.sheets.map((s) => [s.name, s.hidden])).toEqual([["预算", false], ["备注", true]]);
  });
});
