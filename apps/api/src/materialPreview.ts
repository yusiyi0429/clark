import mammoth from "mammoth";
import sanitizeHtml from "sanitize-html";
import type { ParsedMaterial } from "./materialParser.js";

export type MaterialPreview = { contentType: string; body: Buffer };

// 领域文档 04：仅允许段落、标题、列表、强调、表格与受限 https 链接；
// style、事件属性、图片与 javascript:/data:/file: 协议一律删除。
const DOCX_HTML_ALLOWLIST = {
  allowedTags: ["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "strong", "em", "br", "blockquote", "table", "thead", "tbody", "tr", "th", "td", "a"],
  allowedAttributes: { a: ["href"] },
  allowedSchemes: ["https"],
  disallowedTagsMode: "discard",
} satisfies sanitizeHtml.IOptions;

/** 按需生成预览体，不持久化：PDF/Markdown 原样字节，DOCX 经 mammoth + allowlist sanitizer。 */
export async function renderMaterialPreview(buffer: Buffer, mimeType: ParsedMaterial["mimeType"]): Promise<MaterialPreview> {
  if (mimeType === "application/pdf") return { contentType: "application/pdf", body: buffer };
  if (mimeType === "text/markdown") return { contentType: "text/plain; charset=utf-8", body: buffer };
  const { value } = await mammoth.convertToHtml({ buffer });
  return { contentType: "text/html; charset=utf-8", body: Buffer.from(sanitizeHtml(value, DOCX_HTML_ALLOWLIST)) };
}
