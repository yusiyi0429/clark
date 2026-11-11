// 把正文里的字安全地放进 Markdown：会被当成格式的符号加反斜杠，行首像标题、列表、引用的也加。

const INLINE = /[\\`*_[\]<>]/g;
const BLOCK_START = /^(#{1,6}(\s|$)|[-+](\s|$)|-{3,}\s*$|={3,}\s*$)/;
const ORDERED_START = /^(\d{1,9})([.)])(?=\s|$)/;

/** 一段正文：每行去掉首尾空白，空行去掉。 */
export function paragraphMd(text: string): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const e = l.replace(INLINE, "\\$&");
      return BLOCK_START.test(e) ? `\\${e}` : e.replace(ORDERED_START, "$1\\$2");
    })
    .join("\n");
}

/** 表格里的一格：竖线转义，换行写成 <br>。 */
export function cellMd(text: string): string {
  return text
    .split("\n")
    .map((l) => l.trim().replace(INLINE, "\\$&").replace(/\|/g, "\\|"))
    .filter(Boolean)
    .join("<br>");
}

export function tableMd(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}
