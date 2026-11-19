// 比两份文件、切出「一处一处」的改动（设计第 72 条，契约 LocalFileChangesResponse 的 detail / before / after / changes），
// 以及把其中几处恢复回去、变回能写回磁盘的字节。纯函数：只看给进来的字节，不碰磁盘。
import { DOC_TEXT_EXTENSIONS, docToText } from "../docText/index.js";
import { diffText, restoreText, type TextChange } from "./diff.js";
import { decodeText, encodeText } from "./encoding.js";
import { trimTables } from "./trim.js";

export { diffText, restoreText, TEXT_DIFF_LIMITS, type TextChange, type TextSpan } from "./diff.js";
export { TRIM_LIMITS, foldedLine } from "./trim.js";

export const FILE_CHANGE_LIMITS = {
  /** 文本文件超过这么多字节（任一边）只说改过，不给明细；转出来的文字也按这个算。 */
  maxTextBytes: 1024 * 1024,
};

/**
 * full：文本文件，两边都能逐字节还原，能按处恢复。
 * converted：Word、Excel 转出来的文字，或者编码还原不了的文本（只给看）。Excel 大表是裁过的。
 * none：只知道改过（超过上限、二进制、认不出编码、转不了的）。
 * 新建的 before 为 null、删掉的 after 为 null，整份算一处（id c1）；空文件新建、删掉没有改动。
 */
export type FileChanges =
  | { detail: "none" }
  | { detail: "full" | "converted"; before: string | null; after: string | null; changes: TextChange[] };

export type FileRestoreResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "not_restorable" | "unknown_ids" | "not_encodable" };

/**
 * 比两份文件。
 * @param ext 扩展名，带不带点都行
 * @param before 改前的字节，新建的给 null
 * @param after 改后的字节，删掉的给 null
 */
export function compareFiles(ext: string, before: Uint8Array | null, after: Uint8Array | null): FileChanges {
  const kind = ext.replace(/^\./, "").toLowerCase();
  if (DOC_TEXT_EXTENSIONS.includes(kind)) return compareConverted(kind, before, after);
  const a = before && decodeSide(before);
  const b = after && decodeSide(after);
  if (a === undefined || b === undefined || (!a && !b)) return { detail: "none" };
  const exact = (!a || a.exact) && (!b || b.exact);
  return withChanges(exact ? "full" : "converted", a?.text ?? null, b?.text ?? null);
}

/**
 * 恢复其中几处，回写回磁盘用的字节：编码、BOM、换行跟现在磁盘上（after）那份一样。
 * 只有两边都在、detail 是 full 时能按处恢复；ids 是 compareFiles 给的那一组里的。
 */
export function restoreFile(ext: string, before: Uint8Array | null, after: Uint8Array | null, ids: readonly string[]): FileRestoreResult {
  const kind = ext.replace(/^\./, "").toLowerCase();
  if (!before || !after || DOC_TEXT_EXTENSIONS.includes(kind)) return { ok: false, reason: "not_restorable" };
  const a = decodeSide(before);
  const b = decodeSide(after);
  if (!a?.exact || !b?.exact) return { ok: false, reason: "not_restorable" };
  const text = restoreText(a.text, b.text, diffText(a.text, b.text), ids);
  if (text === null) return { ok: false, reason: "unknown_ids" };
  const bytes = encodeText(text, b.encoding);
  return bytes ? { ok: true, bytes } : { ok: false, reason: "not_encodable" };
}

/** 解一边；超上限、二进制、认不出的回 undefined。 */
function decodeSide(bytes: Uint8Array) {
  if (bytes.length > FILE_CHANGE_LIMITS.maxTextBytes) return undefined;
  const d = decodeText(bytes);
  if (!d || Buffer.byteLength(d.text) > FILE_CHANGE_LIMITS.maxTextBytes) return undefined;
  return d;
}

function compareConverted(kind: string, before: Uint8Array | null, after: Uint8Array | null): FileChanges {
  const conv = (bytes: Uint8Array | null) => (bytes ? docToText(bytes, kind) : null);
  const a = conv(before);
  const b = conv(after);
  if ((a && !a.ok) || (b && !b.ok) || (!a && !b)) return { detail: "none" };
  let aText = a?.ok ? a.markdown : null;
  let bText = b?.ok ? b.markdown : null;
  if (a?.ok && a.kind === "xlsx" && b?.ok && b.kind === "xlsx") {
    // 对行时不看行号：中间加一行、删一行，后面的行只是行号变了，不算改过
    // 能省略的行：表格的数据行，和批注的每一行（批注常常比表格还长）
    const rows = (md: string, sheets: typeof a.sheets) =>
      new Set(sheets.flatMap((s) => [...s.rows.map((r) => r.start), ...s.notes.flatMap((n) => lineStarts(md, n.start, n.end))]));
    ({ before: aText, after: bText } = trimTables(a.markdown, b.markdown, rows(a.markdown, a.sheets), rows(b.markdown, b.sheets), withoutRowNumber));
    return withChanges("converted", aText, bText, withoutRowNumber);
  }
  return withChanges("converted", aText, bText);
}

/** Excel 转出来的数据行以「| 行号 |」开头，去掉它。 */
function withoutRowNumber(line: string): string {
  return line.replace(/^\| \d+ \|/, "|");
}

/** [start, end) 里每一行的起点。 */
function lineStarts(text: string, start: number, end: number): number[] {
  const out = [start];
  for (let i = text.indexOf("\n", start); i >= 0 && i + 1 < end; i = text.indexOf("\n", i + 1)) out.push(i + 1);
  return out;
}

function withChanges(detail: "full" | "converted", before: string | null, after: string | null, lineKey?: (line: string) => string): FileChanges {
  let changes: TextChange[];
  if (before !== null && after !== null) changes = diffText(before, after, lineKey);
  else {
    const text = before ?? after ?? "";
    const whole = { start: 0, end: text.length };
    const empty = { start: 0, end: 0 };
    changes = text ? [{ id: "c1", before: before === null ? empty : whole, after: after === null ? empty : whole }] : [];
  }
  return { detail, before, after, changes };
}
