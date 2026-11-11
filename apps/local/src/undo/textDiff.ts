import { createHash } from "node:crypto";
import { extname } from "node:path";
import type { TLocalTextChange } from "@warmap/contracts";

/**
 * 「一处」怎么切（设计第 72 条，契约 LocalTextChange）：先按行比；改过的行（一段删掉的行对着一段加上的行）里再按词比——
 * 中文、标点一个字一个词，英文字母数字连着的算一个词；中间只隔不超过 MERGE_GAP 个没变的字、且不跨行的并成一处。
 * 只加的行、只删的行整段算一处。区间是 JS 字符串下标，换行符原样不动。
 */
const MERGE_GAP = 3;
/** 一段改过的行太长时不再按词细分，整段算一处（免得比太久）。 */
const MAX_FINE = 20_000;
/** 差分最多走多少步（行、词各一档），超了整段算一处。 */
const MAX_D_LINES = 3_000;
const MAX_D_WORDS = 1_500;
export const MAX_TEXT_BYTES = 1024 * 1024;

type Op = { kind: "eq" | "del" | "ins"; a: number; b: number; len: number };

/**
 * Myers 差分：返回编辑脚本（按顺序的相等、删、加段）。先去掉首尾相同的部分；改动超过 maxD 步时回 null（调用方整段算一处）。
 * 每一步只存用得到的那一截 v，内存约 maxD² 个整数（3000 步约 36MB）。
 */
function myers<T>(a: T[], b: T[], maxD: number): Op[] | null {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const n = A.length, m = B.length, max = n + m;
  const lim = Math.min(max, maxD) + 2;
  const v = new Int32Array(2 * lim + 1); // v[k + lim]
  const trace: Int32Array[] = []; // 第 d 步之前 k 在 [-d-1, d+1] 的那一截
  const at = (k: number) => v[k + lim]!;
  let found = max === 0;
  for (let d = 0; d <= max && !found; d++) {
    if (d > maxD) return null;
    trace.push(v.slice(lim - d - 1, lim + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? at(k + 1) : at(k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v[k + lim] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
  }
  const ops: Op[] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d]!;
    const was = (kk: number) => vv[kk + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && was(k - 1) < was(k + 1)) ? k + 1 : k - 1;
    const px = was(prevK), py = px - prevK;
    while (x > px && y > py) { ops.push({ kind: "eq", a: x - 1, b: y - 1, len: 1 }); x--; y--; }
    if (d > 0) {
      if (x === px) ops.push({ kind: "ins", a: x, b: y - 1, len: 1 });
      else ops.push({ kind: "del", a: x - 1, b: y, len: 1 });
    }
    x = px; y = py;
  }
  ops.reverse();
  const out: Op[] = pre ? [{ kind: "eq", a: 0, b: 0, len: pre }] : [];
  const add = (o: Op) => {
    const last = out.at(-1);
    if (last && last.kind === o.kind && last.a + (o.kind === "ins" ? 0 : last.len) === o.a && last.b + (o.kind === "del" ? 0 : last.len) === o.b) last.len += o.len;
    else out.push({ ...o });
  };
  for (const o of ops) add({ ...o, a: o.a + pre, b: o.b + pre });
  if (suf) add({ kind: "eq", a: a.length - suf, b: b.length - suf, len: suf });
  return out;
}

/** 按行切，行尾的换行留在行里。 */
function lines(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
/** 按词切：字母数字连着的一个词，别的一个字一个词（UTF-16 代理对算一个）。 */
function words(s: string): string[] {
  return s.match(/[A-Za-z0-9_]+|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/g) ?? [];
}

interface Span { bs: number; be: number; as: number; ae: number }

/** 一段改过的行里按词比，挨得近的并起来。返回相对这一段开头的区间。 */
function fine(before: string, after: string): Span[] {
  if (before.length + after.length > MAX_FINE) return [{ bs: 0, be: before.length, as: 0, ae: after.length }];
  const wa = words(before), wb = words(after);
  const oa: number[] = [0], ob: number[] = [0];
  for (const w of wa) oa.push(oa.at(-1)! + w.length);
  for (const w of wb) ob.push(ob.at(-1)! + w.length);
  const spans: Span[] = [];
  let cur: Span | null = null;
  const ops = myers(wa, wb, MAX_D_WORDS);
  if (!ops) return [{ bs: 0, be: before.length, as: 0, ae: after.length }];
  for (const op of ops) {
    if (op.kind === "eq") {
      const gapText = wa.slice(op.a, op.a + op.len).join("");
      if (cur && (gapText.length > MERGE_GAP || gapText.includes("\n"))) { spans.push(cur); cur = null; }
      continue;
    }
    const bs = oa[op.a]!, be = op.kind === "del" ? oa[op.a + op.len]! : bs;
    const as = ob[op.b]!, ae = op.kind === "ins" ? ob[op.b + op.len]! : as;
    if (!cur) cur = { bs, be, as, ae };
    else { cur.be = Math.max(cur.be, be); cur.ae = Math.max(cur.ae, ae); }
  }
  if (cur) spans.push(cur);
  return spans;
}

/** 两份全文之间逐处的改动。 */
export function textChanges(before: string, after: string): TLocalTextChange[] {
  const la = lines(before), lb = lines(after);
  const oa: number[] = [0], ob: number[] = [0];
  for (const l of la) oa.push(oa.at(-1)! + l.length);
  for (const l of lb) ob.push(ob.at(-1)! + l.length);
  const out: TLocalTextChange[] = [];
  const push = (s: Span) => out.push({ id: `${s.bs}-${s.be}-${s.as}-${s.ae}`, before: { start: s.bs, end: s.be }, after: { start: s.as, end: s.ae } });
  const ops = myers(la, lb, MAX_D_LINES);
  // 改得太多：整份算一处
  if (!ops) { if (before !== after) push({ bs: 0, be: before.length, as: 0, ae: after.length }); return out; }
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.kind === "eq") continue;
    // 一段删掉的行紧跟一段加上的行（或反过来）：改过的行，里面再细分
    const next = ops[i + 1];
    let del: Op | null = op.kind === "del" ? op : null, ins: Op | null = op.kind === "ins" ? op : null;
    if (next && next.kind !== "eq" && next.kind !== op.kind) { if (next.kind === "del") del = next; else ins = next; i++; }
    const bs = del ? oa[del.a]! : ins ? oa[ins.a]! : 0;
    const be = del ? oa[del.a + del.len]! : bs;
    const as = ins ? ob[ins.b]! : del ? ob[del.b]! : 0;
    const ae = ins ? ob[ins.b + ins.len]! : as;
    if (!del || !ins) { push({ bs, be, as, ae }); continue; }
    for (const s of fine(before.slice(bs, be), after.slice(as, ae))) push({ bs: bs + s.bs, be: bs + s.be, as: as + s.as, ae: as + s.ae });
  }
  return out;
}

/** 把其中几处按改前那份写回：在改后那份上从后往前替换。 */
export function revertChanges(before: string, after: string, changes: TLocalTextChange[], ids: string[]): string {
  const pick = changes.filter((c) => ids.includes(c.id)).sort((x, y) => y.after.start - x.after.start);
  let s = after;
  for (const c of pick) s = s.slice(0, c.after.start) + before.slice(c.before.start, c.before.end) + s.slice(c.after.end);
  return s;
}

/** 文件内容的指纹（契约 revision）。 */
export const revisionOf = (b: Buffer | null) => (b ? createHash("sha1").update(b).digest("hex") : null);

const BINARY_EXT = new Set([".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt", ".pdf", ".zip", ".gz", ".7z", ".tar", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico",
  ".mp3", ".wav", ".mp4", ".mov", ".exe", ".dll", ".wasm", ".sqlite", ".db", ".psd", ".tiff", ".heic", ".woff", ".woff2", ".ttf"]);
// ignoreBOM：文件开头的 BOM 留在文字里，下标和写回都对得上
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** 能不能按文字比：不超过 1MB、不是二进制（扩展名、开头有 NUL、不是合法 UTF-8）。能就回文字，不能回 null。没有这个文件（新建前、删掉后）回 undefined 由调用方处理。 */
export function asText(path: string, b: Buffer): string | null {
  if (b.length > MAX_TEXT_BYTES || BINARY_EXT.has(extname(path).toLowerCase()) || b.subarray(0, 8192).includes(0)) return null;
  try { return utf8.decode(b); } catch { return null; }
}
