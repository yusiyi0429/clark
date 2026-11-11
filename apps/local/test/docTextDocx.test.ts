// Word → 文字：结构照转、只留看得见的正文；同样的内容永远转出同样的文字；转不了的明说，不抛。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DOC_TEXT_LIMITS, docToText } from "../src/docText/index.js";
import { changedSpan, makeDocx, makeZip, p } from "./docTextFiles.js";
import { tempDir } from "./helpers.js";

function md(buf: Buffer, ext = "docx"): string {
  const r = docToText(buf, ext);
  if (!r.ok) throw new Error(r.message);
  return r.markdown;
}

const table = (a: string) =>
  "<w:tbl><w:tblPr/>" +
  `<w:tr><w:tc>${p("事项")}</w:tc><w:tc>${p("进展评估")}</w:tc></w:tr>` +
  `<w:tr><w:tc>${p("新首页")}</w:tc><w:tc>${p(a)}</w:tc></w:tr>` +
  "</w:tbl>";

const BODY =
  p("周报", '<w:pStyle w:val="Title"/>') +
  p("本周进展", '<w:pStyle w:val="Heading1"/>') +
  p("新首页按计划推进。") +
  p("首页", '<w:pStyle w:val="ListBullet"/>') +
  p("右栏", '<w:pStyle w:val="ListBullet"/><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr>') +
  p("先对样例", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>') +
  p("再上预发", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>') +
  p("细节", '<w:pStyle w:val="Heading2"/>') +
  table("良好");

const EXPECTED = [
  "# 周报",
  "",
  "# 本周进展",
  "",
  "新首页按计划推进。",
  "",
  "- 首页",
  "    - 右栏",
  "1. 先对样例",
  "1. 再上预发",
  "",
  "## 细节",
  "",
  "| 事项 | 进展评估 |",
  "| --- | --- |",
  "| 新首页 | 良好 |",
  "",
].join("\n");

describe("Word 转文字", () => {
  it("标题、段落、列表、表格照结构转", () => {
    expect(md(makeDocx(BODY))).toBe(EXPECTED);
  });

  it("同一个文件转两次逐字节一样；从路径读和从字节读一样", () => {
    const buf = makeDocx(BODY);
    const file = join(tempDir("doctext-"), "周报.docx");
    writeFileSync(file, buf);
    const a = docToText(buf, ".DOCX");
    const b = docToText(file);
    expect(a).toEqual(b);
    expect(a).toEqual(docToText(buf, "docx"));
  });

  it("内容不变、只是被别的软件另存过（内部编号、拆段方式、样式编号、前缀、压缩方式、条目顺序、时间戳都不同），转出来一样", () => {
    // 另一种写法：样式编号换成本地化的数字、标题样式不写 outlineLvl、字被拆成多段带 rsid、编号用别的 numId、前缀不叫 w、不压缩、倒序、多了带时间戳的 docProps
    const styles =
      '<w:style w:type="paragraph" w:styleId="a"><w:name w:val="Normal"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="a3"><w:name w:val="Title"/><w:basedOn w:val="a"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:basedOn w:val="a"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 2"/><w:basedOn w:val="a"/></w:style>' +
      '<w:style w:type="character" w:styleId="a4"><w:name w:val="Strong"/></w:style>';
    const numbering =
      '<w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>' +
      '<w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:numFmt w:val="chineseCounting"/></w:lvl></w:abstractNum>' +
      '<w:num w:numId="12"><w:abstractNumId w:val="7"/></w:num><w:num w:numId="5"><w:abstractNumId w:val="3"/></w:num>';
    const split = (style: string, ...runs: string[]) =>
      `<w:p w:rsidR="00A1B2C3" w:rsidRDefault="00D4E5F6"><w:pPr>${style}<w:rPr><w:b/></w:rPr></w:pPr>` +
      runs.map((t, i) => `<w:r w:rsidR="00${i}9F3A1"><w:rPr><w:rFonts w:hint="eastAsia"/>${i % 2 ? "<w:b/>" : ""}</w:rPr><w:t>${t}</w:t></w:r><w:proofErr w:type="gramEnd"/>`).join("") +
      '<w:bookmarkStart w:id="0" w:name="_GoBack"/><w:bookmarkEnd w:id="0"/></w:p>';
    const body =
      split('<w:pStyle w:val="a3"/>', "周", "报") +
      split('<w:pStyle w:val="1"/>', "本周", "进展") +
      split("", "新首页", "按计划", "推进。") +
      split('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="12"/></w:numPr>', "首页") +
      split('<w:numPr><w:ilvl w:val="1"/><w:numId w:val="12"/></w:numPr>', "右", "栏") +
      split('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr>', "先对", "样例") +
      split('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr>', "再上预发") +
      split('<w:pStyle w:val="2"/>', "细节") +
      '<w:tbl><w:tblPr><w:tblStyle w:val="a5"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>' +
      `<w:tr w:rsidR="001"><w:tc><w:tcPr><w:tcW w:w="4000"/></w:tcPr>${split("", "事项")}</w:tc><w:tc>${split("", "进展", "评估")}</w:tc></w:tr>` +
      `<w:tr w:rsidR="002"><w:tc>${split("", "新首页")}</w:tc><w:tc>${split("", "良", "好")}</w:tc></w:tr></w:tbl>`;
    const resaved = makeDocx(body, {
      styles,
      numbering,
      prefix: "ns0",
      store: true,
      reverse: true,
      extra: [["docProps/core.xml", '<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dcterms="y"><dcterms:modified>2026-11-11T09:30:00Z</dcterms:modified></cp:coreProperties>']],
    });
    expect(md(resaved)).toBe(md(makeDocx(BODY)));
  });

  it("改了表格里一个格子的字，前后两份文字只差那几个字", () => {
    const before = md(makeDocx(BODY));
    const after = md(makeDocx(BODY.replace(table("良好"), table("优秀"))));
    expect(changedSpan(before, after)).toEqual({ before: "良好", after: "优秀" });
  });

  it("只留看得见的正文：格式、隐藏文字、删掉的修订、批注、域代码不带；图片、图表写占位字；文本框里的字跟在段落后面", () => {
    const body =
      '<w:p><w:r><w:rPr><w:b/><w:color w:val="FF0000"/></w:rPr><w:t>加粗红字</w:t></w:r>' +
      '<w:r><w:rPr><w:vanish/></w:rPr><w:t>隐藏</w:t></w:r>' +
      '<w:del w:id="1" w:author="x"><w:r><w:delText>删掉的</w:delText></w:r></w:del>' +
      '<w:ins w:id="2" w:author="x"><w:r><w:t>插入的</w:t></w:r></w:ins>' +
      '<w:commentRangeStart w:id="3"/><w:r><w:t>，有批注</w:t></w:r><w:commentRangeEnd w:id="3"/><w:r><w:commentReference w:id="3"/></w:r>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      '<w:hyperlink r:id="rId9"><w:r><w:t>，链接</w:t></w:r></w:hyperlink></w:p>' +
      '<w:p><w:r><w:drawing><wp:inline xmlns:wp="x"><a:graphic xmlns:a="y"><a:graphicData><pic:pic xmlns:pic="z"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>' +
      '<w:r><w:drawing><wp:inline xmlns:wp="x"><a:graphic xmlns:a="y"><a:graphicData><c:chart xmlns:c="c"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>' +
      '<w:p><w:r><w:t>见右边框</w:t></w:r><w:r><mc:AlternateContent xmlns:mc="m"><mc:Choice Requires="wps"><w:drawing><wps:txbx xmlns:wps="s"><w:txbxContent>' + p("框里的字") + "</w:txbxContent></wps:txbx></w:drawing></mc:Choice>" +
      "<mc:Fallback><w:pict><v:textbox xmlns:v=\"v\"><w:txbxContent>" + p("框里的字") + "</w:txbxContent></v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>" +
      p("") +
      p("1. 不是列表 *星号* [方括号] a|b");
    expect(md(makeDocx(body))).toBe(
      ["加粗红字插入的，有批注3，链接", "【图片】【图表】", "见右边框", "框里的字", "1\\. 不是列表 \\*星号\\* \\[方括号\\] a|b"].join("\n\n") + "\n",
    );
  });

  it("表格：横向合并补空格、纵向合并只在上面那格写；格子里的竖线、换行转义；嵌套表格压成一格", () => {
    const tc = (inner: string, tcPr = "") => `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ""}${inner}</w:tc>`;
    const body =
      "<w:tbl>" +
      `<w:tr>${tc(p("合并标题"), '<w:gridSpan w:val="2"/>')}${tc(p("C"))}</w:tr>` +
      `<w:tr>${tc(p("上"), '<w:vMerge w:val="restart"/>')}${tc(p("a|b") + p("第二行"))}${tc("<w:tbl><w:tr>" + tc(p("x")) + tc(p("y")) + "</w:tr></w:tbl>" + p(""))}</w:tr>` +
      `<w:tr>${tc(p(""), "<w:vMerge/>")}${tc(p("d"))}</w:tr>` +
      "</w:tbl>";
    expect(md(makeDocx(body))).toBe(["| 合并标题 |  | C |", "| --- | --- | --- |", "| 上 | a\\|b<br>第二行 | x / y |", "|  | d |  |", ""].join("\n"));
  });

  it("超链接、内容控件、AlternateContent、两种域里的字：不丢、不重", () => {
    const body =
      '<w:p><w:hyperlink r:id="rId5" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>官网</w:t></w:r></w:hyperlink>' +
      '<w:sdt><w:sdtPr><w:alias w:val="负责人"/><w:showingPlcHdr/></w:sdtPr><w:sdtContent><w:r><w:t>控件里的字</w:t></w:r></w:sdtContent></w:sdt>' +
      '<w:fldSimple w:instr=" DATE \\@ &quot;yyyy/M/d&quot; "><w:r><w:t>2026/11/11</w:t></w:r></w:fldSimple>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>第5页</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      '<mc:AlternateContent xmlns:mc="m"><mc:Choice Requires="w14"><w:r><w:t>二选一</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t>二选一</w:t></w:r></mc:Fallback></mc:AlternateContent></w:p>' +
      `<w:sdt><w:sdtPr/><w:sdtContent>${p("块级控件")}</w:sdtContent></w:sdt>` +
      `<mc:AlternateContent xmlns:mc="m"><mc:Choice Requires="w14">${p("块级二选一")}</mc:Choice><mc:Fallback>${p("块级二选一")}</mc:Fallback></mc:AlternateContent>`;
    expect(md(makeDocx(body))).toBe("官网控件里的字2026/11/11第5页二选一\n\n块级控件\n\n块级二选一\n");
  });

  it("制表符、换行、分页符、保留的空格、实体", () => {
    const body = '<w:p><w:r><w:t xml:space="preserve">A &amp; B &lt;C&gt; &#x4E2D;&#25991; </w:t><w:tab/><w:t>D</w:t><w:br/><w:t>第二行</w:t><w:br w:type="page"/><w:t>同一行</w:t></w:r></w:p>';
    expect(md(makeDocx(body))).toBe("A & B \\<C\\> 中文 \tD\n第二行同一行\n");
  });

  it("列表编号认不出（numbering.xml 里没有这个编号）时当普通列表项，每次一样", () => {
    const body = p("甲", '<w:numPr><w:ilvl w:val="3"/><w:numId w:val="99"/></w:numPr>') + p("乙", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="99"/></w:numPr>');
    const buf = makeDocx(body);
    expect(md(buf)).toBe("- 甲\n- 乙\n");
    expect(md(buf)).toBe(md(makeDocx(body, { numbering: "" })));
  });

  it("飞书导出的写法：样式表是空的、标题靠段落上直接写的大纲级别、分隔线是没字的带边框段落、格子里多段", () => {
    const h = (text: string, lvl: number) => p(text, `<w:pStyle w:val="${lvl + 1}"/><w:outlineLvl w:val="${lvl}"/><w:spacing w:before="120"/><w:ind w:left="0"/><w:jc w:val="left"/>`);
    const body =
      h("一级标题", 0) +
      p("正文", '<w:spacing w:before="120"/><w:ind w:left="0" w:firstLine="0"/>') +
      '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:color="dee0e3"/><w:between w:val="single" w:color="dee0e3"/></w:pBdr></w:pPr></w:p>' +
      h("二级标题", 1) +
      `<w:tbl><w:tblPr><w:tblW w:w="0"/></w:tblPr><w:tr><w:tc><w:tcPr><w:tcW w:w="100"/><w:tcMar/></w:tcPr>${p("甲")}</w:tc><w:tc>${p("乙")}</w:tc></w:tr>` +
      `<w:tr><w:tc>${p("第一段") + p("第二段")}</w:tc><w:tc>${p("丙")}</w:tc></w:tr></w:tbl>`;
    expect(md(makeDocx(body, { styles: "", numbering: "" }))).toBe("# 一级标题\n\n正文\n\n## 二级标题\n\n| 甲 | 乙 |\n| --- | --- |\n| 第一段<br>第二段 | 丙 |\n");
  });
});

describe("Word 转不了的，明说原因，不抛", () => {
  afterEach(() => {
    DOC_TEXT_LIMITS.maxFileBytes = 50 * 1024 * 1024;
    DOC_TEXT_LIMITS.maxOutputBytes = 1024 * 1024;
  });

  it("老格式和别的扩展名：不支持的格式", () => {
    for (const ext of ["doc", ".wps", "pdf", ""]) {
      const r = docToText(makeDocx(BODY), ext);
      expect(r).toMatchObject({ ok: false, reason: "unsupported_format" });
    }
    expect(docToText("C:/x/老文件.doc")).toMatchObject({ ok: false, reason: "unsupported_format", message: "转不了：不支持的格式（.doc）" });
  });

  it("带密码的文件（外壳是 OLE 容器）", () => {
    const cfb = Buffer.alloc(4096);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(cfb);
    expect(docToText(cfb, "docx")).toMatchObject({ ok: false, reason: "encrypted" });
  });

  it("坏文件、其实不是 Word 的、zip 里没有正文的、XML 坏了的", () => {
    const good = makeDocx(BODY);
    const cases = [
      Buffer.from("这其实是一个文本文件"),
      Buffer.alloc(0),
      good.subarray(0, good.length - 40), // 截断
      makeZip([["hello.txt", "hi"]]), // 是 zip，但不是 Word
      makeDocx("<w:p><w:r><w:t>没关上"), // XML 坏了
    ];
    for (const buf of cases) expect(docToText(buf, "docx")).toMatchObject({ ok: false, reason: "corrupt" });
  });

  it("读不到的路径", () => {
    expect(docToText(join(tempDir("doctext-"), "不存在.docx"))).toMatchObject({ ok: false, reason: "unreadable" });
  });

  it("文件太大、解压出来太大（压缩炸弹）、转出来超过上限", () => {
    DOC_TEXT_LIMITS.maxFileBytes = 1000;
    expect(docToText(makeDocx(BODY + p("x".repeat(5000))), "docx")).toMatchObject({ ok: false, reason: "too_large", message: "转不了：文件太大" });
    DOC_TEXT_LIMITS.maxFileBytes = 50 * 1024 * 1024;

    // 60MB 的空白压成几十 KB，条目里谎报大小
    const bomb = makeZip([["word/document.xml", Buffer.alloc(60 * 1024 * 1024, 0x20)]]);
    bomb.writeUInt32LE(100, bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
    expect(bomb.length).toBeLessThan(200 * 1024);
    expect(docToText(bomb, "docx")).toMatchObject({ ok: false, reason: "too_large" });

    DOC_TEXT_LIMITS.maxOutputBytes = 100;
    expect(docToText(makeDocx(BODY + p("字".repeat(100))), "docx")).toMatchObject({ ok: false, reason: "output_too_large" });
  });
});
