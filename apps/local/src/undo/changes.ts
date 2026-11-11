import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { TLocalFileChangesResponse, TLocalTurnFileChange } from "@warmap/contracts";
import { compareFiles, restoreFile } from "../textChanges/index.js";
import type { ChangePair, SessionUndo, TurnFile } from "./index.js";

/**
 * 看得见改了什么、只动让动的那一块（设计第 72 条第一步，契约 LocalFileChangesResponse）的接线：
 * 前后两份字节从 SessionUndo 取（快照、改前拷的那份），怎么比、怎么切「一处」、Word Excel 转文字、按处写回的字节都交给 textChanges/。
 * 这里只管 revision、能不能按处恢复（磁盘上现在就是 after 那份）、写回前留一份、一轮结束的处数。
 */
export class ChangesError extends Error {
  constructor(readonly code: "not_found" | "validation" | "file_changed" | "conflict", message: string) { super(message); }
}

const posix = (p: string) => p.split(sep).join("/");
/** 文件内容的指纹（契约 revision）：磁盘上现在的字节的 SHA-1，不在了为 null。 */
const revisionOf = (b: Buffer | null) => (b ? createHash("sha1").update(b).digest("hex") : null);

/** 前后两份 → 契约的读结果。 */
export function build(pair: ChangePair, range: "turn" | "session", disk: Buffer | null): TLocalFileChangesResponse {
  const change = pair.before === null ? "added" : pair.after === null ? "deleted" : "modified";
  const base = { path: pair.path, absolutePath: pair.abs, range, turn: pair.turn, change, revision: revisionOf(disk) } as const;
  if (pair.before === undefined) return { ...base, detail: "none", restorable: false };
  const r = compareFiles(extname(pair.abs), pair.before, pair.after);
  if (r.detail === "none") return { ...base, detail: "none", restorable: false };
  const restorable = r.detail === "full" && pair.before !== null && pair.after !== null && pair.afterIsDisk && r.changes.length > 0;
  return { ...base, detail: r.detail, before: r.before, after: r.after, changes: r.changes, restorable };
}

async function pairOf(undo: SessionUndo, path: string, range: "turn" | "session", turn?: number): Promise<ChangePair> {
  const pair = await undo.pair(path, range, turn);
  if (!pair) throw new ChangesError("not_found", range === "turn" ? "这一轮没改过这个文件" : "这个会话没改过这个文件");
  return pair;
}

/** 读一个文件的改动（不在工作树里的会话）。 */
export async function readChanges(undo: SessionUndo, path: string, range: "turn" | "session", turn?: number): Promise<TLocalFileChangesResponse> {
  const pair = await pairOf(undo, path, range, turn);
  return build(pair, range, existsSync(pair.abs) ? readFileSync(pair.abs) : null);
}

/** 按处写回：核对 revision、只能按处恢复的才行，写回前先留一份现在的。回新的读结果。 */
export async function restoreChanges(undo: SessionUndo, path: string, range: "turn" | "session", turn: number | undefined, ids: string[], revision: string | null): Promise<{ restored: string[]; file: TLocalFileChangesResponse }> {
  const pair = await pairOf(undo, path, range, turn);
  const disk = existsSync(pair.abs) ? readFileSync(pair.abs) : null;
  const now = build(pair, range, disk);
  if (now.revision !== revision) throw new ChangesError("file_changed", "文件在读了以后又变了，重读一次再恢复");
  if (!now.restorable) throw new ChangesError("validation", now.detail === "full" ? "这个文件只能整个恢复" : "这个文件看不到逐处的改动，只能整个恢复");
  const r = restoreFile(extname(pair.abs), pair.before!, pair.after!, ids);
  if (!r.ok) {
    throw new ChangesError("validation", r.reason === "unknown_ids" ? "有不认识的改动，重读一次再恢复" : r.reason === "not_encodable" ? "改前那段有这个文件的编码存不下的字，只能整个恢复" : "这个文件只能整个恢复");
  }
  try {
    await undo.writeBack(pair.abs, Buffer.from(r.bytes));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    if (["EBUSY", "EPERM", "EACCES"].includes(code)) throw new ChangesError("conflict", "文件正被别的程序打开（比如编辑器），关掉再点恢复");
    throw e;
  }
  return { restored: ids, file: await readChanges(undo, path, range, turn) };
}

/** 一轮结束的事件里每个文件几处（detail 为 none 时为 null）。最多 100 个，多了算进 more。 */
export async function turnSummary(undo: SessionUndo, turn: number, files: TurnFile[]): Promise<{ files: TLocalTurnFileChange[]; more: number }> {
  const out: TLocalTurnFileChange[] = [];
  for (const f of files.slice(0, 100)) {
    const pair = await undo.pair(f.abs, "turn", turn).catch(() => null);
    const b = pair ? build(pair, "turn", null) : null;
    const seen = b && b.detail !== "none";
    out.push({ path: f.path, absolutePath: f.abs, change: f.change, detail: seen ? b!.detail : "none", count: seen ? Math.max(1, b!.changes!.length) : null });
  }
  return { files: out, more: Math.max(0, files.length - 100) };
}

/** git 里某个提交的某个文件（没有为 null）。 */
function gitShow(cwd: string, commit: string, rel: string): Promise<Buffer | null> {
  return new Promise((done) => {
    const child = spawn("git", ["-c", "core.quotepath=false", "cat-file", "blob", `${commit}:${rel}`], { cwd, windowsHide: true });
    const out: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.on("error", () => done(null));
    child.on("close", (code) => done(code === 0 ? Buffer.concat(out) : null));
  });
}

/** 卡在 git 工作树里做的会话：只有「开工到现在」，从开工的提交比到工作树现在的样子；不能按处恢复（合回前用不着）。 */
export async function readWorktreeChanges(root: string, base: string, path: string): Promise<TLocalFileChangesResponse> {
  const abs = isAbsolute(path) ? resolve(path) : join(root, path);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new ChangesError("not_found", "不在这张卡的工作树里");
  const disk = existsSync(abs) ? readFileSync(abs) : null;
  const before = await gitShow(root, base, posix(rel));
  if ((before === null && disk === null) || (before !== null && disk !== null && before.equals(disk))) throw new ChangesError("not_found", "这个会话没改过这个文件");
  return { ...build({ abs, path: posix(rel), turn: null, before, after: disk, afterIsDisk: true }, "session", disk), restorable: false };
}
