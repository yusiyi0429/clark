import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { TLocalChangeDetail, TLocalFileChangesResponse, TLocalTextChange, TLocalTurnFileChange } from "@warmap/contracts";
import type { ChangePair, SessionUndo, TurnFile } from "./index.js";
import { asText, revertChanges, revisionOf, textChanges } from "./textDiff.js";

/**
 * 看得见改了什么、只动让动的那一块（设计第 72 条第一步，契约 LocalFileChangesResponse）：
 * 拿到一个文件前后两份以后，判断能不能按文字比、算逐处的改动、按处写回。数据来自 SessionUndo（快照和改前拷的那份）。
 */
export class ChangesError extends Error {
  constructor(readonly code: "not_found" | "validation" | "file_changed" | "conflict", message: string) { super(message); }
}

const posix = (p: string) => p.split(sep).join("/");

interface Built { file: TLocalFileChangesResponse; before: string | null; after: string | null; changes: TLocalTextChange[] }

/** 前后两份 → 契约的读结果。 */
export function build(pair: ChangePair, range: "turn" | "session", disk: Buffer | null): Built {
  const change = pair.before === null ? "added" : pair.after === null ? "deleted" : "modified";
  const base = { path: pair.path, absolutePath: pair.abs, range, turn: pair.turn, change, revision: revisionOf(disk) } as const;
  const none = (): Built => ({ file: { ...base, detail: "none", restorable: false }, before: null, after: null, changes: [] });
  if (pair.before === undefined) return none();
  const before = pair.before === null ? null : asText(pair.abs, pair.before);
  const after = pair.after === null ? null : asText(pair.abs, pair.after);
  if ((pair.before !== null && before === null) || (pair.after !== null && after === null)) return none();
  // 新建、删掉的整份算一处
  const changes = before === null ? [{ id: `0-0-0-${after!.length}`, before: { start: 0, end: 0 }, after: { start: 0, end: after!.length } }]
    : after === null ? [{ id: `0-${before.length}-0-0`, before: { start: 0, end: before.length }, after: { start: 0, end: 0 } }]
    : textChanges(before, after);
  const detail: TLocalChangeDetail = "full";
  const restorable = before !== null && after !== null && pair.afterIsDisk && changes.length > 0;
  return { file: { ...base, detail, before, after, changes, revision: base.revision, restorable }, before, after, changes };
}

/** 读一个文件的改动（不在工作树里的会话）。 */
export async function readChanges(undo: SessionUndo, path: string, range: "turn" | "session", turn?: number): Promise<Built> {
  const pair = await undo.pair(path, range, turn);
  if (!pair) throw new ChangesError("not_found", range === "turn" ? "这一轮没改过这个文件" : "这个会话没改过这个文件");
  return build(pair, range, existsSync(pair.abs) ? readFileSync(pair.abs) : null);
}

/** 按处写回：核对 revision、只能按处恢复的才行，写回前先留一份现在的。回新的读结果。 */
export async function restoreChanges(undo: SessionUndo, path: string, range: "turn" | "session", turn: number | undefined, ids: string[], revision: string | null): Promise<{ restored: string[]; file: TLocalFileChangesResponse }> {
  const now = await readChanges(undo, path, range, turn);
  if (now.file.revision !== revision) throw new ChangesError("file_changed", "文件在读了以后又变了，重读一次再恢复");
  if (!now.file.restorable) throw new ChangesError("validation", now.file.detail === "full" ? "这个文件只能整个恢复" : "这个文件看不到逐处的改动，只能整个恢复");
  const known = new Set(now.changes.map((c) => c.id));
  const bad = ids.filter((id) => !known.has(id));
  if (bad.length) throw new ChangesError("validation", `不认识的改动：${bad.slice(0, 5).join("、")}`);
  try {
    await undo.writeBack(now.file.absolutePath, revertChanges(now.before!, now.after!, now.changes, ids));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    if (["EBUSY", "EPERM", "EACCES"].includes(code)) throw new ChangesError("conflict", "文件正被别的程序打开（比如编辑器），关掉再点恢复");
    throw e;
  }
  return { restored: ids, file: (await readChanges(undo, path, range, turn)).file };
}

/** 一轮结束的事件里每个文件几处（detail 为 none 时为 null）。最多 100 个，多了算进 more。 */
export async function turnSummary(undo: SessionUndo, turn: number, files: TurnFile[]): Promise<{ files: TLocalTurnFileChange[]; more: number }> {
  const out: TLocalTurnFileChange[] = [];
  for (const f of files.slice(0, 100)) {
    const pair = await undo.pair(f.abs, "turn", turn).catch(() => null);
    const b = pair ? build(pair, "turn", null) : null;
    const full = b && b.file.detail !== "none";
    out.push({ path: f.path, absolutePath: f.abs, change: f.change, detail: full ? b!.file.detail : "none", count: full ? Math.max(1, b!.changes.length) : null });
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
  if (before === null && disk === null) throw new ChangesError("not_found", "这个会话没改过这个文件");
  if (before !== null && disk !== null && before.equals(disk)) throw new ChangesError("not_found", "这个会话没改过这个文件");
  const b = build({ abs, path: posix(rel), turn: null, before, after: disk, afterIsDisk: true }, "session", disk);
  return { ...b.file, restorable: false };
}
