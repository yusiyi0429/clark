/**
 * 这一轮改了什么（设计第 72 条第一步）：本机给改前、改后两份全文和逐处的位置（「一处」由本机切好），网页照位置画，不自己再比一遍。
 * 这里是纯函数：核对位置、按块切成「没改的」和「改了的」几段、判断一段能不能只标那几个字。
 * 标不准就整块标（改前那块划掉、改后那块标绿）：宁可标粗一点，不许标错位置。
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import { REMARK_PLUGINS } from "@/lib/markdown";

// —— 临时类型：本机的契约到了换成 @warmap/contracts 里的 ——

export type ChangeRange = "turn" | "session";
export type ChangeSpan = { start: number; end: number };
/** 一处：在改前、改后两份全文里的字符区间（JS 字符串下标，换行符原样）。纯新增时 before 是空区间，纯删除时 after 是空区间。 */
export type FileChange = { id: string; before: ChangeSpan; after: ChangeSpan };
/** 读一个文件的改动。新建的 before 为 null，删掉的 after 为 null；detail = none 只知道改过（超过 1MB、二进制），没有两份全文和逐处。 */
export type FileChanges = {
  path: string;
  range: ChangeRange;
  before: string | null;
  after: string | null;
  changes: FileChange[];
  /** 读的那一刻文件内容的指纹，恢复时原样带回去核对。 */
  revision: string;
  detail: "full" | "none";
};

export type DiffMode = "markdown" | "text";

/** 改了的一段里的一小块：没改的字，或者一处改动（删掉的、加上的）。 */
export type Part = { kind: "same"; text: string } | { kind: "change"; id: string; del: string; ins: string };

export type Section =
  /** 没改的：blocks 是按块切好的源文（Markdown 按顶层块，别的按行），拼起来就是这一段。 */
  | { kind: "same"; blocks: string[] }
  /**
   * 改了的一段：从一块的开头到一块的结尾，含一处或相邻的几处。
   * inline：能只标那几个字；false 时整块标。table：这一段就是一张表（「恢复这处」放在格子里，不放在下面）。
   */
  | { kind: "change"; ids: string[]; parts: Part[]; inline: boolean; table: boolean };

/** 每处改动上下各留几块（Markdown 按块算，别的按行算）。 */
export const CONTEXT_BLOCKS = 2;

// 拼进源文的记号：用私用区的字，正常文档里几乎不会有；文档里本来就有私用区的字时一律整块标。
export const DEL_OPEN = "";
export const DEL_CLOSE = "";
export const INS_OPEN = "";
export const INS_CLOSE = "";
/** 开头记号后面紧跟一个字，是这一处在这一段里的序号（U+E000 起）。 */
export const ID_BASE = 0xe000;
const ID_MAX = 0xefff - ID_BASE;
const PRIVATE_USE = /[-]/;

/** 位置核对：区间在界内、按顺序不重叠、两处之间没改的字两边一模一样、整份对得上。对不上回 null（不画明细，只写「改过」）。 */
export function sortedChanges(before: string, after: string, changes: readonly FileChange[]): FileChange[] | null {
  const list = [...changes].sort((x, y) => x.after.start - y.after.start || x.before.start - y.before.start);
  let b = 0;
  let a = 0;
  const ok = (span: ChangeSpan, from: number, length: number) =>
    Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= from && span.end >= span.start && span.end <= length;
  for (const change of list) {
    if (!ok(change.before, b, before.length) || !ok(change.after, a, after.length)) return null;
    if (change.before.start - b !== change.after.start - a || before.slice(b, change.before.start) !== after.slice(a, change.after.start)) return null;
    b = change.before.end;
    a = change.after.end;
  }
  return before.length - b === after.length - a && before.slice(b) === after.slice(a) ? list : null;
}

type MdNode = { type: string; value?: unknown; children?: MdNode[]; position?: { start?: { offset?: number } }; [key: string]: unknown };

const parser = unified().use(remarkParse).use(REMARK_PLUGINS);
const parseMarkdown = (text: string) => parser.parse(text) as unknown as MdNode;

/** 每一块从哪开始（含 0 和全文长度）：Markdown 是顶层块（往回对齐到行首的缩进前），别的是每一行。 */
export function blockStarts(text: string, mode: DiffMode): number[] {
  const starts = new Set<number>([0, text.length]);
  if (mode === "text") {
    for (let index = text.indexOf("\n"); index >= 0 && index + 1 < text.length; index = text.indexOf("\n", index + 1)) starts.add(index + 1);
  } else {
    for (const child of parseMarkdown(text).children ?? []) {
      let offset = child.position?.start?.offset;
      if (typeof offset !== "number") continue;
      const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
      if (/^[ \t]*$/.test(text.slice(lineStart, offset))) offset = lineStart;
      starts.add(offset);
    }
  }
  return [...starts].sort((x, y) => x - y);
}

/** sorted 里落在 [from, to] 的。 */
function within(sorted: readonly number[], from: number, to: number): number[] {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid]! < from) lo = mid + 1; else hi = mid; }
  const out: number[] = [];
  for (let index = lo; index < sorted.length && sorted[index]! <= to; index += 1) out.push(sorted[index]!);
  return out;
}

/** 一段没改的按块切开（块的起点用改后那份的）。 */
function sameBlocks(after: string, from: number, to: number, afterStarts: readonly number[]): string[] {
  const cuts = [from, ...within(afterStarts, from + 1, to - 1), to];
  const blocks: string[] = [];
  for (let index = 0; index + 1 < cuts.length; index += 1) blocks.push(after.slice(cuts[index]!, cuts[index + 1]!));
  return blocks.filter(Boolean);
}

/**
 * 摆出来的样子：没改的段和改了的段交替。改了的段两头都落在两份共有的块边界上（改前改后都是一块的开头）；
 * 两处之间没有共有的边界（同一块里两处、或者改动动了块的结构）就并成一段。位置对不上回 null。
 */
export function diffLayout(data: Pick<FileChanges, "before" | "after" | "changes">, mode: DiffMode): Section[] | null {
  const before = data.before ?? "";
  const after = data.after ?? "";
  const changes = sortedChanges(before, after, data.changes);
  if (!changes) return null;
  if (!changes.length) return after ? [{ kind: "same", blocks: sameBlocks(after, 0, after.length, blockStarts(after, mode)) }] : [];
  const afterStarts = blockStarts(after, mode);
  const beforeSet = new Set(blockStarts(before, mode));
  /** 第 k 段没改的（第 k 处之前那段）里两份共有的块边界，按改后那份的位置。 */
  const common = (k: number): number[] => {
    const fromA = k === 0 ? 0 : changes[k - 1]!.after.end;
    const fromB = k === 0 ? 0 : changes[k - 1]!.before.end;
    const toA = k === changes.length ? after.length : changes[k]!.after.start;
    return within(afterStarts, fromA, toA).filter((offset) => beforeSet.has(offset - fromA + fromB));
  };
  const sections: Section[] = [];
  const pushSame = (from: number, to: number) => { const blocks = sameBlocks(after, from, to, afterStarts); if (blocks.length) sections.push({ kind: "same", blocks }); };
  let regionStart = common(0).at(-1)!;
  pushSame(0, regionStart);
  let members: FileChange[] = [changes[0]!];
  for (let k = 1; k <= changes.length; k += 1) {
    const shared = common(k);
    if (!shared.length) { members.push(changes[k]!); continue; }
    const regionEnd = shared[0]!;
    sections.push(changeSection(before, after, regionStart, regionEnd, members, mode));
    regionStart = k === changes.length ? after.length : shared.at(-1)!;
    pushSame(regionEnd, regionStart);
    members = k < changes.length ? [changes[k]!] : [];
  }
  return sections;
}


function changeSection(before: string, after: string, from: number, to: number, members: FileChange[], mode: DiffMode): Section {
  const parts: Part[] = [];
  let cursor = from;
  for (const change of members) {
    if (change.after.start > cursor) parts.push({ kind: "same", text: after.slice(cursor, change.after.start) });
    parts.push({ kind: "change", id: change.id, del: before.slice(change.before.start, change.before.end), ins: after.slice(change.after.start, change.after.end) });
    cursor = change.after.end;
  }
  if (to > cursor) parts.push({ kind: "same", text: after.slice(cursor, to) });
  const judged = mode === "text" ? { inline: true, table: false } : markInline(parts);
  return { kind: "change", ids: members.map((change) => change.id), parts, ...judged };
}

/** 这一段改前、改后的源文。 */
export const sideText = (parts: readonly Part[], side: "before" | "after") =>
  parts.map((part) => (part.kind === "same" ? part.text : side === "before" ? part.del : part.ins)).join("");

/** 带记号的源文：每处写成「删掉的」「加上的」两截（空的那截不写），记号后面跟这一处在这一段里的序号。 */
export function markedSource(parts: readonly Part[]): string {
  let index = 0;
  return parts.map((part) => {
    if (part.kind === "same") return part.text;
    const id = String.fromCharCode(ID_BASE + index++);
    return (part.del ? DEL_OPEN + id + part.del + DEL_CLOSE : "") + (part.ins ? INS_OPEN + id + part.ins + INS_CLOSE : "");
  }).join("");
}

type Norm = Record<string, unknown>;
/** 记号只许落在这几种节点的字里（落到链接地址、图片、HTML 里就画不出来）。 */
const VALUE_CARRIERS = new Set(["text", "inlineCode", "code"]);
/** 去掉一边以后变空的行内容器（整段加粗、整个链接被删）不算结构变了。 */
const PRUNABLE = new Set(["emphasis", "strong", "delete", "link", "linkReference", "inlineCode"]);
type Walk = { mode: "del" | "ins" | null; expectId: boolean; marks: number; ok: boolean };

function tidy(children: Norm[]): Norm[] {
  const out: Norm[] = [];
  for (const child of children) {
    if (child.type === "text" && child.value === "") continue;
    if (PRUNABLE.has(child.type as string) && (child.type === "inlineCode" ? child.value === "" : !(child.children as Norm[]).length)) continue;
    const last = out.at(-1);
    if (child.type === "text" && last?.type === "text") out[out.length - 1] = { ...last, value: `${last.value as string}${child.value as string}` };
    else out.push(child);
  }
  return out;
}

/** 一棵树去掉一边：改后的样子（去掉删掉的）、改前的样子（去掉加上的）；顺带核对记号都落在字里、成对。 */
function project(node: MdNode, walk: Walk): [Norm, Norm] {
  const { position, children, value, ...attrs } = node;
  void position;
  if (PRIVATE_USE.test(JSON.stringify(attrs))) walk.ok = false;
  if (typeof value === "string") {
    if (!VALUE_CARRIERS.has(node.type)) {
      if (PRIVATE_USE.test(value)) walk.ok = false;
      return [{ ...attrs, value }, { ...attrs, value }];
    }
    let after = "";
    let before = "";
    for (const ch of value) {
      if (walk.expectId) {
        const code = ch.charCodeAt(0);
        if (ch.length !== 1 || code < ID_BASE || code > ID_BASE + ID_MAX) walk.ok = false;
        walk.expectId = false;
        continue;
      }
      if (ch === DEL_OPEN || ch === INS_OPEN) {
        if (walk.mode) walk.ok = false;
        walk.mode = ch === DEL_OPEN ? "del" : "ins";
        walk.expectId = true;
        walk.marks += 1;
        continue;
      }
      if (ch === DEL_CLOSE || ch === INS_CLOSE) {
        if (walk.mode !== (ch === DEL_CLOSE ? "del" : "ins")) walk.ok = false;
        walk.mode = null;
        continue;
      }
      if (PRIVATE_USE.test(ch)) walk.ok = false;
      if (walk.mode !== "del") after += ch;
      if (walk.mode !== "ins") before += ch;
    }
    if (walk.expectId) walk.ok = false;
    return [{ ...attrs, value: after }, { ...attrs, value: before }];
  }
  if (!children) {
    // 图片、换行、分隔线这类没有字的落在一处改动里面，标不出来。
    if (walk.mode) walk.ok = false;
    return [attrs, attrs];
  }
  const afterKids: Norm[] = [];
  const beforeKids: Norm[] = [];
  for (const child of children) {
    const [after, before] = project(child, walk);
    afterKids.push(after);
    beforeKids.push(before);
  }
  return [{ ...attrs, children: tidy(afterKids) }, { ...attrs, children: tidy(beforeKids) }];
}

const shape = (text: string) => JSON.stringify(project(parseMarkdown(text), { mode: null, expectId: false, marks: 0, ok: true })[0]);

/**
 * 一段 Markdown 能不能只标那几个字：把记号拼进源文解析一遍，去掉删掉的应当和改后那份解析出来一模一样，去掉加上的应当和改前那份一模一样
 * （块的种类、层级、链接地址、字都对得上），记号都落在字里、成对。有一条不满足就整块标。
 * 整块新加、整块删掉（这一段改前或改后是空的）直接整块标。
 */
export function markInline(parts: readonly Part[]): { inline: boolean; table: boolean } {
  const before = sideText(parts, "before");
  const after = sideText(parts, "after");
  const afterTree = parseMarkdown(after);
  const blocks = (afterTree.children ?? []).filter((child) => child.type !== "definition");
  const table = blocks.length === 1 && blocks[0]!.type === "table";
  const changes = parts.filter((part) => part.kind === "change");
  if (!before.trim() || !after.trim() || changes.length > ID_MAX + 1 || PRIVATE_USE.test(before) || PRIVATE_USE.test(after)) return { inline: false, table };
  const walk: Walk = { mode: null, expectId: false, marks: 0, ok: true };
  const [afterSide, beforeSide] = project(parseMarkdown(markedSource(parts)), walk);
  const expected = changes.reduce((sum, part) => sum + (part.del ? 1 : 0) + (part.ins ? 1 : 0), 0);
  const inline = walk.ok && walk.mode === null && walk.marks === expected
    && JSON.stringify(afterSide) === shape(after) && JSON.stringify(beforeSide) === shape(before);
  return { inline, table };
}

/** 一段没改的怎么收：前后各留 CONTEXT_BLOCKS 块，中间收起来（收起来的不到 2 块且不到 3 行就不收）。first：文件开头那段（只留后面）；last：结尾那段（只留前面）。 */
export function foldSame(blocks: readonly string[], { first, last }: { first: boolean; last: boolean }): { head: string; hidden: string; tail: string; hiddenLines: number } {
  const keepHead = first ? 0 : CONTEXT_BLOCKS;
  const keepTail = last ? 0 : CONTEXT_BLOCKS;
  const join = (list: readonly string[]) => list.join("");
  if (blocks.length <= keepHead + keepTail) return { head: join(blocks), hidden: "", tail: "", hiddenLines: 0 };
  const hidden = join(blocks.slice(keepHead, blocks.length - keepTail));
  const hiddenLines = countLines(hidden);
  if (blocks.length - keepHead - keepTail < 2 && hiddenLines < 3) return { head: join(blocks), hidden: "", tail: "", hiddenLines: 0 };
  return { head: join(blocks.slice(0, keepHead)), hidden, tail: join(blocks.slice(blocks.length - keepTail)), hiddenLines };
}

/** 「没改的 N 行」：不算空行。 */
export const countLines = (text: string) => text.split("\n").filter((line) => line.trim()).length;
