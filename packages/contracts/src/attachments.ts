import { Type, type Static } from "@sinclair/typebox";

const strict = { additionalProperties: false } as const;

/**
 * 输入框附件（新首页设计 14.5）：首页、总管线、Task 管线、子会话四处一样。每个不超过 30 MB，一条最多 20 个。
 * 只认扩展名（网页先挡，云端再挡一次）；加不上的网页在框里写「文件名：格式不支持」「超过 30 MB」「最多 20 个」。
 * 送到哪：
 * - 总管线（scope global）、Task 管线（scope plan-task:<id>）：照旧 POST /api/conversations/:scope/attachments，云端转给 Chat（图片当图片、文档抽文字），
 *   回执的 id 随消息的 attachments 发出去。
 * - 子会话（卡、专题）：POST /api/me/sub-sessions/:kind/:id/attachments 存在云端；网页给本机程序说那一句时带上附件的 id（LocalSendMessageRequest.attachments），
 *   本机按 id 从 GET /api/local-runner/attachments/:id 取回，存进这件 Task 的工作区，路径交给 Claude Code。
 */
export const ATTACHMENT_MAX_BYTES = 30 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 20;
/** 认的扩展名（小写、不带点）。代码和日志按常见扩展名认。 */
export const ATTACHMENT_EXTENSIONS = {
  image: ["png", "jpg", "jpeg", "gif", "webp"],
  document: ["pdf", "docx", "xlsx", "pptx", "csv", "txt", "md", "markdown", "json", "html", "htm", "xml", "yaml", "yml"],
  code: ["log", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "rb", "php", "sh", "bash",
    "ps1", "sql", "css", "scss", "less", "vue", "svelte", "toml", "ini", "cfg", "conf", "diff", "patch", "proto", "graphql", "dockerfile", "makefile"],
} as const;
export const AttachmentKind = Type.Union([Type.Literal("image"), Type.Literal("document"), Type.Literal("code")]);
export type TAttachmentKind = Static<typeof AttachmentKind>;

/** 按文件名认是哪一类，认不得为 null（没有扩展名的 Dockerfile、Makefile 按整个名字认）。 */
export function attachmentKind(fileName: string): TAttachmentKind | null {
  const name = fileName.trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : name;
  for (const kind of ["image", "document", "code"] as const) if ((ATTACHMENT_EXTENSIONS[kind] as readonly string[]).includes(extension)) return kind;
  return null;
}

/**
 * 子会话的一份附件（存在云端）。subject 是哪个子会话；sha256 给本机取回后核对。
 * 谁能读：本人（GET /api/me/session-attachments/:id，气泡里的缩略图、下载）和本人配对的电脑（GET /api/local-runner/attachments/:id）。
 */
export const SessionAttachment = Type.Object({
  id: Type.String({ format: "uuid" }),
  subject: Type.Object({ kind: Type.Union([Type.Literal("card"), Type.Literal("topic")]), id: Type.String({ format: "uuid" }) }, strict),
  fileName: Type.String({ minLength: 1, maxLength: 255 }),
  mimeType: Type.String({ maxLength: 200 }),
  size: Type.Integer({ minimum: 1, maximum: ATTACHMENT_MAX_BYTES }),
  sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  kind: AttachmentKind,
  createdAt: Type.String({ format: "date-time" }),
}, strict);
export const SessionAttachmentUploadResponse = Type.Object({ attachments: Type.Array(SessionAttachment) }, strict);

export type TSessionAttachment = Static<typeof SessionAttachment>;
export type TSessionAttachmentUploadResponse = Static<typeof SessionAttachmentUploadResponse>;
