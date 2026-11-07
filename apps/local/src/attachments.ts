import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { TLocalAttachmentRef, TLocalSavedAttachment } from "@warmap/contracts";

/** 附件存在工作区的这个目录里（新首页设计 14.5）；目录里放一个只写 * 的 .gitignore，卡交回提交时不会带上。 */
export const ATTACHMENT_DIR = ".tianshu-attachments";
export const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;

/** 14.5 的格式：图片；文档；代码和日志。按扩展名认。 */
const IMAGES = ["png", "jpg", "jpeg", "gif", "webp"];
const DOCS = ["pdf", "docx", "xlsx", "pptx", "csv", "txt", "md", "markdown", "json", "html", "htm", "xml", "yaml", "yml"];
const CODE = [
  "log", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "java", "go", "rs", "c", "h", "cc", "cpp", "hpp", "cs", "rb", "php", "swift", "kt", "kts", "scala",
  "sh", "bash", "zsh", "ps1", "bat", "cmd", "sql", "css", "scss", "less", "vue", "svelte", "toml", "ini", "cfg", "conf", "diff", "patch", "proto", "graphql", "lua", "r", "dart",
];
const ALLOWED = new Set([...IMAGES, ...DOCS, ...CODE]);
const extOf = (name: string) => extname(name).slice(1).toLowerCase();
export const isImage = (name: string) => IMAGES.includes(extOf(name));

/** 格式支不支持（不支持时回给人看的原因）。 */
export function formatProblem(name: string): string | null {
  return ALLOWED.has(extOf(name)) ? null : `${name}：格式不支持`;
}

/** 存盘用的文件名：去掉路径和 Windows 不许的字符，太长的截短（保留扩展名）。 */
export function safeName(name: string): string {
  const raw = basename(name.replace(/\\/g, "/")).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "_").trim() || "附件";
  const ext = extname(raw);
  return raw.length <= 120 ? raw : `${raw.slice(0, 120 - ext.length)}${ext}`;
}

export class AttachmentError extends Error {
  constructor(readonly kind: "validation" | "conflict", message: string) { super(message); }
}

export type FetchAttachment = (id: string) => Promise<{ bytes: Buffer; mimeType: string | null } | { tooLarge: true }>;

/**
 * 取回一句话的附件，存进 <工作区>/.tianshu-attachments/<编号>/。先看格式和大小，再一个个取、核对 sha256；有一个不行整句不存（已存的删掉）。
 * 回存好的附件（路径是绝对路径，执行方用 Read 打开）。
 */
export async function saveAttachments(root: string, refs: TLocalAttachmentRef[], fetchOne: FetchAttachment | undefined, now = Date.now()): Promise<TLocalSavedAttachment[]> {
  for (const r of refs) {
    const bad = formatProblem(r.fileName);
    if (bad) throw new AttachmentError("validation", bad);
    if (r.size > MAX_ATTACHMENT_BYTES) throw new AttachmentError("validation", `${r.fileName}：超过 30 MB`);
  }
  if (!fetchOne) throw new AttachmentError("conflict", `${refs[0]!.fileName}：没连天枢，取不到附件`);
  const base = join(root, ATTACHMENT_DIR);
  mkdirSync(base, { recursive: true });
  if (!existsSync(join(base, ".gitignore"))) writeFileSync(join(base, ".gitignore"), "*\n");
  let dir = join(base, String(now));
  for (let n = 2; existsSync(dir); n++) dir = join(base, `${now}-${n}`);
  mkdirSync(dir);
  const saved: TLocalSavedAttachment[] = [];
  try {
    for (const r of refs) {
      let got: Awaited<ReturnType<FetchAttachment>>;
      try { got = await fetchOne(r.id); } catch (e) {
        throw new AttachmentError("conflict", `${r.fileName}：取不到（${e instanceof Error ? e.message : String(e)}）`);
      }
      if ("tooLarge" in got || got.bytes.length > MAX_ATTACHMENT_BYTES) throw new AttachmentError("validation", `${r.fileName}：超过 30 MB`);
      // 内容要和天枢记的一样（传坏了、被换了都不交给执行方）
      if (createHash("sha256").update(got.bytes).digest("hex") !== r.sha256) throw new AttachmentError("conflict", `${r.fileName}：内容和天枢上的对不上（sha256 不一致），没有交给执行方`);
      // 同一句里重名的：后面的加「(2)」
      let file = safeName(r.fileName);
      const ext = extname(file);
      for (let n = 2; saved.some((s) => basename(s.path) === file); n++) file = `${file.slice(0, file.length - ext.length)}(${n})${ext}`;
      const path = join(dir, file);
      writeFileSync(path, got.bytes);
      saved.push({ name: r.fileName, path, size: got.bytes.length });
    }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return saved;
}

/** 拼进给执行方的那句话：附件在哪、怎么看。 */
export function attachmentNote(saved: TLocalSavedAttachment[]): string {
  const lines = saved.map((s) => `- ${s.name}${isImage(s.name) ? "（图片）" : ""}：${s.path}`);
  return `本人随这句话发来 ${saved.length} 个附件，已存到工作区，用 Read 打开（图片、PDF 能直接看）：\n${lines.join("\n")}`;
}
