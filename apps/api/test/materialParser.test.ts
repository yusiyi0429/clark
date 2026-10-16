import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { cleanupMaterialTemp, parseMaterialBatch } from "../src/materialParser.js";
import { pdfPageParagraphs, pdfText } from "../src/materialPdfText.mjs";
import { splitMaterialBlocks } from "../src/materialDiff.js";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** 最小 DOCX，可附加文件（图片、.rels）。 */
async function docx(body: string, extra: Record<string, string | Buffer> = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${REL}"><w:body>${body}</w:body></w:document>`);
  for (const [name, content] of Object.entries(extra)) zip.file(name, content);
  return zip.generateAsync({ type: "nodebuffer" });
}
const rels = (...items: string[]) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join("")}</Relationships>`;

/** 两页、每页两行的最小 PDF（Helvetica 文字层）；第一页两行行距 14pt（字号 12），属于同一段的折行。 */
function twoPagePdf(): Buffer {
  const page = (lines: string[]) => `BT /F1 12 Tf 72 720 Td ${lines.map((line, index) => `${index ? "0 -14 Td " : ""}(${line}) Tj`).join(" ")} ET`;
  const streams = [page(["Token upstream review covers routing quality and", "cost for every provider."]), page(["Second page note."])];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    ...streams.map((stream) => `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

async function parseOne(filename: string, mimetype: string, buffer: Buffer) {
  const { directory, materials } = await parseMaterialBatch([{ filename, mimetype, buffer }]);
  await cleanupMaterialTemp(directory);
  return materials[0];
}

/** pdfjs 文字块：x、y 是左下角坐标，width 是块宽。 */
const item = (str: string, x: number, y: number, width: number, height = 10, hasEOL = false) => ({ str, transform: [height, 0, 0, height, x, y], width, height, hasEOL });
const eol = () => ({ str: "", hasEOL: true, transform: [1, 0, 0, 1, 0, 0], width: 0, height: 0 });

describe("PDF 文字层分段（materialPdfText）", () => {
  it("中文块之间不再插空格；PDF 自带的空格块照原样保留", () => {
    expect(pdfPageParagraphs([item("硅基流动是国内最接近", 58, 593, 95), item(" ", 153, 593, 2, 0), item("Fireworks.ai", 155, 593, 54), item(" ", 209, 593, 2, 0), item("的直接对标。", 211, 593, 60)]))
      .toEqual(["硅基流动是国内最接近 Fireworks.ai 的直接对标。"]);
  });

  it("写满一行的折行接回同一段；没写满的行、项目符号、明显更宽的行距另起一段", () => {
    const paragraphs = pdfPageParagraphs([
      item("01 一页结论", 50, 724, 72, 18), eol(),
      item("Fireworks.ai 的核心，不是简单提供模型 API，而是通过推理优化、弹性部署和企业控制能力，把开源", 57, 686, 480, 11), eol(),
      item("模型转化为可规模化使用的生产级 AI 基础设施。", 57, 668, 220, 11), eol(),
      item("本次重构后的判断", 50, 614, 104, 13), eol(),
      item("• 硅基流动是国内最接近的直接对标：产品形态最接近开发者推理云和企业模型服务平台，并且", 58, 593, 479), eol(),
      item("覆盖私有化部署。", 65, 578, 80), eol(),
      item("• 北电数智并不远离底层算力。", 58, 560, 140), eol(),
    ]);
    expect(paragraphs).toEqual([
      "01 一页结论",
      "Fireworks.ai 的核心，不是简单提供模型 API，而是通过推理优化、弹性部署和企业控制能力，把开源模型转化为可规模化使用的生产级 AI 基础设施。",
      "本次重构后的判断",
      "• 硅基流动是国内最接近的直接对标：产品形态最接近开发者推理云和企业模型服务平台，并且覆盖私有化部署。",
      "• 北电数智并不远离底层算力。",
    ]);
  });

  it("页与页之间空一行，每页至少一段：原生分段（预审 [p<n>]）不再把整份 PDF 当成一段", () => {
    const text = pdfText([[item("第一页", 50, 700, 40), eol()], [item("第二页", 50, 700, 40), eol()]]);
    expect(text).toBe("第一页\n\n第二页");
    expect(splitMaterialBlocks(text)).toEqual(["第一页", "第二页"]);
  });
});

describe("材料上传解析（parseMaterialBatch）", () => {
  it("PDF：同一段的折行接回，换页另起一段", async () => {
    const parsed = await parseOne("两页.pdf", "application/pdf", twoPagePdf());
    expect(parsed.pageCount).toBe(2);
    expect(parsed.extractedText).toBe("Token upstream review covers routing quality and cost for every provider.\n\nSecond page note.");
  });

  it("DOCX 带图片和来源超链接时照常读出文字（以前整份拒收）", async () => {
    const buffer = await docx(
      `<w:p><w:r><w:t>研究正文</w:t></w:r></w:p><w:p><w:hyperlink r:id="rId9"><w:r><w:t>来源链接</w:t></w:r></w:hyperlink></w:p>`,
      {
        "word/media/image1.png": Buffer.from("89504e470d0a1a0a", "hex"),
        "word/_rels/document.xml.rels": rels(`<Relationship Id="rId9" Type="${REL}/hyperlink" Target="https://example.com/source" TargetMode="External"/>`,
          `<Relationship Id="rId10" Type="${REL}/image" Target="media/image1.png"/>`),
      },
    );
    const parsed = await parseOne("研究.docx", DOCX, buffer);
    expect(parsed.extractedText).toContain("研究正文");
    expect(parsed.extractedText).toContain("来源链接");
  });

  it("DOCX 的外部模板、外链图片等非超链接外部关系仍拒收", async () => {
    const buffer = await docx(`<w:p><w:r><w:t>正文</w:t></w:r></w:p>`, {
      "word/_rels/settings.xml.rels": rels(`<Relationship Id="rId1" Type="${REL}/attachedTemplate" Target="http://evil.example/t.dotm" TargetMode="External"/>`),
    });
    await expect(parseOne("模板.docx", DOCX, buffer)).rejects.toThrow("DOCX 含外部资源");
  });

  it("DOCX 嵌入对象（word/embeddings）仍拒收", async () => {
    const buffer = await docx(`<w:p><w:r><w:t>正文</w:t></w:r></w:p>`, { "word/embeddings/oleObject1.bin": Buffer.from("ole") });
    await expect(parseOne("嵌入.docx", DOCX, buffer)).rejects.toThrow("嵌入对象");
  });
});
