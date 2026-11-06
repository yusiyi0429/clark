import { mkdirSync, realpathSync } from "node:fs";
import { basename, join, relative, isAbsolute, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { TLocalFolder } from "@warmap/contracts";
import { readJson, writeJsonAtomic, nowIso } from "./store.js";
import { homeDir } from "./agents/claudeEnv.js";

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
  constructor(private readonly dataDir: string, private readonly home: string = homeDir()) { this.file = join(dataDir, "folders.json"); }

  list(): TLocalFolder[] {
    return readJson<TLocalFolder[]>(this.file, []);
  }

  /**
   * 太宽或放着钥匙的文件夹不让选：主目录及其上级（选了等于什么都允许，越界检查失效）；
   * Claude 配置目录、本机程序数据目录，以及它们的上级（里面有登录凭据和钥匙）。
   */
  rejectReason(path: string): string | null {
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
