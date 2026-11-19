// Excel 大表裁剪：只留表名、表头、改过的行和它们上下各两行，中间没变的数据行收成一行「| 中间 N 行没改 |」；
// 批注那一段不是表格，没变的批注收成一行「中间 N 条批注没改」。
// 改前、改后两份按同一张行对照表裁，没变的那几段在两边一模一样，所以折起来的行在两边对得上。
import { lineRegions, splitLines } from "./diff.js";

export const TRIM_LIMITS = {
  /** 任一边数据行超过这么多才裁。 */
  minRows: 50,
  /** 改过的行上下各留几行。 */
  contextRows: 2,
};

/** 折起来的那一行：N 是这一处实际折掉的行数（本人 11/19 定，不用省略号）。 */
export const foldedLine = (n: number) => `| 中间 ${n} 行没改 |`;
/** 批注段折起来的那一行：N 是折掉的批注条数。 */
export const foldedNotes = (n: number) => `中间 ${n} 条批注没改`;

/**
 * @param beforeRows 改前那份里每个数据行的行首下标（来自转文字的结构化结果）
 * @param afterRows 改后那份里的
 * @param lineKey 对行时拿它算出来的去比，和 diffText 的一样
 */
export function trimTables(
  before: string,
  after: string,
  beforeRows: ReadonlySet<number>,
  afterRows: ReadonlySet<number>,
  lineKey: (line: string) => string = (l) => l,
): { before: string; after: string } {
  if (beforeRows.size <= TRIM_LIMITS.minRows && afterRows.size <= TRIM_LIMITS.minRows) return { before, after };
  const a = splitLines(before);
  const b = splitLines(after);
  const aData = dataFlags(a, beforeRows);
  const bData = dataFlags(b, afterRows);
  const keepA = new Uint8Array(a.length).fill(1);
  const keepB = new Uint8Array(b.length).fill(1);
  const equalRun = (a0: number, b0: number, len: number, changeBefore: boolean, changeAfter: boolean) => {
    for (let t = 0; t < len; t++) {
      const near = Math.min(changeBefore ? t + 1 : Infinity, changeAfter ? len - t : Infinity);
      if (near > TRIM_LIMITS.contextRows && aData[a0 + t] && bData[b0 + t]) keepA[a0 + t] = keepB[b0 + t] = 0;
    }
  };
  const regions = lineRegions(a.map(lineKey), b.map(lineKey));
  let ai = 0;
  let bi = 0;
  regions.forEach(([as, ae, bs, be], i) => {
    equalRun(ai, bi, as - ai, i > 0, true);
    ai = ae;
    bi = be;
  });
  equalRun(ai, bi, a.length - ai, regions.length > 0, false);
  return { before: build(a, keepA), after: build(b, keepB) };
}

function dataFlags(lines: string[], rowStarts: ReadonlySet<number>): Uint8Array {
  const flags = new Uint8Array(lines.length);
  let at = 0;
  lines.forEach((l, i) => {
    if (rowStarts.has(at)) flags[i] = 1;
    at += l.length;
  });
  return flags;
}

function build(lines: string[], keep: Uint8Array): string {
  let out = "";
  let folded = 0;
  /** 批注段（数据行不以「|」开头）：一条批注是「- 格子：字」起头、后面缩进两格的续行；从续行折起时那一条也算。 */
  let notes = 0;
  let end = "";
  const flush = () => {
    if (!folded) return;
    if (notes) {
      // 不是表格：前面空一行，免得 Markdown 把它并进上一条批注
      if (out && !out.endsWith("\n\n")) out += out.endsWith("\n") ? "\n" : "\n\n";
      out += foldedNotes(notes) + end;
    } else out += foldedLine(folded) + end;
    folded = 0;
    notes = 0;
  };
  lines.forEach((l, i) => {
    if (keep[i]) {
      flush();
      out += l;
    } else {
      if (!folded) end = l.endsWith("\n") ? "\n" : "";
      if (!l.startsWith("|") && (l.startsWith("- ") || !folded)) notes += 1;
      folded += 1;
    }
  });
  flush();
  return out;
}
