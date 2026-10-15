import { splitMaterialBlocks } from "./materialDiff.js";
import { htmlToText } from "./meetingEvidence.js";

/**
 * 群材料某一版的正文段落，编号与预审证据完全一致（meetingEvidence 的 `[p<n>]` 标记，n 从 1 起）：
 * HTML 先转成可读文字、按空行切；Markdown / PDF / Word 的提取文字按原生 splitMaterialBlocks 切。
 * 这样 `material:<id>@v<n>#p<k>` 的第 k 段在页面里打开时就是预审当时读到的那一段。链接没有正文。
 */
export function materialParagraphs(body: string, format: string): string[] {
  if (format === "link") return [];
  const plain = format === "html" ? htmlToText(body) : body.trim();
  if (!plain) return [];
  return (format === "html" ? plain.split(/\n{2,}/) : splitMaterialBlocks(plain)).map((block) => block.trim()).filter(Boolean);
}
