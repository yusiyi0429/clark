import type { PluggableList } from "unified";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { REMARK_PLUGINS } from "@/lib/markdown";

/**
 * 对话正文专用的 Markdown 插件：在全站共用的 REMARK_PLUGINS 之后加 remark-math，rehype 一侧加 rehype-katex。
 * 只给对话用：材料、任务卡、议题正文里的「$」照旧是普通字符，不会被当成公式。
 * KaTeX：中文（含 \text{…} 里、以及直接写在公式里的汉字）不告警（strict:"ignore"）；公式写错不抛错，
 * 错误样式改成正文色（rich-blocks.module.css），看上去就是原文，不出红字。
 */
export const CONVERSATION_REMARK_PLUGINS: PluggableList = [...REMARK_PLUGINS, remarkMath];

export const KATEX_OPTIONS = { strict: "ignore", throwOnError: false, errorColor: "inherit", output: "htmlAndMathml" } as const;

export const CONVERSATION_REHYPE_PLUGINS: PluggableList = [[rehypeKatex, KATEX_OPTIONS]];

const DISPLAY = /\$\$/g;

/**
 * 流式中还在长的最后一块：没收全的公式先不进 Markdown（不露出半截 LaTeX、不让 KaTeX 画半个式子）。
 * - 块级 `$$` 出现奇数次：从最后一个 `$$` 起拿掉，`pending` 为真（界面在原处画「公式 · 正在生成…」骨架）；
 * - 最后一段里行内 `$` 没配对：从那个 `$` 起拿掉，这一段等式子收全再一起出来。
 * 只在 open 块上用；收全或流式结束后整段照常解析。
 */
export function holdOpenMath(text: string): { text: string; pending: boolean } {
  const display = [...text.matchAll(DISPLAY)];
  if (display.length % 2 === 1) {
    const at = display.at(-1)!.index!;
    return { text: text.slice(0, at).trimEnd(), pending: true };
  }
  const paragraphStart = text.lastIndexOf("\n\n") + 1;
  const tail = text.slice(paragraphStart).replace(DISPLAY, "  ");
  const singles: number[] = [];
  for (let index = 0; index < tail.length; index++) {
    if (tail[index] === "$" && tail[index - 1] !== "\\") singles.push(index);
  }
  if (singles.length % 2 === 1) return { text: text.slice(0, paragraphStart + singles.at(-1)!).trimEnd(), pending: false };
  return { text, pending: false };
}
