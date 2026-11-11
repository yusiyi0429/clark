// Word / Excel → 稳定的 Markdown 文字，给「这一轮改了哪几处」拿改前、改后两份去比。
// 纯函数式：只读文件，不执行宏、不解析外部引用、不联网；任何失败都回「转不了」，不抛异常。
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { docxToMarkdown } from "./docx.js";
import { DOC_TEXT_LIMITS, DocTextError, type DocTextFailReason } from "./limits.js";
import { ZipReader } from "./zip.js";

export { DOC_TEXT_LIMITS, type DocTextFailReason } from "./limits.js";

export type DocTextResult =
  | { ok: true; kind: "docx"; markdown: string }
  | { ok: false; reason: DocTextFailReason; message: string };

const WORD = new Set(["docx", "docm"]);
const LEGACY = new Set(["doc", "xls", "wps", "et"]);

/** 交给这个模块的扩展名（不带点，小写）：能转的，加上要明说「不支持」的老格式。 */
export const DOC_TEXT_EXTENSIONS: readonly string[] = [...WORD, ...LEGACY];

/**
 * 把一个 Word 文件转成文字。
 * @param source 文件路径，或文件的字节
 * @param ext 扩展名（带不带点都行，不分大小写）；给路径时可以不给，按路径取
 */
export function docToText(source: string | Uint8Array, ext?: string): DocTextResult {
  const kind = (ext ?? (typeof source === "string" ? extname(source) : "")).replace(/^\./, "").toLowerCase();
  if (!WORD.has(kind)) return fail("unsupported_format", `转不了：不支持的格式（${kind ? "." + kind : "没有扩展名"}）`);
  try {
    let buf: Buffer;
    if (typeof source === "string") {
      let size: number;
      try {
        size = statSync(source).size;
      } catch {
        return fail("unreadable", "转不了：读不到这个文件");
      }
      if (size > DOC_TEXT_LIMITS.maxFileBytes) return fail("too_large", "转不了：文件太大");
      buf = readFileSync(source);
    } else {
      if (source.byteLength > DOC_TEXT_LIMITS.maxFileBytes) return fail("too_large", "转不了：文件太大");
      buf = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    }
    const markdown = docxToMarkdown(new ZipReader(buf));
    if (Buffer.byteLength(markdown) > DOC_TEXT_LIMITS.maxOutputBytes) return fail("output_too_large", "转不了：转出来的文字超过 1MB");
    return { ok: true, kind: "docx", markdown };
  } catch (err) {
    if (err instanceof DocTextError) return fail(err.reason, err.message);
    return fail("corrupt", "转不了：文件坏了，或者不是 Word / Excel 文件");
  }
}

function fail(reason: DocTextFailReason, message: string): DocTextResult {
  return { ok: false, reason, message };
}
