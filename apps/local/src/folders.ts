import { mkdirSync, realpathSync } from "node:fs";
import { basename, join, relative, isAbsolute, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { TLocalFolder } from "@warmap/contracts";
import { readJson, writeJsonAtomic, nowIso } from "./store.js";

const norm = (p: string) => {
  let r: string;
  try { r = realpathSync.native(resolve(p)); } catch { r = resolve(p); }
  return process.platform === "win32" ? r.toLowerCase() : r;
};

/** p 是否在 root 里面（含 root 本身）；先解析符号链接，防止借链接跳出去。 */
export function isInside(root: string, p: string): boolean {
  const rel = relative(norm(root), norm(p));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 本人允许本机程序读写的文件夹，只能经本机系统选择框添加。调研专题另有本机程序自己的专用目录。 */
export class Folders {
  private readonly file: string;
  constructor(private readonly dataDir: string) { this.file = join(dataDir, "folders.json"); }

  list(): TLocalFolder[] {
    return readJson<TLocalFolder[]>(this.file, []);
  }

  add(path: string): TLocalFolder {
    const existing = this.list().find((f) => norm(f.path) === norm(path));
    if (existing) return existing;
    const folder: TLocalFolder = { id: randomBytes(6).toString("hex"), path: resolve(path), label: basename(resolve(path)) || path, addedAt: nowIso() };
    writeJsonAtomic(this.file, [...this.list(), folder]);
    return folder;
  }

  remove(id: string): boolean {
    const list = this.list();
    if (!list.some((f) => f.id === id)) return false;
    writeJsonAtomic(this.file, list.filter((f) => f.id !== id));
    return true;
  }

  topicDir(topicId: string): string {
    const dir = join(this.dataDir, "topics", topicId.replace(/[^A-Za-z0-9_-]/g, "_"));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  isAllowed(cwd: string): boolean {
    return this.list().some((f) => isInside(f.path, cwd)) || isInside(join(this.dataDir, "topics"), cwd);
  }
}
