/**
 * 子会话停了的报告（契约 LocalStopReport，新首页设计 18.10）用到的一两句话：都从会话里现成的内容截，不另调模型。
 */

const MAX = 200;
const END = /[。！？!?；;]$/;

/**
 * 一段话的头一两句：去掉代码块、标题行、列表和强调记号、链接只留字；每行没标点结尾的补一个「；」再按句切，取前两句，200 字以内。
 * 没有字为 null。
 */
export function firstSentences(text: string | null | undefined): string | null {
  if (!text) return null;
  const lines = text.replace(/```[\s\S]*?(```|$)/g, "\n").split(/\r?\n/)
    .filter((l) => !/^\s{0,3}#{1,6}\s/.test(l) && !/^\s*\|/.test(l) && !/^\s*([-*_]\s*){3,}$/.test(l))
    .map((l) => l
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s*(>\s*)*([-*+]|\d+[.)、])\s+/, "")
      .replace(/(\*\*|__|`|~~)/g, "")
      .replace(/\s+/g, " ")
      .trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const joined = lines.map((l, i) => (i === lines.length - 1 || END.test(l) ? l : /\.$/.test(l) ? `${l} ` : `${l}；`)).join("");
  // 中文标点后面断；英文句号后面要有空格才断（版本号、文件名里的点不断）
  const sentences = joined.split(/(?<=[。！？!?；;])|(?<=\.)\s+/).map((s) => s.trim()).filter(Boolean);
  let out = "";
  for (const s of sentences.slice(0, 2)) out += out && !END.test(out) ? ` ${s}` : s;
  out = out.replace(/[；;]$/, "。");
  return out.length > MAX ? `${out.slice(0, MAX - 1)}…` : out;
}

/** 执行方一轮出错停住时，没有现成的话可截，按出错的种类写一句。 */
export const TURN_ERROR: Record<string, string> = {
  auth: "Claude Code 的登录失效了，要重新登录",
  api: "模型接口出错了",
  other: "执行方报错停下了",
};
