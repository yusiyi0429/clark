import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { TLocalChangedFile, TLocalFileKind, TLocalSessionEvent, TLocalSessionFileReadResponse, TLocalSessionFilesResponse } from "@warmap/contracts";
import { isInside } from "./folders.js";
import { git } from "./git.js";

/**
 * 在右边预览文件（设计 17.2 第 41 条，契约 LocalSessionFileReadResponse、LocalSessionFilesResponse）：读一个文件、列本会话写过改过的文件。
 * 都只看会话根（卡的工作树根，或工作目录）和项目另外绑的文件夹（extras，第 46 条）里面的；只读。会话根里的 path 相对会话根，另外的文件夹里的是绝对路径。
 */
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 500;
const SNIFF_BYTES = 8192;

const MARKDOWN = new Set([".md", ".markdown"]);
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".ico": "image/x-icon",
};
/** 一看扩展名就知道不是文本的（不用读内容去猜；PDF 开头几 KB 里不一定有 NUL）。 */
const BINARY_MIME: Record<string, string> = {
  ".pdf": "application/pdf", ".zip": "application/zip", ".gz": "application/gzip", ".tar": "application/x-tar", ".7z": "application/x-7z-compressed",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".doc": "application/msword", ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4", ".mov": "video/quicktime",
  ".tiff": "image/tiff", ".heic": "image/heic", ".psd": "image/vnd.adobe.photoshop", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".exe": "application/octet-stream", ".dll": "application/octet-stream", ".wasm": "application/wasm", ".sqlite": "application/octet-stream", ".db": "application/octet-stream",
};
const TEXT_MIME: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".csv": "text/csv", ".json": "application/json", ".xml": "application/xml", ".svg": "image/svg+xml",
  ".js": "text/javascript", ".mjs": "text/javascript", ".ts": "text/typescript", ".tsx": "text/typescript", ".yaml": "application/yaml", ".yml": "application/yaml",
};

export class SessionFileError extends Error {
  constructor(readonly code: "not_found" | "folder_not_allowed" | "validation", message: string) { super(message); }
}

const posix = (p: string) => p.split(sep).join("/");

/** 读文件开头最多 max 个字节。 */
function head(file: string, max: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(max);
    return buf.subarray(0, readSync(fd, buf, 0, max, 0));
  } finally {
    closeSync(fd);
  }
}

/** 按字面在不在会话根里：不碰文件系统（.. 穿越、别的盘、别的主机上的共享路径都在这里挡掉，不会先去连它）。 */
function within(root: string, p: string): boolean {
  const rel = relative(root, p);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * 读一个文件。path 是绝对路径，或相对路径：先按工作目录找（执行方说的相对路径是相对它的），没有再按会话根找；不去另外的文件夹里猜同名的。
 * 先按字面判在不在会话根、另外的文件夹里，再按解析掉链接的真实路径判一遍（指到外面的链接也算在外面）。
 */
export function readSessionFile(root: string, cwd: string, path: string, extras: string[] = []): TLocalSessionFileReadResponse {
  if (path.includes("\0")) throw new SessionFileError("validation", "路径不对");
  const given = sep === "/" ? path.replace(/\\/g, "/") : path; // 反斜杠在 Mac、Linux 上也当分隔符（回答里的路径可能是在 Windows 上写的）
  const roots = [root, ...extras];
  const inside = [...new Set([resolve(cwd, given), resolve(root, given)])].filter((p) => roots.some((r) => within(r, p)));
  if (!inside.length) throw new SessionFileError("folder_not_allowed", "只能读本会话的文件夹或工作树里的文件");
  const abs = inside.find((p) => existsSync(p) && statSync(p).isFile());
  if (!abs) throw new SessionFileError("not_found", "文件不存在");
  if (!roots.some((r) => isInside(r, abs))) throw new SessionFileError("folder_not_allowed", "只能读本会话的文件夹或工作树里的文件");
  const st = statSync(abs);
  const ext = extname(abs).toLowerCase();
  const meta = { path: within(root, abs) ? posix(relative(root, abs)) : posix(abs), absolutePath: abs, name: basename(abs), size: st.size, modifiedAt: st.mtime.toISOString() };
  if (IMAGE_MIME[ext]) {
    const fits = st.size <= MAX_IMAGE_BYTES;
    return { ...meta, kind: "image", mimeType: IMAGE_MIME[ext], encoding: "base64", content: fits ? head(abs, MAX_IMAGE_BYTES).toString("base64") : null, truncated: !fits };
  }
  const binary = BINARY_MIME[ext] ?? (MARKDOWN.has(ext) || !head(abs, SNIFF_BYTES).includes(0) ? null : "application/octet-stream");
  if (binary) return { ...meta, kind: "other", mimeType: binary, encoding: "base64", content: null, truncated: false };
  const kind: TLocalFileKind = MARKDOWN.has(ext) ? "markdown" : "text";
  return {
    ...meta, kind, mimeType: kind === "markdown" ? "text/markdown" : TEXT_MIME[ext] ?? "text/plain", encoding: "utf8",
    content: head(abs, MAX_TEXT_BYTES).toString("utf8"), truncated: st.size > MAX_TEXT_BYTES,
  };
}

/** 执行方用写文件、改文件的工具动过的（事件记录里有结果、没出错的）：Claude Code 的 input.file_path，Codex 改文件的 input.files。相对路径按工作目录算。 */
function toolFiles(events: TLocalSessionEvent[], cwd: string): string[] {
  const WRITES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
  const calls = new Map<string, string[]>();
  const done: string[] = [];
  for (const e of events) {
    if (e.type === "tool_call" && WRITES.has(e.name)) {
      const one = e.input.file_path ?? e.input.notebook_path;
      const many = Array.isArray(e.input.files) ? e.input.files : typeof one === "string" ? [one] : [];
      calls.set(e.toolUseId, many.filter((p): p is string => typeof p === "string" && p.length > 0).map((p) => resolve(cwd, p)));
    } else if (e.type === "tool_result" && !e.isError) {
      done.push(...(calls.get(e.toolUseId) ?? []));
    }
  }
  return done;
}

/** 卡的工作树里 git 看得到的：开工（base）以来已经提交的，加上没提交的改动（含新文件，一个个列）。返回绝对路径。 */
async function gitFiles(cwd: string, base: string): Promise<string[]> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]).then((s) => s.trim(), () => null);
  if (!top) return [];
  // -z：路径原样、用 NUL 隔开（带空格、引号的名字不转义）；改名、复制的那一条后面跟着原来的路径，跳过
  const fields = (await git(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"]).catch(() => "")).split("\0");
  const dirty: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.length < 4) continue;
    dirty.push(f.slice(3));
    if (/[RC]/.test(f.slice(0, 2))) i += 1;
  }
  const committed = await git(cwd, ["diff", "--name-only", "-z", base, "HEAD"]).then((o) => o.split("\0").filter(Boolean), () => []);
  return [...committed, ...dirty].map((p) => resolve(top, p));
}

/**
 * 本会话写过、改过的文件。只列会话根里面的；按路径排，最多 500 个。base 是卡开工时的提交（在工作树里做的才有）：
 * 工作树是这张卡自己的，工具调用和 git 两路取并集；在本人文件夹里直接做的只认工具调用（11/10 用户：宁可漏掉用命令改的，也不把本人自己没提交的改动算成这个会话改的）。
 * 项目另外绑的文件夹（extras）是本人自己的文件夹，同样只认工具调用，path 给绝对路径。
 */
export async function listSessionFiles(root: string, cwd: string, base: string | null, events: TLocalSessionEvent[], extras: string[] = []): Promise<TLocalSessionFilesResponse> {
  const found = new Map<string, { abs: string; path: string; sources: Set<"tool" | "git"> }>();
  const add = (abs: string, source: "tool" | "git") => {
    const rel = relative(root, abs);
    const inRoot = Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
    // 会话根外面的：只列工具动过的、在项目另外绑的文件夹里的
    if (!inRoot && !(source === "tool" && extras.some((x) => abs !== resolve(x) && within(x, abs) && isInside(x, abs)))) return;
    const path = inRoot ? posix(rel) : posix(abs);
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    const entry = found.get(key) ?? { abs: inRoot ? join(root, rel) : abs, path, sources: new Set() };
    entry.sources.add(source);
    found.set(key, entry);
  };
  for (const p of toolFiles(events, cwd)) add(p, "tool");
  for (const p of base && existsSync(cwd) ? await gitFiles(cwd, base) : []) add(p, "git");
  const all = [...found.values()].map((f): TLocalChangedFile => {
    const st = existsSync(f.abs) ? statSync(f.abs) : null;
    return { path: f.path, absolutePath: f.abs, sources: (["tool", "git"] as const).filter((s) => f.sources.has(s)), exists: Boolean(st?.isFile()), size: st?.isFile() ? st.size : null };
  }).sort((a, b) => a.path.localeCompare(b.path));
  return { root, files: all.slice(0, MAX_FILES), truncated: all.length > MAX_FILES };
}
