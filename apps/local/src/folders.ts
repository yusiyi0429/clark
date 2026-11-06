import { mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, parse, relative, isAbsolute, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { TLocalFolder } from "@warmap/contracts";
import { readJson, writeJsonAtomic, nowIso } from "./store.js";
import { homeDir } from "./agents/claudeEnv.js";

/** 真实路径：还不存在的路径（要新建的文件）按最深一层已存在的上级解析链接，再接上后面的部分，免得借目录链接写到外面。 */
const norm = (p: string) => {
  let dir = resolve(p);
  const rest: string[] = [];
  let r: string;
  for (;;) {
    try { r = join(realpathSync.native(dir), ...rest); break; } catch { /* 还不存在，往上找 */ }
    const parent = dirname(dir);
    if (parent === dir) { r = resolve(p); break; }
    rest.unshift(basename(dir));
    dir = parent;
  }
  return process.platform === "win32" ? r.toLowerCase() : r;
};

const under = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** p 是否在 root 里面（含 root 本身）；先解析符号链接、目录链接，防止借链接跳出去。 */
export function isInside(root: string, p: string): boolean {
  return under(norm(root), norm(p));
}

/** 同一批路径对同一组根目录判断时用：根目录只解析一次。 */
export function insideAny(roots: string[]): (p: string) => boolean {
  const rs = roots.map(norm);
  return (p) => { const n = norm(p); return rs.some((r) => under(r, n)); };
}

/** 本人允许本机程序读写的文件夹，只能经本机系统选择框添加。调研专题另有本机程序自己的专用目录。 */
export class Folders {
  private readonly file: string;
  constructor(private readonly dataDir: string, private readonly home: string = homeDir()) { this.file = join(dataDir, "folders.json"); }

  /** 不合规矩的旧条目（这条规矩之前加的）不算数。 */
  list(): TLocalFolder[] {
    return readJson<TLocalFolder[]>(this.file, []).filter((f) => !this.rejectReason(f.path));
  }

  /**
   * 太宽或放着钥匙的文件夹不让选：整个磁盘、主目录及其上级（选了等于什么都允许，越界检查失效）；
   * Claude 配置目录、本机程序数据目录，以及它们的上级（里面有登录凭据和钥匙）。
   */
  rejectReason(path: string): string | null {
    if (parse(resolve(path)).root === resolve(path)) return "不能选整个磁盘，请选具体的项目文件夹";
    if (isInside(path, this.home)) return "不能选主目录或它的上级文件夹，请选具体的项目文件夹";
    for (const dir of [join(this.home, ".claude"), this.dataDir]) {
      if (isInside(dir, path) || isInside(path, dir)) return "这个文件夹里有 Claude 或天枢本机程序的登录信息和钥匙，不能选";
    }
    return null;
  }

  /** 路径在不在本人允许的某个文件夹里。 */
  contains(p: string): boolean {
    return this.list().some((f) => isInside(f.path, p));
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
    return this.contains(cwd) || isInside(join(this.dataDir, "topics"), cwd);
  }
}
