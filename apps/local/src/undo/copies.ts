import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { writeJsonAtomic } from "../store.js";

/**
 * 改前拷一份（ADR 0039）：执行方用改文件工具改一个快照管不到的已有文件之前（工作目录以外、大文件、快照还没好），把原文件拷到会话自己的目录里。
 * 每个文件只拷第一次（恢复要回到会话第一次动它之前）；当时不在的也记下（恢复就是删掉）。拷不了（被独占）就不记：这时执行方也改不了它。
 */
export interface CopyEntry {
  path: string;
  /** 拷在哪（会话目录里的文件名）；当时文件不在为 null。 */
  copy: string | null;
  size: number | null;
  mtimeMs: number | null;
  at: string;
}

const key = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));

export class Copies {
  private entries: Record<string, CopyEntry>;
  private readonly file: string;

  constructor(private readonly dir: string) {
    this.file = join(dir, "copies.json");
    this.entries = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Record<string, CopyEntry>) : {};
  }

  has(path: string): boolean {
    return key(path) in this.entries;
  }

  list(): CopyEntry[] {
    return Object.values(this.entries);
  }

  get(path: string): CopyEntry | undefined {
    return this.entries[key(path)];
  }

  /** 第一次动它之前留一份。 */
  async save(path: string): Promise<void> {
    const abs = resolve(path);
    if (this.has(abs)) return;
    const st = existsSync(abs) ? statSync(abs) : null;
    if (st && !st.isFile()) return;
    let copy: string | null = null;
    if (st) {
      copy = `${Object.keys(this.entries).length + 1}`;
      mkdirSync(join(this.dir, "files"), { recursive: true });
      try { await copyFile(abs, join(this.dir, "files", copy)); } catch { return; }
    }
    this.entries[key(abs)] = { path: abs, copy, size: st?.size ?? null, mtimeMs: st?.mtimeMs ?? null, at: new Date().toISOString() };
    writeJsonAtomic(this.file, this.entries);
  }

  /** 拷之后有没有变过（被拒绝、没改成的不算会话改的）。 */
  changed(e: CopyEntry): boolean {
    const st = existsSync(e.path) ? statSync(e.path) : null;
    if (!e.copy) return Boolean(st);
    return !st || st.size !== e.size || st.mtimeMs !== e.mtimeMs;
  }

  /** 写回第一次动之前的样子（当时不在的就删掉）。恢复前先把现在的样子拷一份到 before-restore 里。 */
  async restore(e: CopyEntry, stamp: string): Promise<void> {
    if (existsSync(e.path)) {
      const keep = join(this.dir, "before-restore", stamp);
      await mkdir(keep, { recursive: true });
      await copyFile(e.path, join(keep, `${e.copy ?? "new"}-${Object.keys(this.entries).indexOf(key(e.path))}`));
    }
    if (!e.copy) { await rm(e.path, { force: true }); return; }
    await mkdir(dirname(e.path), { recursive: true });
    await copyFile(join(this.dir, "files", e.copy), e.path);
    const st = statSync(e.path);
    // 恢复以后的样子当成新的起点：之后会话没再动就不算改过
    this.entries[key(e.path)] = { ...e, size: st.size, mtimeMs: st.mtimeMs };
    writeJsonAtomic(this.file, this.entries);
  }
}
