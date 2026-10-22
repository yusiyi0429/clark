import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { extractTranscriptText, htmlFileText, recognizeTranscript, textFileText, transcriptFileKind } from "../src/transcriptFile.js";

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** 最小 DOCX：每段一个 <w:p>。 */
async function tinyDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`);
  const body = paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`).join("");
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${REL}"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

/** 单页、Helvetica 文字层的最小 PDF；两行之间空一大段，分成两段。 */
function tinyPdf(lines: string[]): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td ${lines.map((line, index) => `${index ? "0 -40 Td " : ""}(${line}) Tj`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
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

describe("会议记录文件类型", () => {
  it("accepts md/markdown/txt/pdf/docx/html/htm and rejects .doc and others with their own codes", () => {
    for (const name of ["a.md", "a.MARKDOWN", "a.txt", "a.pdf", "a.docx", "a.html", "a.htm"]) expect(transcriptFileKind(name)).toHaveProperty("kind");
    expect(transcriptFileKind("旧.doc")).toEqual({ code: "DOC_NOT_SUPPORTED", message: "请另存为 docx 再上传" });
    expect(transcriptFileKind("t.json")).toEqual({ code: "UNSUPPORTED_FILE_TYPE", message: "只收 txt、md、pdf、docx、html" });
    expect(transcriptFileKind("无扩展名")).toMatchObject({ code: "UNSUPPORTED_FILE_TYPE" });
  });
});

describe("会议记录抽文字", () => {
  it("decodes UTF-8 text and strips the BOM", () => {
    expect(textFileText(Buffer.from("﻿第一行\r\n第二行", "utf8"))).toBe("第一行\r\n第二行");
  });

  it("drops script/style, turns block tags and <br> into line breaks and decodes entities", () => {
    const html = `<html><head><style>p{color:red}</style><script>alert("x")</script></head><body><h1>周会</h1><p>张三：先看&nbsp;排期&amp;预算</p><p>李四：好<br>我来跟</p></body></html>`;
    const text = htmlFileText(Buffer.from(html, "utf8"));
    expect(text).not.toMatch(/alert|color|<|&amp;|&nbsp;/);
    expect(text.split("\n").filter(Boolean)).toEqual(["周会", "张三：先看 排期&预算", "李四：好", "我来跟"]);
  });

  it("extracts docx paragraphs through the material worker", async () => {
    const extracted = await extractTranscriptText({ fileName: "纪要.docx", buffer: await tinyDocx(["张三：先看排期", "李四：我周五给"]) });
    expect(extracted).toMatchObject({ ok: true });
    if (extracted.ok) expect(extracted.text.split("\n").filter(Boolean)).toEqual(["张三：先看排期", "李四：我周五给"]);
  });

  it("extracts pdf text through the material worker", async () => {
    const extracted = await extractTranscriptText({ fileName: "notes.pdf", buffer: tinyPdf(["Budget review moved to Friday.", "Owner will send the risk list."]) });
    expect(extracted).toMatchObject({ ok: true });
    if (extracted.ok) {
      expect(extracted.text).toContain("Budget review moved to Friday.");
      expect(extracted.text).toContain("Owner will send the risk list.");
    }
  });

  it("rejects .doc, unknown types and files without text", async () => {
    expect(await extractTranscriptText({ fileName: "旧.doc", buffer: Buffer.from("x") })).toMatchObject({ ok: false, code: "DOC_NOT_SUPPORTED" });
    expect(await extractTranscriptText({ fileName: "a.xlsx", buffer: Buffer.from("x") })).toMatchObject({ ok: false, code: "UNSUPPORTED_FILE_TYPE" });
    expect(await extractTranscriptText({ fileName: "a.txt", buffer: Buffer.from(" \n\n ") })).toMatchObject({ ok: false, code: "EMPTY_TRANSCRIPT" });
    expect(await extractTranscriptText({ fileName: "a.html", buffer: Buffer.from("<script>x()</script>") })).toMatchObject({ ok: false, code: "EMPTY_TRANSCRIPT" });
  });
});

describe("会议记录识别链", () => {
  it("keeps the miaoji Markdown path first", () => {
    const result = recognizeTranscript("### 文字记录\n\n测试甲 00:05\n我确认。\n\n测试乙 00:20\n我排期。\n");
    expect(result).toMatchObject({ ok: true, format: "miaoji_markdown", parserVersion: "miaoji-markdown.v1" });
  });

  it("keeps miaoji structure errors when the heading is there", () => {
    expect(recognizeTranscript("### 文字记录\n\n测试甲 00:05\n")).toMatchObject({ ok: false, code: "EMPTY_TURN_TEXT" });
  });

  it("reads a Feishu txt export without the first-line date", () => {
    const result = recognizeTranscript("关键词:\n渠道、排期\n\n测试甲 00:00:05.120\n我确认这个方向。\n\n测试乙 00:01:20.000\n我周五前给排期。\n");
    expect(result).toMatchObject({ ok: true, format: "feishu_text", parserVersion: "feishu-minutes-txt.v1" });
    if (result.ok) expect(result.turns.map((turn) => [turn.speakerName, turn.offsetSeconds])).toEqual([["测试甲", 5], ["测试乙", 80]]);
  });

  it("reads 姓名：内容 lines as speaker turns, continuation lines stay in the turn", () => {
    const result = recognizeTranscript("# 周会\n\n张三：先看排期。\n李四: 我周五给，\n顺便带上预算。\n张三：好。\n");
    expect(result).toMatchObject({ ok: true, format: "speaker_lines", parserVersion: "speaker-lines.v1" });
    if (result.ok) expect(result.turns).toEqual([
      { speakerName: "张三", offsetSeconds: 0, text: "先看排期。" },
      { speakerName: "李四", offsetSeconds: 0, text: "我周五给，\n顺便带上预算。" },
      { speakerName: "张三", offsetSeconds: 0, text: "好。" },
    ]);
  });

  it("reads 姓名 mm:ss headers without the 文字记录 heading", () => {
    const result = recognizeTranscript("测试甲 00:05\n我确认。\n\n测试乙 01:20\n我排期。\n");
    expect(result).toMatchObject({ ok: true, format: "speaker_lines" });
    if (result.ok) expect(result.turns.map((turn) => [turn.speakerName, turn.offsetSeconds, turn.text])).toEqual([["测试甲", 5, "我确认。"], ["测试乙", 80, "我排期。"]]);
  });

  it("falls back to meeting notes when speaker-looking lines do not cover most of the text", () => {
    const notes = "时间：10 月 21 日\n地点：三楼\n\n本周先把渠道排期定下来，预算按上月口径走。\n各组周五前交风险清单。\n\n下周一复盘执行情况，\n有变化在群里说。\n\n结论是先做华东。";
    const result = recognizeTranscript(notes);
    expect(result).toMatchObject({ ok: true, format: "meeting_notes", parserVersion: "meeting-notes.v1" });
    if (result.ok) {
      expect(result.turns.map((turn) => turn.speakerName)).toEqual(["会议纪要", "会议纪要", "会议纪要", "会议纪要"]);
      expect(result.turns.every((turn) => turn.offsetSeconds === 0)).toBe(true);
      expect(result.turns[1].text).toBe("本周先把渠道排期定下来，预算按上月口径走。\n各组周五前交风险清单。");
    }
  });

  it("does not take a single speaker line as a transcript", () => {
    expect(recognizeTranscript("张三：今天就一件事。\n\n后面全是纪要正文，没有说话人。")).toMatchObject({ ok: true, format: "meeting_notes" });
  });

  it("splits an overlong notes paragraph to fit the per-turn limit", () => {
    const result = recognizeTranscript("x".repeat(45_000));
    expect(result).toMatchObject({ ok: true, format: "meeting_notes" });
    if (result.ok) expect(result.turns.map((turn) => turn.text.length)).toEqual([20_000, 20_000, 5_000]);
  });
});
