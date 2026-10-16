/**
 * PDF 文字层 → 分段正文（上传解析子进程与测试共用，纯函数、无依赖）。
 *
 * pdfjs 的 getTextContent 给的是一串文字块：块之间的空格是 PDF 里本来就有的空格块，换行由 hasEOL 标出，
 * 位置在 transform[5]（纵坐标，越往下越小）。以前把所有块用空格连成一行、页与页之间只隔一个换行，
 * 结果是中文字之间多出空格，整份 PDF 只有一段，预审的段落锚点 #p<n> 只能落在第 1 段。
 *
 * 现在的规则：
 * - 块按原样拼接，不再额外插空格；遇到 hasEOL 断行；
 * - 上一行没写到本页右边界（段末、标题、表格行），或相邻两行行距明显宽于本页常见行距，或下一行以项目符号开头，
 *   或纵坐标往回跳（页眉页脚、分栏），另起一段；
 * - 同一段里的折行接回去：两边都是中文就直接相连，否则补一个空格；
 * - 页与页之间空一行（每页至少一段）。
 */

/**
 * 两行算作同一段的上限：行距既不超过字高的 PARAGRAPH_GAP_RATIO 倍，也不超过本页常见行距的 TYPICAL_GAP_RATIO 倍。
 * 正文折行通常是字高的 1.4–2 倍、且就是本页最常见的行距；段落、标题之间明显更宽。
 */
export const PARAGRAPH_GAP_RATIO = 1.3;
export const TYPICAL_GAP_RATIO = 1.15;
/** 一行离本页右边界超过这么多个字宽（按字高估）就算没写满：这一行是段末。 */
export const SHORT_LINE_CHARS = 2;

/** 中日韩文字与全角标点（U+2E80–U+9FFF、U+F900–U+FAFF、U+3000–U+303F、U+FF00–U+FFEF）。 */
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;
const BULLET = /^[•·▪■◆●○◦\-–—]\s*|^\d{1,2}[.、)）]\s*/;

/**
 * @param {{ str?: string; hasEOL?: boolean; transform?: number[]; width?: number; height?: number }[]} items
 * @returns {string[]} 这一页的段落
 */
export function pdfPageParagraphs(items) {
  /** @typedef {{ text: string; y: number | null; right: number; height: number }} Line */
  /** @type {Line[]} */
  const lines = [];
  /** @type {Line} */
  let current = { text: "", y: null, right: 0, height: 0 };
  const endLine = () => {
    const text = current.text.replace(/\s+/g, " ").trim();
    if (text) lines.push({ ...current, text });
    current = { text: "", y: null, right: 0, height: 0 };
  };
  for (const item of items) {
    const str = typeof item.str === "string" ? item.str : "";
    if (str) {
      const visible = Boolean(str.trim());
      const x = Array.isArray(item.transform) ? item.transform[4] : null;
      if (visible && current.y === null && Array.isArray(item.transform)) current.y = item.transform[5];
      if (visible) current.height = Math.max(current.height, Number(item.height) || 0);
      if (visible && x !== null) current.right = Math.max(current.right, x + (Number(item.width) || 0));
      current.text += str;
    }
    if (item.hasEOL) endLine();
  }
  endLine();

  // 本页常见行距（中位数）与右边界：不同排版的折行行距差别很大（1.4–2 倍字高），按本页自己的排版判断。
  const gaps = [];
  for (let index = 1; index < lines.length; index += 1) {
    const [a, b] = [lines[index - 1], lines[index]];
    if (a.y !== null && b.y !== null && a.y - b.y > 0) gaps.push(a.y - b.y);
  }
  gaps.sort((x, y) => x - y);
  const typicalGap = gaps.length ? gaps[Math.floor((gaps.length - 1) / 2)] : 0;
  const pageRight = Math.max(0, ...lines.map((line) => line.right));

  const paragraphs = [];
  let paragraph = "";
  /** @type {Line | null} */
  let previous = null;
  for (const line of lines) {
    let breakHere = !previous || BULLET.test(line.text);
    if (!breakHere && previous) {
      const height = Math.max(previous.height, line.height) || 1;
      // 上一行没写到右边界（差两个字以上）就是这一段的末行：段末、标题、表格行。
      const shortLine = previous.right > 0 && pageRight - previous.right > height * SHORT_LINE_CHARS;
      if (shortLine) breakHere = true;
      else if (previous.y !== null && line.y !== null) {
        const gap = previous.y - line.y;
        breakHere = gap <= 0 || gap > Math.max(height * PARAGRAPH_GAP_RATIO, typicalGap * TYPICAL_GAP_RATIO);
      }
    }
    if (breakHere) {
      if (paragraph) paragraphs.push(paragraph);
      paragraph = line.text;
    } else {
      const glue = CJK.test(paragraph.slice(-1)) && CJK.test(line.text[0]) ? "" : " ";
      paragraph += glue + line.text;
    }
    previous = line;
  }
  if (paragraph) paragraphs.push(paragraph);
  return paragraphs;
}

/** 整份 PDF 的正文：段落之间空一行，页与页之间也空一行。 */
export function pdfText(pages) {
  return pages.map((items) => pdfPageParagraphs(items).join("\n\n")).filter(Boolean).join("\n\n");
}
