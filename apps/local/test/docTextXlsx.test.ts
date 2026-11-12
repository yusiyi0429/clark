// Excel → 文字：公式写公式、值写值、日期固定格式、合并格只写左上角；同样的内容永远转出同样的文字；结构化结果能定位到行。
import { afterEach, describe, expect, it } from "vitest";
import { DOC_TEXT_LIMITS, docToText, type DocTextSheet } from "../src/docText/index.js";
import { shiftFormula } from "../src/docText/xlsx.js";
import { changedSpan, makeXlsx, noteParts } from "./docTextFiles.js";

function convert(buf: Buffer, ext = "xlsx"): { markdown: string; sheets: DocTextSheet[] } {
  const r = docToText(buf, ext);
  if (!r.ok) throw new Error(r.message);
  if (r.kind !== "xlsx") throw new Error("不是 Excel");
  return r;
}

// 写法一：共享字符串、格子带位置、公式带缓存值、正常压缩
const STRINGS = ["项目", "金额", "日期", "新首页", "右栏", "合计", "合并说明", "隐藏表里的字"];
const budget = (amount = "1200", cached = true) =>
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
  `<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>${amount}</v></c><c r="C2" s="1"><v>46337</v></c></row>` +
  '<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3"><v>800.5</v></c><c r="C3" s="1"><v>46337.5</v></c></row>' +
  `<row r="4"><c r="A4" t="s"><v>5</v></c><c r="B4"><f>SUM(B2:B3)</f>${cached ? `<v>${Number(amount) + 800.5}</v>` : ""}</c><c r="C4" t="b"><v>1</v></c></row>` +
  '<row r="6"><c r="A6" t="s"><v>6</v></c><c r="B6"><v>99</v></c></row>';
const MERGE = '<mergeCells count="1"><mergeCell ref="A6:B6"/></mergeCells>';
const NOTE = '<row r="2"><c r="B2" t="s"><v>7</v></c></row>';

const book = (amount?: string, cached?: boolean) =>
  makeXlsx(
    [
      { name: "预算", data: budget(amount, cached), after: MERGE },
      { name: "备注", data: NOTE, state: "hidden" },
      { name: "图", chart: true },
    ],
    { strings: STRINGS },
  );

const EXPECTED = [
  "## 预算",
  "",
  "|  | A | B | C |",
  "| --- | --- | --- | --- |",
  "| 1 | 项目 | 金额 | 日期 |",
  "| 2 | 新首页 | 1200 | 2026-11-11 |",
  "| 3 | 右栏 | 800.5 | 2026-11-11 12:00:00 |",
  "| 4 | 合计 | =SUM(B2:B3) | TRUE |",
  "| 6 | 合并说明 |  |  |",
  "",
  "## 备注",
  "",
  "|  | A | B |",
  "| --- | --- | --- |",
  "| 2 |  | 隐藏表里的字 |",
  "",
  "## 图",
  "",
  "【图表】",
  "",
].join("\n");

describe("Excel 转文字", () => {
  it("值、公式、日期、合并格子、多张表（含隐藏表、图表页）照转", () => {
    expect(convert(book()).markdown).toBe(EXPECTED);
  });

  it("结构化结果：哪张表、哪一行、哪一列、格子里的字，以及在 Markdown 里的位置", () => {
    const { markdown, sheets } = convert(book());
    expect(sheets.map((s) => [s.name, s.hidden, s.rows.length])).toEqual([["预算", false, 5], ["备注", true, 1], ["图", false, 0]]);
    const total = sheets[0].rows[3];
    expect(total).toMatchObject({ row: 4, cells: [{ col: "A", text: "合计" }, { col: "B", text: "=SUM(B2:B3)" }, { col: "C", text: "TRUE" }] });
    expect(markdown.slice(total.start, total.end)).toBe("| 4 | 合计 | =SUM(B2:B3) | TRUE |");
    expect(sheets[0].rows[4]).toMatchObject({ row: 6, cells: [{ col: "A", text: "合并说明" }] });
    expect(markdown.slice(sheets[1].start, sheets[1].end)).toBe("## 备注\n\n|  | A | B |\n| --- | --- | --- |\n| 2 |  | 隐藏表里的字 |");
    expect(markdown.slice(sheets[2].start, sheets[2].end)).toBe("## 图\n\n【图表】");
  });

  it("同一个文件转两次逐字节一样", () => {
    const buf = book();
    expect(docToText(buf, "xlsx")).toEqual(docToText(Buffer.from(buf), ".XLSX"));
  });

  it("内容不变、换一种写法存的（内联字符串、格子不带位置、共享公式、公式无缓存值、数字写法、自定义日期格式、空样式格子、不压缩、倒序），转出来一样", () => {
    // 写法二：像脚本库另存出来的
    const data =
      '<row r="1" spans="1:3"><c t="inlineStr"><is><t>项目</t></is></c><c t="inlineStr"><is><r><rPr><b/></rPr><t>金</t></r><r><t>额</t></r></is></c><c t="inlineStr"><is><t>日期</t></is></c><c r="Z1" s="2"/></row>' +
      '<row r="2"><c t="inlineStr"><is><t>新首页</t></is></c><c t="n"><v>1.2E3</v></c><c s="2"><v>46337.0</v></c></row>' +
      '<row r="3"><c t="inlineStr"><is><t>右栏</t></is></c><c><v>800.50</v></c><c t="d"><v>2026-11-11T12:00:00</v></c></row>' +
      '<row r="4"><c t="inlineStr"><is><t>合计</t></is></c><c><f>SUM(B2:B3)</f></c><c t="b"><v>1</v></c></row>' +
      '<row r="5" ht="20" customHeight="1"/>' +
      '<row r="6"><c r="A6" t="inlineStr"><is><t>合并说明</t></is></c><c r="B6"/></row>';
    const styles = '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot;"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs>';
    const resaved = makeXlsx(
      [
        { name: "预算", data, after: MERGE, file: "worksheets/budget.xml" },
        { name: "备注", data: '<row r="2"><c r="B2" t="inlineStr"><is><t>隐藏表里的字</t></is></c></row>', state: "hidden", file: "worksheets/note.xml" },
        { name: "图", chart: true },
      ],
      { styles, store: true, reverse: true, extra: [["docProps/core.xml", "<cp:coreProperties xmlns:cp=\"x\"><modified>2026-11-11T10:00:00Z</modified></cp:coreProperties>"]] },
    );
    expect(convert(resaved).markdown).toBe(convert(book()).markdown);
  });

  it("共享公式和逐格写出来的公式，转出来一样", () => {
    const shared =
      '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0">A1*2+$A$1</f><v>3</v></c></row>' +
      '<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>5</v></c></row>' +
      '<row r="3"><c r="A3"><v>3</v></c><c r="B3"><f t="shared" si="0"/><v>7</v></c></row>';
    const expanded =
      '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>A1*2+$A$1</f></c></row>' +
      '<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f>A2*2+$A$1</f></c></row>' +
      '<row r="3"><c r="A3"><v>3</v></c><c r="B3"><f>A3*2+$A$1</f></c></row>';
    const a = convert(makeXlsx([{ name: "表", data: shared }])).markdown;
    expect(a).toBe(convert(makeXlsx([{ name: "表", data: expanded }])).markdown);
    expect(a).toContain("| 3 | 3 | =A3\\*2+$A$1 |");
  });

  it("改了一个格子的值，前后只差那一格", () => {
    expect(changedSpan(convert(book()).markdown, convert(book("1500")).markdown)).toEqual({ before: "2", after: "5" });
    const before = convert(book());
    const after = convert(book("1500"));
    const { before: b } = changedSpan(before.markdown, after.markdown);
    expect(b).toBe("2");
    // 调用方用位置找回是哪一行
    const at = before.markdown.indexOf("| 2 | 新首页 | 1200 |") + "| 2 | 新首页 | 1".length;
    expect(before.sheets[0].rows.find((r) => r.start <= at && at < r.end)?.row).toBe(2);
  });

  it("把公式格子缓存的值清掉，转出来不变", () => {
    expect(convert(book("1200", false)).markdown).toBe(convert(book("1200", true)).markdown);
  });

  it("1904 日期系统、只有时间、_x000D_ 转义、格子里的竖线和换行", () => {
    const data =
      '<row r="1"><c r="A1" s="1"><v>44875</v></c><c r="B1" s="1"><v>0.75</v></c><c r="C1" t="inlineStr"><is><t>a|b_x000D_\n第二行</t></is></c></row>';
    expect(convert(makeXlsx([{ name: "表", data }], { date1904: true })).markdown).toContain("| 2026-11-11 | 18:00:00 | a\\|b<br>第二行 |");
  });

  it("共享字符串：拼音标注（rPh、phoneticPr）去掉，富文本的多段连起来", () => {
    const sst =
      '<si><t>北京</t><rPh sb="0" eb="2"><t>ペキン</t></rPh><phoneticPr fontId="1"/></si>' +
      '<si><r><rPr><b/></rPr><t>进展</t></r><r><rPr><color rgb="FFFF0000"/></rPr><t xml:space="preserve">良好 </t></r><rPh sb="0" eb="1"><t>しんてん</t></rPh><phoneticPr fontId="1" type="noConversion"/></si>';
    const data = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>';
    const { markdown, sheets } = convert(makeXlsx([{ name: "表", data }], { sst }));
    expect(markdown).toContain("| 北京 | 进展良好 |");
    expect(sheets[0].rows[0].cells).toEqual([{ col: "A", text: "北京" }, { col: "B", text: "进展良好 " }]);
  });

  it("布尔、错误值照写；算出错误的公式写公式", () => {
    const data =
      '<row r="1"><c r="A1" t="b"><v>0</v></c><c r="B1" t="e"><v>#N/A</v></c><c r="C1" t="e"><f>VLOOKUP(A1,D:E,2,FALSE)</f><v>#N/A</v></c><c r="D1" t="str"><f>"文"&amp;"字"</f><v>文字</v></c></row>';
    expect(convert(makeXlsx([{ name: "表", data }])).markdown).toContain('| FALSE | #N/A | =VLOOKUP(A1,D:E,2,FALSE) | ="文"&"字" |');
  });

  it("日期只认 styles.xml 里的日期格式；认不准的（时长、带单位的数字）照数字原样", () => {
    const styles =
      '<numFmts><numFmt numFmtId="164" formatCode="[h]:mm:ss"/><numFmt numFmtId="165" formatCode="0.00&quot;万元&quot;"/><numFmt numFmtId="166" formatCode="[$-804]yyyy&quot;年&quot;m&quot;月&quot;"/></numFmts>' +
      '<cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="166"/><xf numFmtId="4"/></cellXfs>';
    const data = '<row r="1"><c r="A1" s="1"><v>1.5</v></c><c r="B1" s="2"><v>12.5</v></c><c r="C1" s="3"><v>46337</v></c><c r="D1" s="4"><v>1234567.891</v></c><c r="E1" s="9"><v>7</v></c></row>';
    expect(convert(makeXlsx([{ name: "表", data }], { styles })).markdown).toContain("| 1.5 | 12.5 | 2026-11-11 | 1234567.891 | 7 |");
  });

  it("格式刷到一百万行、一万多列的空格子不算内容，不撑大表格", () => {
    const data =
      '<row r="1"><c r="A1"><v>1</v></c><c r="B1" s="1"/></row>' +
      Array.from({ length: 200 }, (_, i) => `<row r="${i + 2}" s="1" customFormat="1"><c r="XFD${i + 2}" s="1"/></row>`).join("") +
      '<row r="1048576" s="1" customFormat="1"><c r="XFD1048576" s="1"/></row>';
    const after = '<mergeCells count="1"><mergeCell ref="C3:XFD1048576"/></mergeCells>';
    expect(convert(makeXlsx([{ name: "表", data, after }])).markdown).toBe("## 表\n\n|  | A |\n| --- | --- |\n| 1 | 1 |\n");
  });

  it("批注写在表格后面，按行列排、空的不写、多行缩进；合并区里被盖住的格子存了同样的字也只写左上角", () => {
    // 照本人给的 Excel 文件的写法：标题行合并，被盖住的格子也存了同样的字；批注全在 C 列
    const title = ["A", "B", "C"].map((c) => `<c r="${c}1" t="inlineStr"><is><t>需求分级</t></is></c>`).join("");
    const row = (r: number, no: string, name: string) =>
      `<row r="${r}"><c r="A${r}"><v>${no}</v></c><c r="B${r}" t="inlineStr"><is><t>${name}</t></is></c><c r="C${r}" t="inlineStr"><is><t>说明</t></is></c></row>`;
    const data = `<row r="1">${title}</row>` + row(2, "1", "甲") + row(3, "2", "乙");
    const after = '<mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells><legacyDrawing r:id="rId2"/>';
    const notes = noteParts(1, [["C3", "第二条"], ["C2", "第一行\n第二行"], ["B2", ""]]);
    const { markdown, sheets } = convert(makeXlsx([{ name: "需求", data, after }], { extra: notes }));
    expect(markdown).toBe(
      [
        "## 需求",
        "",
        "|  | A | B | C |",
        "| --- | --- | --- | --- |",
        "| 1 | 需求分级 |  |  |",
        "| 2 | 1 | 甲 | 说明 |",
        "| 3 | 2 | 乙 | 说明 |",
        "",
        "### 批注",
        "",
        "- C2：第一行",
        "  第二行",
        "- C3：第二条",
        "",
      ].join("\n"),
    );
    expect(sheets[0].notes.map((n) => [n.cell, n.text, markdown.slice(n.start, n.end)])).toEqual([
      ["C2", "第一行\n第二行", "- C2：第一行\n  第二行"],
      ["C3", "第二条", "- C3：第二条"],
    ]);
    expect(sheets[0].end).toBe(markdown.length - 1);
  });

  it("公式平移：相对的动、$ 锁住的不动、引号和函数名不动", () => {
    expect(shiftFormula("SUM(B2:B9)", 1, 0)).toBe("SUM(B3:B10)");
    expect(shiftFormula("A1*$B$1+$C2+D$3", 2, 1)).toBe("B3*$B$1+$C4+E$3");
    expect(shiftFormula('IF(A1="A1",LOG10(A1),\'Sheet 1\'!A1)', 1, 0)).toBe('IF(A2="A1",LOG10(A2),\'Sheet 1\'!A2)');
    expect(shiftFormula("SUM(A:A)+SUM(1:1)+Table1[金额]", 1, 1)).toBe("SUM(B:B)+SUM(2:2)+Table1[金额]");
  });
});

describe("Excel 转不了的，明说原因，不抛", () => {
  afterEach(() => {
    DOC_TEXT_LIMITS.maxCells = 200_000;
    DOC_TEXT_LIMITS.maxOutputBytes = 1024 * 1024;
  });

  it("老格式：不支持的格式", () => {
    for (const ext of ["xls", "et"]) expect(docToText(book(), ext)).toMatchObject({ ok: false, reason: "unsupported_format" });
  });

  it("带密码、坏文件、其实是 Word 的", () => {
    const cfb = Buffer.alloc(1024);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(cfb);
    expect(docToText(cfb, "xlsm")).toMatchObject({ ok: false, reason: "encrypted" });
    expect(docToText(Buffer.from("a,b,c\n1,2,3"), "xlsx")).toMatchObject({ ok: false, reason: "corrupt" });
    expect(docToText(makeXlsx([{ name: "表", data: '<row r="1"><c r="A1"><v>1</v>' }]), "xlsx")).toMatchObject({ ok: false, reason: "corrupt" });
  });

  it("格子太多、转出来超过上限", () => {
    DOC_TEXT_LIMITS.maxCells = 10;
    expect(docToText(book(), "xlsx")).toMatchObject({ ok: false, reason: "too_many_cells" });
    DOC_TEXT_LIMITS.maxCells = 200_000;
    // 一个格子在很远的列：一整行空格子撑过上限，转到一半就停
    DOC_TEXT_LIMITS.maxOutputBytes = 10_000;
    expect(docToText(makeXlsx([{ name: "表", data: '<row r="1"><c r="XFD1"><v>1</v></c></row>' }]), "xlsx")).toMatchObject({ ok: false, reason: "output_too_large" });
  });
});
