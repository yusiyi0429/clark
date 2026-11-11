// 比两份文字，切成「一处一处」的改动；把其中几处恢复回去。
// 先按行比，再在改过的那几行里按词比（中文、标点一个字一个词，英文单词、整个数各算一个词）；同一行里只隔不超过 3 个没变的字的并成一处，不跨行并。
// 用的是线性内存的 Myers 差分（找中间一段相同的，两边递归）。计算量按步数限（不按时间，同样的输入永远同样的结果）；
// 超了就退成「这一大块算一处」。

export const TEXT_DIFF_LIMITS = {
  /** 一次比较总共最多走多少步（行、字合计）。 */
  maxSteps: 60_000_000,
  /** 一块改过的行超过这么多字（任一边）就不按字比，整块算一处。 */
  maxHunkChars: 20_000,
  /** 同一行里两处改动之间没变的字不超过这么多，就并成一处。 */
  mergeGap: 3,
  /** 最多切成多少处（契约上限 2000）；超了整份算一处。 */
  maxChanges: 2000,
};

export interface TextSpan { start: number; end: number }
export interface TextChange { id: string; before: TextSpan; after: TextSpan }

/** [a 起, a 止, b 起, b 止)，下标是行号或字号。 */
type Region = [number, number, number, number];
interface Budget { steps: number }

/** 按行切开，每行带着自己的换行符（\n 或 \r\n），最后一行可能没有。 */
export function splitLines(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const nl = text.indexOf("\n", i);
    const end = nl < 0 ? text.length : nl + 1;
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/** 行一级改过的区域（行号）。差别极大时退成去掉相同开头、结尾以后的一整块。 */
export function lineRegions(aLines: string[], bLines: string[], budget: Budget = { steps: 0 }): Region[] {
  const ids = new Map<string, number>();
  const intern = (lines: string[]) => Int32Array.from(lines, (l) => {
    let id = ids.get(l);
    if (id === undefined) ids.set(l, (id = ids.size));
    return id;
  });
  return regions(intern(aLines), intern(bLines), budget);
}

/** 比两份文字，回逐处改动；同样的输入永远同样的结果，id 是 c1、c2… 按位置排。 */
export function diffText(before: string, after: string): TextChange[] {
  if (before === after) return [];
  const budget: Budget = { steps: 0 };
  const aLines = splitLines(before);
  const bLines = splitLines(after);
  const aStarts = lineStarts(aLines);
  const bStarts = lineStarts(bLines);
  const spans: Array<[TextSpan, TextSpan]> = [];
  for (const [as, ae, bs, be] of lineRegions(aLines, bLines, budget)) {
    const a = { start: aStarts[as], end: aStarts[ae] };
    const b = { start: bStarts[bs], end: bStarts[be] };
    if (a.start === a.end || b.start === b.end) spans.push([a, b]); // 整行新增或整行删除
    else spans.push(...refine(before, after, a, b, budget));
  }
  let out = spans;
  if (out.length > TEXT_DIFF_LIMITS.maxChanges) {
    const first = out[0];
    const last = out[out.length - 1];
    out = [[{ start: first[0].start, end: last[0].end }, { start: first[1].start, end: last[1].end }]];
  }
  return out.map(([b, a], i) => ({ id: `c${i + 1}`, before: b, after: a }));
}

/**
 * 把其中几处恢复成改前的样子，别的不动，回恢复后的全文。
 * changes 必须是 diffText(before, after) 给的那一组；ids 里有不认识的回 null。
 */
export function restoreText(before: string, after: string, changes: TextChange[], ids: readonly string[]): string | null {
  const byId = new Map(changes.map((c) => [c.id, c]));
  const picked: TextChange[] = [];
  for (const id of new Set(ids)) {
    const c = byId.get(id);
    if (!c) return null;
    picked.push(c);
  }
  picked.sort((x, y) => x.after.start - y.after.start);
  let out = "";
  let at = 0;
  for (const c of picked) {
    out += after.slice(at, c.after.start) + before.slice(c.before.start, c.before.end);
    at = c.after.end;
  }
  return out + after.slice(at);
}

// ---------- 改过的行里按字比 ----------

function refine(before: string, after: string, a: TextSpan, b: TextSpan, budget: Budget): Array<[TextSpan, TextSpan]> {
  const sa = before.slice(a.start, a.end);
  const sb = after.slice(b.start, b.end);
  if (sa.length > TEXT_DIFF_LIMITS.maxHunkChars || sb.length > TEXT_DIFF_LIMITS.maxHunkChars) return [[a, b]];
  const ids = new Map<string, number>();
  const ca = words(sa, ids);
  const cb = words(sb, ids);
  // 并：两处之间没变的不超过 mergeGap 个字（按字符数，不按词数）、而且中间没有换行
  const merged: Region[] = [];
  for (const r of regions(ca.ids, cb.ids, budget)) {
    const prev = merged[merged.length - 1];
    const gap = prev && sa.slice(ca.at[prev[1]], ca.at[r[0]]);
    if (prev && countChars(gap!) <= TEXT_DIFF_LIMITS.mergeGap && !gap!.includes("\n")) {
      prev[1] = r[1];
      prev[3] = r[3];
    } else merged.push([...r]);
  }
  return merged.map(([as, ae, bs, be]) => [
    { start: a.start + ca.at[as], end: a.start + ca.at[ae] },
    { start: b.start + cb.at[bs], end: b.start + cb.at[be] },
  ]);
}

// 一个词：英文字母连着的一串；一个数（中间的小数点、千分位逗号算在里面，后面的 % 和单位不算）；其余一个字一个词（中文、标点、空白、emoji）
const WORD = /[A-Za-z]+|[0-9]+(?:[.,][0-9]+)*|[\s\S]/gu;

/** 按词切开：ids 是每个词的编号（两边共用一张表），at[i] 是第 i 个词在字符串里的下标（at[词数] = 字符串长度）。 */
function words(s: string, table: Map<string, number>): { ids: Int32Array; at: Int32Array } {
  const ids: number[] = [];
  const at: number[] = [];
  for (const m of s.matchAll(WORD)) {
    let id = table.get(m[0]);
    if (id === undefined) table.set(m[0], (id = table.size));
    ids.push(id);
    at.push(m.index);
  }
  at.push(s.length);
  return { ids: Int32Array.from(ids), at: Int32Array.from(at) };
}

function countChars(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function lineStarts(lines: string[]): number[] {
  const out = [0];
  for (const l of lines) out.push(out[out.length - 1] + l.length);
  return out;
}

// ---------- Myers 差分（线性内存） ----------

/** 两串整数之间改过的区域，按位置排，相邻的并好。步数用完时，没算完的那块整块算改过。 */
function regions(a: Int32Array, b: Int32Array, budget: Budget): Region[] {
  const out: Region[] = [];
  const push = (r: Region) => {
    const prev = out[out.length - 1];
    if (prev && prev[1] === r[0] && prev[3] === r[2]) {
      prev[1] = r[1];
      prev[3] = r[3];
    } else out.push(r);
  };
  const walk = (aLo: number, aHi: number, bLo: number, bHi: number): void => {
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) { aLo++; bLo++; }
    while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) { aHi--; bHi--; }
    if (aLo === aHi || bLo === bHi) {
      if (aLo < aHi || bLo < bHi) push([aLo, aHi, bLo, bHi]);
      return;
    }
    const snake = middleSnake(a, b, aLo, aHi, bLo, bHi, budget);
    if (!snake) {
      push([aLo, aHi, bLo, bHi]);
      return;
    }
    const [x, y, u, v] = snake;
    walk(aLo, x, bLo, y);
    walk(u, aHi, v, bHi);
  };
  walk(0, a.length, 0, b.length);
  return out;
}

/**
 * 最短编辑路径正中间的那一段相同的（可能长度为 0），回 [x, y, u, v]：a[x..u) 和 b[y..v) 一样。
 * 两头同时往中间找，相遇就停。步数超了回 null。两边都不能是空的、头尾不能相同（调用前已经去掉）。
 */
function middleSnake(a: Int32Array, b: Int32Array, aLo: number, aHi: number, bLo: number, bHi: number, budget: Budget): [number, number, number, number] | null {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const delta = n - m;
  const odd = (delta & 1) !== 0;
  const maxD = Math.ceil((n + m) / 2);
  const off = maxD + 1;
  const vf = new Int32Array(2 * maxD + 3);
  const vb = new Int32Array(2 * maxD + 3);
  for (let d = 0; d <= maxD; d++) {
    // 往前
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && vf[off + k - 1] < vf[off + k + 1]) ? vf[off + k + 1] : vf[off + k - 1] + 1;
      let y = x - k;
      const x0 = x;
      const y0 = y;
      while (x < n && y < m && a[aLo + x] === b[bLo + y]) { x++; y++; }
      budget.steps += x - x0 + 1;
      vf[off + k] = x;
      const kr = delta - k;
      if (odd && kr >= -(d - 1) && kr <= d - 1 && x + vb[off + kr] >= n) return [aLo + x0, bLo + y0, aLo + x, bLo + y];
    }
    // 往后（倒过来的坐标：xr = n - x）
    for (let kr = -d; kr <= d; kr += 2) {
      let xr = kr === -d || (kr !== d && vb[off + kr - 1] < vb[off + kr + 1]) ? vb[off + kr + 1] : vb[off + kr - 1] + 1;
      let yr = xr - kr;
      const xr0 = xr;
      const yr0 = yr;
      while (xr < n && yr < m && a[aHi - 1 - xr] === b[bHi - 1 - yr]) { xr++; yr++; }
      budget.steps += xr - xr0 + 1;
      vb[off + kr] = xr;
      const k = delta - kr;
      if (!odd && k >= -d && k <= d && vf[off + k] + xr >= n) return [aHi - xr, bHi - yr, aHi - xr0, bHi - yr0];
    }
    if (budget.steps > TEXT_DIFF_LIMITS.maxSteps) return null;
  }
  return null;
}
