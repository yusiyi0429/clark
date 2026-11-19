// 比两份内容、切出一处一处的改动，能把其中几处恢复回去（设计第 72 条）。
import { afterEach, describe, expect, it } from "vitest";
import { FILE_CHANGE_LIMITS, compareFiles, diffText, restoreFile, restoreText, type TextChange } from "../src/textChanges/index.js";
import { makeDocx, makeXlsx, noteParts, p } from "./docTextFiles.js";
import { trimTables } from "../src/textChanges/trim.js";

/** 每一处：改前那几个字 → 改后那几个字。 */
const pieces = (a: string, b: string, cs: TextChange[]) => cs.map((c) => [a.slice(c.before.start, c.before.end), b.slice(c.after.start, c.after.end)]);
const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (h: string) => Uint8Array.from(h.split(" ").map((x) => parseInt(x, 16)));
const same = (x: Uint8Array, y: Uint8Array) => Buffer.compare(Buffer.from(x), Buffer.from(y)) === 0;

describe("比两份文字", () => {
  it("只改了一个词，只标那个词；中文按字", () => {
    const a = "进展评估：良好\n下周上线预发。\n";
    const b = "进展评估：优秀\n下周上线预发。\n";
    const cs = diffText(a, b);
    expect(pieces(a, b, cs)).toEqual([["良好", "优秀"]]);
    expect(cs[0]).toEqual({ id: "c1", before: { start: 5, end: 7 }, after: { start: 5, end: 7 } });
  });

  it("同一行里隔不超过 3 个字的并成一处，隔得远的分开；不跨行并", () => {
    expect(pieces("一二三四五六七八九十\n", "一X三四五六七八Y十\n", diffText("一二三四五六七八九十\n", "一X三四五六七八Y十\n"))).toEqual([["二", "X"], ["九", "Y"]]);
    expect(pieces("一二三四五\n", "一X三四Y\n", diffText("一二三四五\n", "一X三四Y\n"))).toEqual([["二三四五", "X三四Y"]]);
    const a = "甲乙\n丙丁\n";
    const b = "甲X\nY丁\n";
    expect(pieces(a, b, diffText(a, b))).toEqual([["乙", "X"], ["丙", "Y"]]);
  });

  it("纯新增一整段：改前是空区间；纯删除一整段：改后是空区间", () => {
    const a = "第一段\n\n第三段\n";
    const b = "第一段\n\n第二段新加的\n\n第三段\n";
    const add = diffText(a, b);
    expect(add).toHaveLength(1);
    expect(add[0].before.start).toBe(add[0].before.end);
    expect(pieces(a, b, add)).toEqual([["", "第二段新加的\n\n"]]);
    const del = diffText(b, a);
    expect(del[0].after.start).toBe(del[0].after.end);
    expect(pieces(b, a, del)).toEqual([["第二段新加的\n\n", ""]]);
  });

  it("整个数算一处：3160 改 3180 盖住整个数", () => {
    const a = "本月收入 3160 万元\n";
    const b = "本月收入 3180 万元\n";
    const cs = diffText(a, b);
    expect(pieces(a, b, cs)).toEqual([["3160", "3180"]]);
    expect(cs[0]).toEqual({ id: "c1", before: { start: 5, end: 9 }, after: { start: 5, end: 9 } });
  });

  it("小数、千分位算在数里，后面的 % 不算", () => {
    expect(pieces("增长 17.4%\n", "增长 17.6%\n", diffText("增长 17.4%\n", "增长 17.6%\n"))).toEqual([["17.4", "17.6"]]);
    expect(pieces("| 合计 | 15,040 |\n", "| 合计 | 15,240 |\n", diffText("| 合计 | 15,040 |\n", "| 合计 | 15,240 |\n"))).toEqual([["15,040", "15,240"]]);
  });

  it("英文单词整个算一处", () => {
    expect(pieces("the color is red\n", "the colour is red\n", diffText("the color is red\n", "the colour is red\n"))).toEqual([["color", "colour"]]);
  });

  it("中文照旧一个字一个字：只盖「良好」「优秀」", () => {
    const a = "进展评估：良好\n";
    const b = "进展评估：优秀\n";
    expect(pieces(a, b, diffText(a, b))).toEqual([["良好", "优秀"]]);
  });

  it("emoji 这类两个下标的字不会被切开", () => {
    expect(pieces("ab😀cd", "ab😁cd", diffText("ab😀cd", "ab😁cd"))).toEqual([["😀", "😁"]]);
  });

  it("同样的输入永远同样的结果，id 也一样", () => {
    const a = "进展：良好\n风险：无\n下一步：上线\n";
    const b = "进展：优秀\n风险：有一个\n下一步：上线预发\n";
    expect(diffText(a, b)).toEqual(diffText(a, b));
    expect(diffText(a, b).map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });
});

describe("恢复其中几处", () => {
  const a = "本周进展评估：良好，风险：无，负责人：孙明。\n下周上线。\n";
  const b = "本周进展评估：优秀，风险：无，负责人：张三。\n下周上线预发。\n";

  it("同一行里两处改动，恢复其中一处，另一处还在；全文逐字对", () => {
    const cs = diffText(a, b);
    expect(pieces(a, b, cs)).toEqual([["良好", "优秀"], ["孙明", "张三"], ["", "预发"]]);
    const r = restoreText(a, b, cs, ["c1"]);
    expect(r).toBe("本周进展评估：良好，风险：无，负责人：张三。\n下周上线预发。\n");
    // 再比一次，剩下的正好是没选的那两处
    expect(pieces(a, r!, diffText(a, r!))).toEqual([["孙明", "张三"], ["", "预发"]]);
  });

  it("恢复全部等于改前，什么都不恢复等于改后，不认识的 id 回 null", () => {
    const cs = diffText(a, b);
    expect(restoreText(a, b, cs, cs.map((c) => c.id))).toBe(a);
    expect(restoreText(a, b, cs, [])).toBe(b);
    expect(restoreText(a, b, cs, ["c9"])).toBeNull();
  });

  it("恢复纯新增的一段就是删掉它，恢复纯删除的一段就是放回去", () => {
    const x = "第一段\n第三段\n";
    const y = "第一段\n第二段\n第三段\n";
    expect(restoreText(x, y, diffText(x, y), ["c1"])).toBe(x);
    expect(restoreText(y, x, diffText(y, x), ["c1"])).toBe(y);
  });
});

describe("比两份文件", () => {
  afterEach(() => {
    FILE_CHANGE_LIMITS.maxTextBytes = 1024 * 1024;
  });

  it("UTF-8 的 Markdown：full，能恢复，写回的字节和手工改回去的一样", () => {
    const r = compareFiles(".md", utf8(a1), utf8(b1));
    expect(r).toMatchObject({ detail: "full", before: a1, after: b1 });
    const back = restoreFile("md", utf8(a1), utf8(b1), ["c1"]);
    expect(back.ok && new TextDecoder().decode(back.bytes)).toBe(a1);
  });

  it("CRLF 换行：恢复后换行还是 CRLF", () => {
    const before = utf8("姓名,金额\r\n张三,100\r\n李四,200\r\n");
    const after = utf8("姓名,金额\r\n张三,150\r\n李四,250\r\n");
    const r = compareFiles("csv", before, after);
    expect(r.detail).toBe("full");
    const back = restoreFile("csv", before, after, ["c2"]);
    expect(back.ok && same(back.bytes, utf8("姓名,金额\r\n张三,150\r\n李四,200\r\n"))).toBe(true);
  });

  it("带 BOM 的 UTF-8：恢复后 BOM 还在", () => {
    const bom = [0xef, 0xbb, 0xbf];
    const withBom = (s: string) => Uint8Array.from([...bom, ...utf8(s)]);
    const r = compareFiles("txt", withBom("甲\n乙\n"), withBom("甲\n丙\n"));
    expect(r).toMatchObject({ detail: "full", before: "甲\n乙\n", after: "甲\n丙\n" });
    const back = restoreFile("txt", withBom("甲\n乙\n"), withBom("甲\n丙\n"), ["c1"]);
    expect(back.ok && same(back.bytes, withBom("甲\n乙\n"))).toBe(true);
  });

  it("GBK 的 csv（中文 Windows 上的 Excel 另存 csv）：full，恢复后的字节和手工改回去的一样", () => {
    // 姓名,金额\r\n张三,100\r\n李四,200\r\n  /  张三改成王五、200 改成 300
    const before = hex("d0 d5 c3 fb 2c bd f0 b6 ee 0d 0a d5 c5 c8 fd 2c 31 30 30 0d 0a c0 ee cb c4 2c 32 30 30 0d 0a");
    const after = hex("d0 d5 c3 fb 2c bd f0 b6 ee 0d 0a cd f5 ce e5 2c 31 30 30 0d 0a c0 ee cb c4 2c 33 30 30 0d 0a");
    expect(new TextDecoder("gbk").decode(before)).toBe("姓名,金额\r\n张三,100\r\n李四,200\r\n");
    const r = compareFiles("csv", before, after);
    expect(r.detail).toBe("full");
    expect(r.detail !== "none" && pieces(r.before!, r.after!, r.changes)).toEqual([["张三", "王五"], ["200", "300"]]);
    // 只恢复「张三」：手工改回去应该是 姓名,金额 / 张三,100 / 李四,300
    const back = restoreFile("csv", before, after, ["c1"]);
    const expected = hex("d0 d5 c3 fb 2c bd f0 b6 ee 0d 0a d5 c5 c8 fd 2c 31 30 30 0d 0a c0 ee cb c4 2c 33 30 30 0d 0a");
    expect(back.ok && same(back.bytes, expected)).toBe(true);
  });

  it("带 BOM 的 UTF-16：full，恢复后还是 UTF-16 带 BOM", () => {
    const u16 = (s: string) => Uint8Array.from([0xff, 0xfe, ...Buffer.from(s, "utf16le")]);
    expect(compareFiles("txt", u16("甲乙\n"), u16("甲丙\n")).detail).toBe("full");
    const back = restoreFile("txt", u16("甲乙\n"), u16("甲丙\n"), ["c1"]);
    expect(back.ok && same(back.bytes, u16("甲乙\n"))).toBe(true);
  });

  it("还原不了的编码（GB18030 四字节的字）：只给看（converted），不能按处恢复", () => {
    const before = hex("d6 d0 95 32 82 36 0a"); // 中𠀀
    const after = hex("ce c4 95 32 82 36 0a"); // 文𠀀
    const r = compareFiles("txt", before, after);
    expect(r).toMatchObject({ detail: "converted", before: "中𠀀\n", after: "文𠀀\n" });
    expect(restoreFile("txt", before, after, ["c1"])).toEqual({ ok: false, reason: "not_restorable" });
  });

  it("二进制、认不出的编码、超过 1MB：none", () => {
    expect(compareFiles("png", hex("89 50 4e 47 0d 0a 1a 0a 00 00"), hex("89 50 4e 47 0d 0a 1a 0a 00 01"))).toEqual({ detail: "none" });
    expect(compareFiles("txt", hex("41 ff 42"), hex("41 ff 43"))).toEqual({ detail: "none" });
    FILE_CHANGE_LIMITS.maxTextBytes = 10;
    expect(compareFiles("txt", utf8("短"), utf8("这一份超过了十个字节"))).toEqual({ detail: "none" });
  });

  it("新建、删掉的文件：一边为 null，整份算一处；空文件没有改动；都不能按处恢复", () => {
    expect(compareFiles("md", null, utf8("新的\n"))).toEqual({ detail: "full", before: null, after: "新的\n", changes: [{ id: "c1", before: { start: 0, end: 0 }, after: { start: 0, end: 3 } }] });
    expect(compareFiles("md", utf8("旧的\n"), null)).toEqual({ detail: "full", before: "旧的\n", after: null, changes: [{ id: "c1", before: { start: 0, end: 3 }, after: { start: 0, end: 0 } }] });
    expect(compareFiles("md", null, utf8(""))).toEqual({ detail: "full", before: null, after: "", changes: [] });
    expect(restoreFile("md", null, utf8("新的\n"), ["c1"])).toEqual({ ok: false, reason: "not_restorable" });
  });

  it("差别极大时不卡住：两份 1MB 完全不同的文字，几秒内回来", () => {
    const line = (seed: number) => Array.from({ length: 40 }, (_, i) => String.fromCodePoint(0x4e00 + ((seed * 7919 + i * 104729) % 2000))).join("") + "\n";
    const big = (offset: number) => Array.from({ length: 8000 }, (_, i) => line(i * 2 + offset)).join("");
    const t = performance.now();
    const cs = diffText(big(0), big(1));
    expect(performance.now() - t).toBeLessThan(5000);
    expect(cs.length).toBeGreaterThan(0);
    expect(restoreText(big(0), big(1), cs, cs.map((c) => c.id))).toBe(big(0));
  });

  it("切出来超过 2000 处时整份算一处", () => {
    const a = Array.from({ length: 2500 }, (_, i) => `第${i}行 甲\n`).join("");
    const b = Array.from({ length: 2500 }, (_, i) => `第${i}行 乙\n`).join("");
    const cs = diffText(a, b);
    expect(cs).toHaveLength(1);
    expect(restoreText(a, b, cs, ["c1"])).toBe(a);
  });
});

const a1 = "进展：良好\n风险：无\n";
const b1 = "进展：良好\n风险：有\n";

describe("Word、Excel：转文字再比（converted，只给看）", () => {
  const sheet = (rows: Array<[string, string]>) => rows.map(([x, y], i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>${x}</t></is></c><c r="B${i + 1}"><v>${y}</v></c></row>`).join("");
  const rows = (n: number) => Array.from({ length: n }, (_, i): [string, string] => [`项目${i + 1}`, String((i + 1) * 10)]);

  it("Word 改一处：converted，标出那几个字；不能按处恢复", () => {
    const before = makeDocx(p("进展评估：良好"));
    const after = makeDocx(p("进展评估：优秀"));
    const r = compareFiles("docx", before, after);
    expect(r.detail).toBe("converted");
    expect(r.detail !== "none" && pieces(r.before!, r.after!, r.changes)).toEqual([["良好", "优秀"]]);
    expect(restoreFile("docx", before, after, ["c1"])).toEqual({ ok: false, reason: "not_restorable" });
  });

  it("Excel 改一格只标那一格，加一行是整行新增", () => {
    const base = rows(5);
    const edited = base.map((r, i): [string, string] => (i === 2 ? [r[0], "999"] : r));
    const r1 = compareFiles("xlsx", makeXlsx([{ name: "表", data: sheet(base) }]), makeXlsx([{ name: "表", data: sheet(edited) }]));
    expect(r1.detail !== "none" && pieces(r1.before!, r1.after!, r1.changes)).toEqual([["30", "999"]]);
    const r2 = compareFiles("xlsx", makeXlsx([{ name: "表", data: sheet(base) }]), makeXlsx([{ name: "表", data: sheet([...base, ["新项目", "60"]]) }]));
    expect(r2.detail !== "none" && pieces(r2.before!, r2.after!, r2.changes)).toEqual([["", "| 6 | 新项目 | 60 |\n"]]);
  });

  it("Excel 大表裁剪：只留表头、改过的行和上下各两行，中间省略；两边对得上，区间按裁过的算", () => {
    const base = rows(300);
    const edited = base.map((r, i): [string, string] => (i === 149 ? [r[0], "7"] : r));
    const r = compareFiles("xlsx", makeXlsx([{ name: "表", data: sheet(base) }]), makeXlsx([{ name: "表", data: sheet(edited) }]));
    if (r.detail === "none") throw new Error("应该能比");
    const expected = (v: string) =>
      ["## 表", "", "|  | A | B |", "| --- | --- | --- |", "| 中间 147 行没改 |", "| 148 | 项目148 | 1480 |", "| 149 | 项目149 | 1490 |", `| 150 | 项目150 | ${v} |`, "| 151 | 项目151 | 1510 |", "| 152 | 项目152 | 1520 |", "| 中间 148 行没改 |", ""].join("\n");
    expect(r.before).toBe(expected("1500"));
    expect(r.after).toBe(expected("7"));
    expect(pieces(r.before!, r.after!, r.changes)).toEqual([["1500", "7"]]);
  });

  it("Excel 大表在开头加一行、末尾删一行：后面的行号都变了也不算改过；省略行两边位置一样", () => {
    const base = rows(120);
    const edited: Array<[string, string]> = [["表头说明", "0"], ...base.slice(0, -1)];
    const r = compareFiles("xlsx", makeXlsx([{ name: "表", data: sheet(base) }]), makeXlsx([{ name: "表", data: sheet(edited) }]));
    if (r.detail === "none") throw new Error("应该能比");
    const lines = (s: string) => s.split("\n");
    expect(lines(r.before!).filter((l) => /^\| 中间 \d+ 行没改 \|$/.test(l))).toHaveLength(1);
    expect(lines(r.after!).filter((l) => /^\| 中间 \d+ 行没改 \|$/.test(l))).toHaveLength(1);
    expect(pieces(r.before!, r.after!, r.changes)).toEqual([["", "| 1 | 表头说明 | 0 |\n"], ["| 120 | 项目120 | 1200 |\n", ""]]);
    expect(r.before!.length).toBeLessThan(400);
  });

  it("Excel 大表中间加一行：只算整行新增一处，上下各留两行，两边的行号各照各的", () => {
    const base = rows(120);
    const edited: Array<[string, string]> = [...base.slice(0, 60), ["新项目", "5"], ...base.slice(60)];
    const r = compareFiles("xlsx", makeXlsx([{ name: "表", data: sheet(base) }]), makeXlsx([{ name: "表", data: sheet(edited) }]));
    if (r.detail === "none") throw new Error("应该能比");
    expect(pieces(r.before!, r.after!, r.changes)).toEqual([["", "| 61 | 新项目 | 5 |\n"]]);
    expect(r.before!.split("\n").slice(4)).toEqual(["| 中间 58 行没改 |", "| 59 | 项目59 | 590 |", "| 60 | 项目60 | 600 |", "| 61 | 项目61 | 610 |", "| 62 | 项目62 | 620 |", "| 中间 58 行没改 |", ""]);
    expect(r.after!.split("\n").slice(4)).toEqual(["| 中间 58 行没改 |", "| 59 | 项目59 | 590 |", "| 60 | 项目60 | 600 |", "| 61 | 新项目 | 5 |", "| 62 | 项目61 | 610 |", "| 63 | 项目62 | 620 |", "| 中间 58 行没改 |", ""]);
  });

  it("Excel 大表带批注：改一格时批注也折掉；改一条批注，只留那条和上下各两行", () => {
    const notes = (changed?: number) =>
      noteParts(1, Array.from({ length: 20 }, (_, i): [string, string] => [`B${i + 1}`, i === changed ? "改过的批注" : `批注${i + 1}\n第二行`]));
    const book = (data: Array<[string, string]>, changed?: number) => makeXlsx([{ name: "表", data: sheet(data) }], { extra: notes(changed) });
    const base = rows(80);
    const cell = compareFiles("xlsx", book(base), book(base.map((r, i): [string, string] => (i === 40 ? [r[0], "7"] : r))));
    if (cell.detail === "none") throw new Error("应该能比");
    expect(cell.after!.split("\n").filter((l) => l.startsWith("- B"))).toEqual([]);
    expect(pieces(cell.before!, cell.after!, cell.changes)).toEqual([["410", "7"]]);
    const note = compareFiles("xlsx", book(base), book(base, 9));
    if (note.detail === "none") throw new Error("应该能比");
    expect(note.after!.split("\n### 批注\n\n")[1]).toBe(["| 中间 16 行没改 |", "- B9：批注9", "  第二行", "- B10：改过的批注", "- B11：批注11", "  第二行", "| 中间 18 行没改 |", ""].join("\n"));
    expect(pieces(note.before!, note.after!, note.changes)).toEqual([["批注10\n  第二行", "改过的批注"]]);
  });

  it("表格折起来的行写「中间 N 行没改」，N 是这一处实际折掉的行数", () => {
    // 60 行数据，改第 10 行：上面折掉第 1–7 行，下面折掉第 13–60 行；表头不算、不折。
    const table = (v: string) => ["|  | A |\n", "| --- | --- |\n", ...Array.from({ length: 60 }, (_, i) => `| ${i + 1} | ${i === 9 ? v : i + 1} |\n`)];
    const starts = (lines: string[]) => new Set(lines.slice(2).map((_, i) => lines.slice(0, i + 2).join("").length));
    const before = table("10"), after = table("改");
    const r = trimTables(before.join(""), after.join(""), starts(before), starts(after));
    const expected = (v: string) => ["|  | A |", "| --- | --- |", "| 中间 7 行没改 |", "| 8 | 8 |", "| 9 | 9 |", `| 10 | ${v} |`, "| 11 | 11 |", "| 12 | 12 |", "| 中间 48 行没改 |", ""].join("\n");
    expect(r.before).toBe(expected("10"));
    expect(r.after).toBe(expected("改"));
    expect(r.before).not.toContain("…");
  });

  it("同样输入结果稳定", () => {
    const x = makeXlsx([{ name: "表", data: sheet(rows(80)) }]);
    const y = makeXlsx([{ name: "表", data: sheet(rows(81)) }]);
    expect(compareFiles("xlsx", x, y)).toEqual(compareFiles("xlsx", x, y));
  });

  it("转不了的（带密码、坏的）：none", () => {
    expect(compareFiles("docx", hex("d0 cf 11 e0 a1 b1 1a e1"), makeDocx(p("x")))).toEqual({ detail: "none" });
    expect(compareFiles("xls", utf8("a"), utf8("b"))).toEqual({ detail: "none" });
  });
});
