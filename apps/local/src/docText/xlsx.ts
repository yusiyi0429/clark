// Excel（.xlsx / .xlsm）→ Markdown：每张表一个二级标题，下面一张表格（表头是列字母 A B C…，空行不写）。
// 有公式的格子写公式本身（=SUM(B2:B9)），不写缓存的值；没公式的写值：数字原样、日期写成 YYYY-MM-DD[ HH:MM:SS]。
// 合并的格子只在左上角写；隐藏的表、行、列照样带。同时给出结构化结果：每张表、每一行在 Markdown 里的位置和格子里的字。
import { DOC_TEXT_LIMITS, DocTextError } from "./limits.js";
import { cellMd, paragraphMd, tableMd } from "./markdown.js";
import { kid, kids, parseTree, readRels, relOfType, scanXml } from "./xml.js";
import type { ZipReader } from "./zip.js";

export interface DocTextSheet {
  /** 表名。 */
  name: string;
  hidden: boolean;
  /** 这张表在 markdown 里的字符区间 [start, end)：从「## 表名」到最后一行末尾。 */
  start: number;
  end: number;
  /** 有内容的行，按行号从小到大。 */
  rows: DocTextRow[];
}

export interface DocTextRow {
  /** 行号，从 1 起，和 Excel 里一样。 */
  row: number;
  /** 这一行在 markdown 里的字符区间 [start, end)，不含行末的换行。 */
  start: number;
  end: number;
  /** 有内容的格子，按列从左到右。 */
  cells: DocTextCell[];
}

export interface DocTextCell {
  /** 列字母，A、B、…、AA。 */
  col: string;
  /** 格子里的字（未做 Markdown 转义）：有公式的是「=公式」，没有的是值。 */
  text: string;
}

const CHART = "【图表】";

export function xlsxToMarkdown(zip: ZipReader): { markdown: string; sheets: DocTextSheet[] } {
  const wbPart = relOfType(readRels(zip, ""), "officeDocument")?.target ?? "xl/workbook.xml";
  const wbXml = zip.readText(wbPart);
  if (wbXml === null) throw new DocTextError("corrupt", "转不了：文件坏了，或者不是 Excel 文件");
  const wb = parseTree(wbXml);
  const pr = kid(wb, "workbookPr")?.attrs.date1904;
  const date1904 = pr === "1" || pr === "true";
  const rels = readRels(zip, wbPart);
  const strings = readSharedStrings(zip, relOfType(rels, "sharedStrings")?.target);
  const isDate = readDateStyles(zip, relOfType(rels, "styles")?.target);

  const out = new Out();
  const sheets: DocTextSheet[] = [];
  const budget = { cells: 0 };
  for (const s of kids(kid(wb, "sheets") ?? wb, "sheet")) {
    const rel = rels.find((r) => r.id === s.attrs.id);
    const name = s.attrs.name ?? "";
    const sheet: DocTextSheet = { name, hidden: s.attrs.state === "hidden" || s.attrs.state === "veryHidden", start: 0, end: 0, rows: [] };
    if (out.length) out.add("\n\n");
    sheet.start = out.length;
    out.add(`## ${paragraphMd(name).replace(/\n/g, " ")}`);
    const kind = rel?.type.slice(rel.type.lastIndexOf("/") + 1);
    if (kind === "chartsheet") out.add(`\n\n${CHART}`);
    else if (kind === "worksheet" && rel) {
      const xml = zip.readText(rel.target);
      if (xml === null) throw new DocTextError("corrupt", "转不了：文件坏了，或者不是 Excel 文件");
      writeSheet(out, sheet, readSheet(xml, strings, isDate, date1904, budget));
    }
    sheet.end = out.length;
    sheets.push(sheet);
  }
  return { markdown: out.length ? out.text() + "\n" : "", sheets };
}

class Out {
  private parts: string[] = [];
  length = 0;
  add(s: string): void {
    this.parts.push(s);
    this.length += s.length;
    // 字符数已经超过字节上限，字节数只会更多，提前停
    if (this.length > DOC_TEXT_LIMITS.maxOutputBytes) throw new DocTextError("output_too_large", "转不了：转出来的文字超过 1MB");
  }
  text(): string {
    return this.parts.join("");
  }
}

function writeSheet(out: Out, sheet: DocTextSheet, grid: Map<number, Map<number, string>>): void {
  let width = 0;
  for (const cells of grid.values()) for (const c of cells.keys()) width = Math.max(width, c);
  if (!width) return;
  const header = Array.from({ length: width }, (_, i) => colName(i + 1));
  out.add("\n\n" + tableMd(header, []));
  for (const r of [...grid.keys()].sort((a, b) => a - b)) {
    const cells = grid.get(r)!;
    const row = Array<string>(width).fill("");
    const list: DocTextCell[] = [];
    for (const c of [...cells.keys()].sort((a, b) => a - b)) {
      const text = cells.get(c)!;
      row[c - 1] = cellMd(text);
      list.push({ col: colName(c), text });
    }
    out.add("\n");
    const start = out.length;
    out.add(`| ${row.join(" | ")} |`);
    sheet.rows.push({ row: r, start, end: out.length, cells: list });
  }
}

// ---------- 读一张表 ----------

function readSheet(xml: string, strings: string[], isDate: boolean[], date1904: boolean, budget: { cells: number }): Map<number, Map<number, string>> {
  const grid = new Map<number, Map<number, string>>();
  const merges: Array<[number, number, number, number]> = [];
  const masters = new Map<string, { formula: string; row: number; col: number }>();
  let row = 0;
  let col = 0;
  let cell: { t?: string; s?: string; f?: Record<string, string>; fText: string; v: string; is: string } | null = null;
  let into: "f" | "v" | "is" | null = null;
  let phonetic = 0;

  scanXml(xml, {
    open(name, attrs) {
      if (name === "row") {
        row = attrs.r ? Number(attrs.r) : row + 1;
        col = 0;
      } else if (name === "c") {
        const ref = attrs.r ? parseRef(attrs.r) : null;
        if (ref) { row = ref.row; col = ref.col; } else col += 1;
        cell = { t: attrs.t, s: attrs.s, fText: "", v: "", is: "" };
      } else if (cell) {
        if (name === "f") { cell.f = attrs; into = "f"; }
        else if (name === "v") into = "v";
        else if (name === "rPh") phonetic++;
        else if (name === "t" && phonetic === 0) into = "is";
      } else if (name === "mergeCell" && attrs.ref) {
        const [a, b = a] = attrs.ref.split(":").map(parseRef);
        if (a && b) merges.push([a.row, a.col, b.row, b.col]);
      }
    },
    close(name) {
      if (name === "f" || name === "v" || name === "t") into = null;
      else if (name === "rPh") phonetic--;
      else if (name === "c" && cell) {
        const text = cellText(cell, row, col);
        cell = null;
        if (text === "") return;
        if (++budget.cells > DOC_TEXT_LIMITS.maxCells) throw new DocTextError("too_many_cells", "转不了：表格里的格子太多");
        let cells = grid.get(row);
        if (!cells) grid.set(row, (cells = new Map()));
        cells.set(col, text);
      }
    },
    text(t) {
      if (!cell || !into) return;
      if (into === "f") cell.fText += t;
      else if (into === "v") cell.v += t;
      else cell.is += t;
    },
  });

  function cellText(c: NonNullable<typeof cell>, r: number, k: number): string {
    if (c.f) {
      const f = c.fText;
      if (c.f.t === "shared" && c.f.si !== undefined) {
        if (f) masters.set(c.f.si, { formula: f, row: r, col: k });
        else {
          const m = masters.get(c.f.si);
          if (m) return "=" + shiftFormula(m.formula, r - m.row, k - m.col);
        }
      }
      if (f) return "=" + f;
    }
    switch (c.t) {
      case "s": return unescapeX(strings[Number(c.v)] ?? "");
      case "inlineStr": return unescapeX(c.is);
      case "str": return unescapeX(c.v);
      case "b": return c.v === "1" ? "TRUE" : c.v === "0" ? "FALSE" : c.v;
      case "e": return c.v;
      case "d": return isoDate(c.v);
    }
    if (c.v === "") return "";
    const n = Number(c.v);
    if (!Number.isFinite(n)) return c.v;
    if (isDate[Number(c.s ?? 0)]) return serialDate(n, date1904);
    return String(n === 0 ? 0 : n); // 去掉 -0；JS 最短表示，和 1.0 / 1 / 1E0 一样
  }

  // 合并的格子只留左上角
  for (const [r1, c1, r2, c2] of merges) {
    const rowsIn = r2 - r1 + 1 > grid.size ? [...grid.keys()].filter((r) => r >= r1 && r <= r2) : range(r1, r2);
    for (const r of rowsIn) {
      const cells = grid.get(r);
      if (!cells) continue;
      const colsIn = c2 - c1 + 1 > cells.size ? [...cells.keys()].filter((c) => c >= c1 && c <= c2) : range(c1, c2);
      for (const c of colsIn) if (r !== r1 || c !== c1) cells.delete(c);
      if (!cells.size) grid.delete(r);
    }
  }
  return grid;
}

// ---------- 共享字符串、样式 ----------

function readSharedStrings(zip: ZipReader, part: string | undefined): string[] {
  const xml = part ? zip.readText(part) : null;
  if (xml === null) return [];
  const out: string[] = [];
  let cur: string | null = null;
  let inT = false;
  let phonetic = 0;
  scanXml(xml, {
    open(name) {
      if (name === "si") cur = "";
      else if (name === "rPh") phonetic++;
      else if (name === "t" && cur !== null && phonetic === 0) inT = true;
    },
    close(name) {
      if (name === "si") { out.push(cur ?? ""); cur = null; }
      else if (name === "rPh") phonetic--;
      else if (name === "t") inT = false;
    },
    text(t) {
      if (inT && cur !== null) cur += t;
    },
  });
  return out;
}

// 内置的日期、时间格式编号（含中文环境的 27–36、50–58）
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** 每个格子样式（cellXfs 的下标）是不是日期格式。 */
function readDateStyles(zip: ZipReader, part: string | undefined): boolean[] {
  const xml = part ? zip.readText(part) : null;
  if (xml === null) return [];
  const root = parseTree(xml);
  const custom = new Map<number, string>();
  for (const f of kids(kid(root, "numFmts") ?? root, "numFmt")) custom.set(Number(f.attrs.numFmtId), f.attrs.formatCode ?? "");
  return kids(kid(root, "cellXfs") ?? root, "xf").map((xf) => {
    const id = Number(xf.attrs.numFmtId ?? 0);
    const code = custom.get(id);
    return code !== undefined ? isDateCode(code) : BUILTIN_DATE.has(id);
  });
}

function isDateCode(code: string): boolean {
  let s = code.replace(/"[^"]*"/g, "").replace(/\\./g, "");
  if (/\[(h+|m+|s+)\]/i.test(s)) return false; // [h]:mm 这类是时长，不是日期
  s = s.replace(/\[[^\]]*\]/g, "");
  return /[ymdhs]/i.test(s);
}

// ---------- 日期 ----------

function serialDate(serial: number, date1904: boolean): string {
  if (serial < 0) return String(serial);
  let days = Math.floor(serial);
  let secs = Math.round((serial - days) * 86400);
  if (secs >= 86400) { days += 1; secs -= 86400; }
  const time = `${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}`;
  if (days === 0) return time; // 只有时间
  let date: string;
  if (!date1904 && days === 60) date = "1900-02-29"; // Excel 沿用的 1900 闰年错误
  else {
    const base = date1904 ? Date.UTC(1904, 0, 1) : days < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
    date = new Date(base + days * 86400000).toISOString().slice(0, 10);
  }
  return secs ? `${date} ${time}` : date;
}

/** t="d" 的格子存的是 ISO 时间，写成同样的格式。 */
function isoDate(v: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}:\d{2}))?/.exec(v);
  if (!m) return v;
  return m[2] && m[2] !== "00:00:00" ? `${m[1]} ${m[2]}` : m[1];
}

// ---------- 公式 ----------

const REF = /(?<![A-Za-z0-9_.$])(?:(\$?)([A-Z]{1,3})(\$?)(\d+)|(\$?)([A-Z]{1,3}):(\$?)([A-Z]{1,3})|(\$?)(\d+):(\$?)(\d+))(?![A-Za-z0-9_(!.])/g;

/** 共享公式：把主格子的公式按相对位置平移成本格子的（$ 锁住的不动；引号、方括号里的不动）。 */
export function shiftFormula(formula: string, dr: number, dc: number): string {
  let out = "";
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < formula.length) {
        if (formula[j] === ch) { if (formula[j + 1] === ch) j += 2; else break; } else j++;
      }
      out += formula.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "[") {
      let depth = 0;
      let j = i;
      for (; j < formula.length; j++) {
        if (formula[j] === "[") depth++;
        else if (formula[j] === "]" && --depth === 0) break;
      }
      out += formula.slice(i, j + 1);
      i = j + 1;
    } else {
      let j = i;
      while (j < formula.length && !`"'[`.includes(formula[j])) j++;
      out += formula.slice(i, j).replace(REF, (_m, ca, c, ra, r, ca2, c1, ca3, c2, ra2, r1, ra3, r2) => {
        if (c !== undefined) return shiftCol(ca, c, dc) + shiftRow(ra, r, dr);
        if (c1 !== undefined) return `${shiftCol(ca2, c1, dc)}:${shiftCol(ca3, c2, dc)}`;
        return `${shiftRow(ra2, r1, dr)}:${shiftRow(ra3, r2, dr)}`;
      });
      i = j;
    }
  }
  return out;
}

function shiftCol(abs: string, letters: string, dc: number): string {
  const n = colNumber(letters);
  if (n > 16384) return abs + letters; // 不是格子引用（比如名字），不动
  return abs ? abs + letters : colName(Math.max(1, n + dc));
}

function shiftRow(abs: string, digits: string, dr: number): string {
  const n = Number(digits);
  if (n > 1048576) return abs + digits;
  return abs ? abs + digits : String(Math.max(1, n + dr));
}

// ---------- 小工具 ----------

function parseRef(ref: string): { row: number; col: number } | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(ref.toUpperCase());
  return m ? { col: colNumber(m[1]), row: Number(m[2]) } : null;
}

function colNumber(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function colName(n: number): string {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** OOXML 字符串里的 _x000D_ 这类转义。 */
function unescapeX(s: string): string {
  return s.includes("_x") ? s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))) : s;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}
