/**
 * 输入框附件（新首页设计 14.5，契约 attachments.ts）：认哪些文件、加不上时怎么写、往哪传。
 * 网页不在运行时打包契约包：清单和上限照抄一份，类型标成契约里那份——契约改了，类型检查就过不去。
 */
import type { TLocalAttachmentRef, TSessionAttachment, TSessionAttachmentUploadResponse } from "@warmap/contracts";
import type { Attachment } from "@/conversation/useConversation";

type Contracts = typeof import("@warmap/contracts");

export const ATTACHMENT_MAX_BYTES: Contracts["ATTACHMENT_MAX_BYTES"] = 30 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT: Contracts["ATTACHMENT_MAX_COUNT"] = 20;
const EXTENSIONS: Contracts["ATTACHMENT_EXTENSIONS"] = {
  image: ["png", "jpg", "jpeg", "gif", "webp"],
  document: ["pdf", "docx", "xlsx", "pptx", "csv", "txt", "md", "markdown", "json", "html", "htm", "xml", "yaml", "yml"],
  code: ["log", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "rb", "php", "sh", "bash",
    "ps1", "sql", "css", "scss", "less", "vue", "svelte", "toml", "ini", "cfg", "conf", "diff", "patch", "proto", "graphql", "dockerfile", "makefile"],
};
export type AttachmentKind = keyof typeof EXTENSIONS;

/** 文件选择框的 accept：图片按类型，别的按扩展名。 */
export const ATTACHMENT_ACCEPT = ["image/png", "image/jpeg", "image/gif", "image/webp", ...[...EXTENSIONS.document, ...EXTENSIONS.code].map((ext) => `.${ext}`)].join(",");

/** 按文件名认是哪一类，认不得为 null（没有扩展名的 Dockerfile、Makefile 按整个名字认）。和契约的 attachmentKind 一样。 */
export function attachmentKind(fileName: string): AttachmentKind | null {
  const name = fileName.trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : name;
  for (const kind of ["image", "document", "code"] as const) if ((EXTENSIONS[kind] as readonly string[]).includes(extension)) return kind;
  return null;
}

/** 粘贴的截图没有名字：给一个「粘贴的图片.png」。 */
export const fileNameOf = (file: File) => file.name || `粘贴的图片.${file.type.split("/")[1] || "png"}`;

/**
 * 往已有的几个里加：认得、不超过 30 MB、加上后不超过 20 个的收下；加不上的写成一句（一个：「文件名：原因」，几个：「N 个没加上：第一个的原因」）。
 */
export function admit(current: number, files: File[]): { ok: File[]; error: string | null } {
  const ok: File[] = [];
  const bad: [string, string][] = [];
  for (const file of files) {
    const name = fileNameOf(file);
    if (!attachmentKind(name) && !/^image\/(png|jpeg|gif|webp)$/.test(file.type)) bad.push([name, "格式不支持"]);
    else if (file.size > ATTACHMENT_MAX_BYTES) bad.push([name, "超过 30 MB"]);
    else if (current + ok.length >= ATTACHMENT_MAX_COUNT) bad.push([name, "最多 20 个"]);
    else ok.push(file);
  }
  const error = !bad.length ? null : bad.length === 1 ? `${bad[0]![0]}：${bad[0]![1]}` : `${bad.length} 个没加上：${bad[0]![1]}`;
  return { ok, error };
}

/** 「12 KB」「3.4 MB」。 */
export const sizeText = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

const form = (files: File[]) => {
  const body = new FormData();
  for (const file of files) body.append("files", file, fileNameOf(file));
  return body;
};

async function post<T>(url: string, files: File[]): Promise<T> {
  const response = await fetch(url, { method: "POST", body: form(files) });
  if (response.status === 401) { window.location.assign("/access"); throw new Error("登录过期了"); }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? "附件没传上");
  }
  return (await response.json()) as T;
}

/** 总管线、Task 管线：传给这条对话（云端转给 Chat），回执随这句话发出去。 */
export async function uploadToConversation(scope: string, files: File[]): Promise<Attachment[]> {
  const body = await post<{ attachments?: Attachment[] } | Attachment[]>(`/api/conversations/${encodeURIComponent(scope)}/attachments`, files);
  return Array.isArray(body) ? body : body.attachments ?? [];
}

/** 子会话：存在云端，回给本机程序的引用（本机按 id 取回、核对 sha256）。 */
export async function uploadToSubSession(subject: TSessionAttachment["subject"], files: File[]): Promise<TLocalAttachmentRef[]> {
  const body = await post<TSessionAttachmentUploadResponse>(`/api/me/sub-sessions/${subject.kind}/${encodeURIComponent(subject.id)}/attachments`, files);
  return body.attachments.map(({ id, fileName, size, sha256 }) => ({ id, fileName, size, sha256 }));
}
