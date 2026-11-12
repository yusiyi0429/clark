// Word（.docx / .docm）→ Markdown：标题、段落、列表、表格照结构转，只留看得见的正文。
// 没用标题样式、只靠「整段加粗 + 字号比正文大」写的标题，在全文一个标题样式都没用时也认成标题，字号越大级别越高。
// 不带加粗、字体、颜色；修订取现在看到的样子（插入的算、删除的不算）；不读批注、页眉页脚、脚注。
// 图片、图表、嵌入对象写成固定占位字；文本框里的字跟在所在段落后面。
import { DocTextError } from "./limits.js";
import { cellMd, paragraphMd, tableMd } from "./markdown.js";
import { find, kid, kids, parseTree, readRels, relOfType, type XNode } from "./xml.js";
import type { ZipReader } from "./zip.js";

const PLACEHOLDER = { image: "【图片】", chart: "【图表】", object: "【嵌入对象】" } as const;

interface Style { name: string; basedOn?: string; outline?: number; numId?: string; ilvl?: number; sz?: number; b?: boolean }
interface Styles { map: Map<string, Style>; defaultId?: string; defaultSz: number }
/** look：这段像不像手写的标题（整段加粗、字号比正文大），像就记下字号。 */
type Block = { md: string; list: boolean; look?: number };
/** 一个有字的 run 自己身上的字号（半磅）和加粗，没写是 undefined。 */
type RunLook = { chars: number; sz?: number; b?: boolean };

/** 手写标题最多这么多字。 */
const LOOK_HEADING_MAX_CHARS = 60;
/** 手写标题的字号至少是正文的这么多倍（10.5 磅正文配 11 磅加粗不算，配 12 磅算）。 */
const LOOK_HEADING_MIN_RATIO = 1.1;

export function docxToMarkdown(zip: ZipReader): string {
  const docPart = relOfType(readRels(zip, ""), "officeDocument")?.target ?? "word/document.xml";
  const docXml = zip.readText(docPart);
  if (docXml === null) throw new DocTextError("corrupt", "转不了：文件坏了，或者不是 Word 文件");
  const body = find(parseTree(docXml), "body");
  if (!body) throw new DocTextError("corrupt", "转不了：文件坏了，或者不是 Word 文件");
  const rels = readRels(zip, docPart);
  const styles = readStyles(zip, relOfType(rels, "styles")?.target);
  const ctx = new Ctx(styles, readNumbering(zip, relOfType(rels, "numbering")?.target), bodySize(body, styles));
  ctx.blocks(body.children);
  if (!ctx.styledHeading) {
    // 全文没用标题样式：把手写的标题按字号从大到小排成 1、2、3… 级
    const sizes = [...new Set(ctx.out.map((b) => b.look ?? 0).filter(Boolean))].sort((a, b) => b - a);
    for (const b of ctx.out) if (b.look) b.md = `${"#".repeat(Math.min(6, sizes.indexOf(b.look) + 1))} ${b.md}`;
  }
  return join(ctx.out);
}

class Ctx {
  readonly out: Block[] = [];
  /** 有没有用标题样式（或大纲级别）的段落。 */
  styledHeading = false;
  private listLevel = -1;

  constructor(
    private readonly styles: Styles,
    private readonly numFmt: (numId: string, ilvl: number) => string | undefined,
    private readonly bodySz: number,
  ) {}

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
    const { text, boxes, runs } = paraText(p);
    const md = paragraphMd(text);
    if (md) {
      const pPr = kid(p, "pPr");
      const styleId = kid(pPr, "pStyle")?.attrs.val;
      const level = this.headingLevel(pPr, styleId);
      const num = level ? undefined : this.numbering(pPr, styleId);
      if (level) {
        this.styledHeading = true;
        this.push({ md: `${"#".repeat(level)} ${md.replace(/\n/g, " ")}`, list: false });
      }
      else if (num) {
        const lvl = Math.min(num.ilvl, this.listLevel + 1);
        this.listLevel = lvl;
        const lead = " ".repeat(4 * lvl);
        // 认得出是编号的写 1.；项目符号、不编号、认不出的都写成普通列表项
        const fmt = this.numFmt(num.numId, num.ilvl);
        const marker = fmt && fmt !== "bullet" && fmt !== "none" ? "1. " : "- ";
        const cont = "\n" + " ".repeat(lead.length + marker.length);
        this.push({ md: lead + marker + md.split("\n").join(cont), list: true });
      } else this.push({ md, list: false, look: this.headingLook(text, runs, styleId) });
    }
    for (const box of boxes) this.blocks(box.children);
  }

  /** 整段加粗、单行、不长、每个字的字号都比正文大一成以上：回这段最小的字号；不像标题回 0。 */
  private headingLook(text: string, runs: RunLook[], styleId: string | undefined): number {
    const t = text.trim();
    if (!runs.length || t.includes("\n") || [...t].length > LOOK_HEADING_MAX_CHARS) return 0;
    let min = Infinity;
    for (const r of runs) {
      if (!(r.b ?? styleValue(this.styles, styleId, "b"))) return 0;
      min = Math.min(min, r.sz ?? styleValue(this.styles, styleId, "sz") ?? this.styles.defaultSz);
    }
    return min >= this.bodySz * LOOK_HEADING_MIN_RATIO ? min : 0;
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
    yield* chain(this.styles.map, styleId);
  }
}

function* chain(map: Map<string, Style>, styleId: string | undefined): Generator<Style> {
  for (let i = 0, id = styleId; id && i < 20; i++) {
    const s = map.get(id);
    if (!s) return;
    yield s;
    id = s.basedOn;
  }
}

/** 段落样式链上（没写样式就用默认段落样式）第一个写了的字号或加粗。 */
function styleValue<K extends "sz" | "b">(styles: Styles, styleId: string | undefined, key: K): Style[K] | undefined {
  for (const s of chain(styles.map, styleId ?? styles.defaultId)) if (s[key] !== undefined) return s[key];
  return undefined;
}

/**
 * 正文字号：表格外、不加粗的字里，字数最多的那个字号（一样多取小的）；一个都没有就用正文样式的字号。
 * 不看表格（表格里常用小字，会把正文字号拉低），不看加粗的（标题多、正文短时会把正文字号拉高）。
 */
function bodySize(body: XNode, styles: Styles): number {
  const counts = new Map<number, number>();
  const walk = (node: XNode): void => {
    for (const c of node.children) {
      if (typeof c === "string" || c.name === "tbl") continue;
      if (c.name !== "p") { walk(c); continue; }
      const styleId = kid(kid(c, "pPr"), "pStyle")?.attrs.val;
      for (const r of paraText(c).runs) {
        if (r.b ?? styleValue(styles, styleId, "b")) continue;
        const sz = r.sz ?? styleValue(styles, styleId, "sz") ?? styles.defaultSz;
        counts.set(sz, (counts.get(sz) ?? 0) + r.chars);
      }
    }
  };
  walk(body);
  let best = styleValue(styles, undefined, "sz") ?? styles.defaultSz;
  let most = 0;
  for (const [sz, n] of counts) if (n > most || (n === most && sz < best)) { best = sz; most = n; }
  return best;
}

/** 一段的正文（未转义）、段里的文本框、每个有字的 run 的字号和加粗。 */
function paraText(p: XNode): { text: string; boxes: XNode[]; runs: RunLook[] } {
  const boxes: XNode[] = [];
  const runs: RunLook[] = [];
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
    const before = text.length;
    runKids(r.children);
    const chars = text.slice(before).replace(/\s/g, "").length;
    if (chars) runs.push({ chars, sz: numberOr(kid(rPr, "sz")?.attrs.val), b: onOff(kid(rPr, "b")) });
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
  return { text, boxes, runs };
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

function readStyles(zip: ZipReader, part: string | undefined): Styles {
  // 样式表里没写文档默认字号时，Word 按 10 磅（20 个半磅）
  const styles: Styles = { map: new Map(), defaultSz: 20 };
  const xml = part ? zip.readText(part) : null;
  if (xml === null) return styles;
  const root = parseTree(xml);
  styles.defaultSz = numberOr(kid(kid(kid(kid(root, "docDefaults"), "rPrDefault"), "rPr"), "sz")?.attrs.val) ?? 20;
  for (const s of kids(root, "style")) {
    const id = s.attrs.styleId;
    if (!id || (s.attrs.type && s.attrs.type !== "paragraph")) continue;
    if (s.attrs.default === "1" || s.attrs.default === "true") styles.defaultId ??= id;
    const pPr = kid(s, "pPr");
    const rPr = kid(s, "rPr");
    const numPr = kid(pPr, "numPr");
    const outline = kid(pPr, "outlineLvl")?.attrs.val;
    styles.map.set(id, {
      name: (kid(s, "name")?.attrs.val ?? "").toLowerCase(),
      basedOn: kid(s, "basedOn")?.attrs.val,
      outline: outline === undefined ? undefined : outlineToLevel(outline),
      numId: kid(numPr, "numId")?.attrs.val,
      ilvl: numberOr(kid(numPr, "ilvl")?.attrs.val),
      sz: numberOr(kid(rPr, "sz")?.attrs.val),
      b: onOff(kid(rPr, "b")),
    });
  }
  return styles;
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

/** <w:b/>、<w:b w:val="1"/> 是开，val 是 0 / false / off 是关，没有这个元素是 undefined。 */
function onOff(node: XNode | undefined): boolean | undefined {
  if (!node) return undefined;
  const v = node.attrs.val;
  return v !== "0" && v !== "false" && v !== "off";
}

function numberOr(val: string | undefined): number | undefined {
  const n = Number(val);
  return val !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
}
