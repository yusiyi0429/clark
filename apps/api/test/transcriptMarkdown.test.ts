import { describe, expect, it } from "vitest";
import { MAX_TRANSCRIPT_TURNS, parseMiaojiMarkdown } from "../src/transcriptMarkdown.js";

describe("parseMiaojiMarkdown", () => {
  it("parses two-segment and three-segment headers after ### 文字记录 and preserves speaker granularity", () => {
    const markdown = [
      "# 标题",
      "",
      "### 关键词",
      "",
      "`本体` `建模`",
      "",
      "### 文字记录",
      "",
      "测试乙 00:01",
      "我来跟进。",
      "",
      "测试甲 00:06",
      "同上。",
      "第二行。",
      "",
      "测试甲 01:16:31",
      "收尾。",
      "",
    ].join("\n");
    const result = parseMiaojiMarkdown(markdown);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transcript.turns).toEqual([
      { speakerName: "测试乙", offsetSeconds: 1, text: "我来跟进。" },
      { speakerName: "测试甲", offsetSeconds: 6, text: "同上。\n第二行。" },
      { speakerName: "测试甲", offsetSeconds: 4591, text: "收尾。" },
    ]);
  });

  it("interprets two-segment minutes above 59 as mm:ss", () => {
    const result = parseMiaojiMarkdown("### 文字记录\n\n测试乙 76:31\n超过一小时。\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transcript.turns[0].offsetSeconds).toBe(4591);
  });

  it("rejects a file without the 文字记录 section", () => {
    const result = parseMiaojiMarkdown("# 只有标题\n\n测试乙 00:01\n正文\n");
    expect(result).toMatchObject({ ok: false, error: { code: "MISSING_TRANSCRIPT_SECTION" } });
  });

  it("rejects empty turn text with the source line number", () => {
    const result = parseMiaojiMarkdown("### 文字记录\n\n测试乙 00:01\n\n测试甲 00:06\n有内容\n");
    expect(result).toMatchObject({ ok: false, error: { code: "EMPTY_TURN_TEXT", line: 3 } });
  });

  it("rejects out-of-order offsets", () => {
    const result = parseMiaojiMarkdown("### 文字记录\n\n测试乙 00:30\n后\n\n测试甲 00:10\n前\n");
    expect(result).toMatchObject({ ok: false, error: { code: "TURN_TIME_OUT_OF_ORDER", line: 6 } });
  });

  it("rejects a header-shaped line with an invalid second range", () => {
    const result = parseMiaojiMarkdown("### 文字记录\n\n测试乙 00:99\n正文\n");
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_TURN_TIME", line: 3 } });
  });

  it("rejects more than the maximum number of turns", () => {
    const lines = ["### 文字记录", ""];
    for (let index = 0; index < MAX_TRANSCRIPT_TURNS + 1; index += 1) {
      lines.push(`测试乙 00:${String(index % 60).padStart(2, "0")}`, `第 ${index + 1} 句`, "");
    }
    expect(parseMiaojiMarkdown(lines.join("\n"))).toMatchObject({ ok: false, error: { code: "TOO_MANY_TURNS" } });
  });

  it("rejects turn text longer than the limit", () => {
    const result = parseMiaojiMarkdown(`### 文字记录\n\n测试乙 00:01\n${"字".repeat(20001)}\n`);
    expect(result).toMatchObject({ ok: false, error: { code: "TURN_TEXT_TOO_LONG", line: 3 } });
  });

  it("rejects invalid UTF-8 bytes", () => {
    const result = parseMiaojiMarkdown(Buffer.from([0xff, 0xfe, 0x00]));
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_TRANSCRIPT_ENCODING" } });
  });
});
