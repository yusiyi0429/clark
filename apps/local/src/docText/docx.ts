// Word（.docx / .docm）→ Markdown：标题、段落、列表、表格照结构转，只留看得见的正文。
// 不带加粗、字体、颜色；修订取现在看到的样子（插入的算、删除的不算）；不读批注、页眉页脚、脚注。
// 图片、图表、嵌入对象写成固定占位字；文本框里的字跟在所在段落后面。
import { DocTextError } from "./limits.js";
import { cellMd, paragraphMd, tableMd } from "./markdown.js";
import { find, kid, kids, parseTree, readRels, relOfType, type XNode } from "./xml.js";
import type { ZipReader } from "./zip.js";

const PLACEHOLDER = { image: "【图片】", chart: "【图表】", object: "【嵌入对象】" } as const;

interface Style { name: string; basedOn?: string; outline?: number; numId?: string; ilvl?: number }
type Block = { md: string; list: boolean };

export function docxToMarkdown(zip: ZipReader): string {
  const docPart = relOfType(readRels(zip, ""), "officeDocument")?.target ?? "word/document.xml";
  const docXml = zip.readText(docPart);
  if (docXml === null) throw new DocTextError("corrupt", "转不了：文件坏了，或者不是 Word 文件");
  const body = find(parseTree(docXml), "body");
  if (!body) throw new DocTextError("corrupt", "转不了：文件坏了，或者不是 Word 文件");
  const rels = readRels(zip, docPart);
  const ctx = new Ctx(readStyles(zip, relOfType(rels, "styles")?.target), readNumbering(zip, relOfType(rels, "numbering")?.target));
  ctx.blocks(body.children);
  return join(ctx.out);
}

class Ctx {
  readonly out: Block[] = [];
  private listLevel = -1;

  constructor(private readonly styles: Map<string, Style>, private readonly numFmt: (numId: string, ilvl: number) => string | undefined) {}

  blocks(nodes: XNode["children"]): void {
    for (const n of nodes) {
      if (typeof n === "string") continue;
      if (n.name === "p") this.paragraph(n);
      else if (n.name === "tbl") this.push({ md: this.table(n), list: false });
      else if (n.name === "sdt") this.blocks(kid(n, "sdtContent")?.children ?? []);
      else if (n.name === "customXml") this.blocks(n.children);
      else if (n.name === "AlternateContent") this.blocks(altBranch(n)?.children ?? []);
    }
  }

  private push(b: Block): void {
    if (!b.list) this.listLevel = -1;
    this.out.push(b);
  }

  private paragraph(p: XNode): void {
    const { text, boxes } = paraText(p);
    const md = paragraphMd(text);
    if (md) {
      const pPr = kid(p, "pPr");
      const styleId = kid(pPr, "pStyle")?.attrs.val;
      const level = this.headingLevel(pPr, styleId);
      const num = level ? undefined : this.numbering(pPr, styleId);
      if (level) this.push({ md: `${"#".repeat(level)} ${md.replace(/\n/g, " ")}`, list: false });
      else if (num) {
        const lvl = Math.min(num.ilvl, this.listLevel + 1);
        this.listLevel = lvl;
        const lead = " ".repeat(4 * lvl);
        // 认得出是编号的写 1.；项目符号、不编号、认不出的都写成普通列表项
        const fmt = this.numFmt(num.numId, num.ilvl);
        const marker = fmt && fmt !== "bullet" && fmt !== "none" ? "1. " : "- ";
        const cont = "\n" + " ".repeat(lead.length + marker.length);
        this.push({ md: lead + marker + md.split("\n").join(cont), list: true });
      } else this.push({ md, list: false });
    }
    for (const box of boxes) this.blocks(box.children);
  }

  private table(tbl: XNode): string {
    const rows: string[][] = [];
    for (const tr of unwrap(tbl, "tr")) {
      const trPr = kid(tr, "trPr");
      if (kid(trPr, "del")) continue; // 修订里删掉的行
      const cells: string[] = Array<string>(Number(kid(trPr, "gridBefore")?.attrs.val ?? 0) || 0).fill("");
      for (const tc of unwrap(tr, "tc")) {
        const tcPr = kid(tc, "tcPr");
        const vMerge = kid(tcPr, "vMerge");
        cells.push(vMerge && vMerge.attrs.val !== "restart" ? "" : cellMd(cellText(tc)));
        const span = Number(kid(tcPr, "gridSpan")?.attrs.val ?? 1) || 1;
        for (let s = 1; s < span; s++) cells.push("");
      }
      rows.push(cells);
    }
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r) => r.length));
    for (const r of rows) while (r.length < width) r.push("");
    return tableMd(rows[0], rows.slice(1));
  }

  private headingLevel(pPr: XNode | undefined, styleId: string | undefined): number {
    const direct = kid(pPr, "outlineLvl")?.attrs.val;
    if (direct !== undefined) return outlineToLevel(direct);
    for (const s of this.chain(styleId)) {
      const m = /^heading\s*([1-9])$/.exec(s.name);
      if (m) return Math.min(6, Number(m[1]));
      if (s.name === "title") return 1;
      if (s.outline !== undefined) return s.outline;
    }
    return 0;
  }

  private numbering(pPr: XNode | undefined, styleId: string | undefined): { numId: string; ilvl: number } | undefined {
    const numPr = kid(pPr, "numPr");
    let numId = kid(numPr, "numId")?.attrs.val;
    let ilvl = numberOr(kid(numPr, "ilvl")?.attrs.val);
    for (const s of this.chain(styleId)) {
      numId ??= s.numId;
      ilvl ??= s.ilvl;
    }
    if (!numId || numId === "0") return undefined;
    return { numId, ilvl: Math.min(8, ilvl ?? 0) };
  }

  private *chain(styleId: string | undefined): Generator<Style> {
    for (let i = 0, id = styleId; id && i < 20; i++) {
      const s = this.styles.get(id);
      if (!s) return;
      yield s;
      id = s.basedOn;
    }
  }
}

/** 一段的正文（未转义）和段里的文本框。 */
function paraText(p: XNode): { text: string; boxes: XNode[] } {
  const boxes: XNode[] = [];
  let text = "";
  const walk = (node: XNode): void => {
    for (const c of node.children) {
      if (typeof c === "string") continue;
      switch (c.name) {
        case "r": run(c); break;
        case "del": case "moveFrom": case "pPr": case "rPr": case "sdtPr": break;
        case "AlternateContent": { const b = altBranch(c); if (b) walk(b); break; }
        default: walk(c); // 插入、超链接、域、内容控件、公式等，里面的字照样要
      }
    }
  };
  const run = (r: XNode): void => {
    const rPr = kid(r, "rPr");
    const vanish = kid(rPr, "vanish");
    if (vanish && vanish.attrs.val !== "0" && vanish.attrs.val !== "false") return; // 隐藏文字
    runKids(r.children);
  };
  const runKids = (children: XNode["children"]): void => {
    for (const c of children) {
      if (typeof c === "string") continue;
      switch (c.name) {
        case "t": text += c.children.filter((x): x is string => typeof x === "string").join(""); break;
        case "tab": case "ptab": text += "\t"; break;
        case "br": if (c.attrs.type !== "page" && c.attrs.type !== "column") text += "\n"; break;
        case "cr": text += "\n"; break;
        case "noBreakHyphen": text += "-"; break;
        case "drawing": case "pict": case "object": text += shape(c, boxes); break;
        case "AlternateContent": runKids(altBranch(c)?.children ?? []); break;
      }
    }
  };
  walk(p);
  return { text, boxes };
}

function shape(node: XNode, boxes: XNode[]): string {
  const found = collect(node, "txbxContent");
  if (found.length) {
    boxes.push(...found);
    return "";
  }
  if (node.name === "object") return PLACEHOLDER.object;
  return node.name === "drawing" && find(node, "chart") ? PLACEHOLDER.chart : PLACEHOLDER.image;
}

/** 表格一格里的字：段落各占一行；嵌套表格每行一行、格子之间用「 / 」。 */
function cellText(tc: XNode): string {
  const lines: string[] = [];
  const walk = (nodes: XNode["children"]): void => {
    for (const n of nodes) {
      if (typeof n === "string") continue;
      if (n.name === "p") {
        const { text, boxes } = paraText(n);
        lines.push(text);
        for (const b of boxes) walk(b.children);
      } else if (n.name === "tbl") {
        for (const tr of unwrap(n, "tr")) lines.push(unwrap(tr, "tc").map((c) => cellText(c).replace(/\n/g, " ")).join(" / "));
      } else if (n.name === "sdt") walk(kid(n, "sdtContent")?.children ?? []);
      else if (n.name === "customXml") walk(n.children);
      else if (n.name === "AlternateContent") walk(altBranch(n)?.children ?? []);
    }
  };
  walk(tc.children);
  return lines.join("\n");
}

function join(blocks: Block[]): string {
  let s = "";
  blocks.forEach((b, i) => {
    if (!b.md) return;
    if (s) s += b.list && blocks[i - 1]?.list ? "\n" : "\n\n";
    s += b.md;
  });
  return s ? s + "\n" : "";
}

// ---------- 样式和编号 ----------

function readStyles(zip: ZipReader, part: string | undefined): Map<string, Style> {
  const map = new Map<string, Style>();
  const xml = part ? zip.readText(part) : null;
  if (xml === null) return map;
  for (const s of kids(parseTree(xml), "style")) {
    const id = s.attrs.styleId;
    if (!id || (s.attrs.type && s.attrs.type !== "paragraph")) continue;
    const pPr = kid(s, "pPr");
    const numPr = kid(pPr, "numPr");
    const outline = kid(pPr, "outlineLvl")?.attrs.val;
    map.set(id, {
      name: (kid(s, "name")?.attrs.val ?? "").toLowerCase(),
      basedOn: kid(s, "basedOn")?.attrs.val,
      outline: outline === undefined ? undefined : outlineToLevel(outline),
      numId: kid(numPr, "numId")?.attrs.val,
      ilvl: numberOr(kid(numPr, "ilvl")?.attrs.val),
    });
  }
  return map;
}

function readNumbering(zip: ZipReader, part: string | undefined): (numId: string, ilvl: number) => string | undefined {
  const xml = part ? zip.readText(part) : null;
  if (xml === null) return () => undefined;
  const root = parseTree(xml);
  const abstract = new Map<string, XNode>();
  for (const a of kids(root, "abstractNum")) abstract.set(a.attrs.abstractNumId ?? "", a);
  const nums = new Map<string, string>();
  for (const n of kids(root, "num")) nums.set(n.attrs.numId ?? "", kid(n, "abstractNumId")?.attrs.val ?? "");
  return (numId, ilvl) => {
    const a = abstract.get(nums.get(numId) ?? "");
    const lvl = a && kids(a, "lvl").find((l) => Number(l.attrs.ilvl) === ilvl);
    return kid(lvl, "numFmt")?.attrs.val;
  };
}

// ---------- 小工具 ----------

/** mc:AlternateContent 只取一支（优先 Choice），不然同一段字会出现两遍。 */
function altBranch(node: XNode): XNode | undefined {
  return kid(node, "Choice") ?? kid(node, "Fallback");
}

/** 直接子元素里叫 name 的，穿过内容控件和自定义 XML 包装。 */
function unwrap(node: XNode, name: string): XNode[] {
  const out: XNode[] = [];
  for (const c of kids(node)) {
    if (c.name === name) out.push(c);
    else if (c.name === "sdt") out.push(...unwrap(kid(c, "sdtContent") ?? c, name));
    else if (c.name === "customXml" || c.name === "sdtContent") out.push(...unwrap(c, name));
  }
  return out;
}

/** 所有叫 name 的后代，找到了不再往里找；AlternateContent 只看一支。 */
function collect(node: XNode, name: string): XNode[] {
  const out: XNode[] = [];
  for (const c of kids(node)) {
    if (c.name === name) out.push(c);
    else if (c.name === "AlternateContent") { const b = altBranch(c); if (b) out.push(...collect(b, name)); }
    else out.push(...collect(c, name));
  }
  return out;
}

function outlineToLevel(val: string): number {
  const n = Number(val);
  return Number.isInteger(n) && n >= 0 && n < 9 ? Math.min(6, n + 1) : 0;
}

function numberOr(val: string | undefined): number | undefined {
  const n = Number(val);
  return val !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
}
