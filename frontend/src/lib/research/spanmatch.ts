/**
 * 引句对归档原文的确定性定位。**不调模型。**
 *
 * 入账时（`ledger.record`）调它：引句在原文里定位不到就拒绝入账 —— 编造引文死在
 * 入口，不是死在终稿校验。这是几道校验里性价比最高的一道：确定性、零成本，却能抓住
 * 「引用了一个真实存在的页面，但那页里根本没有这个数字」这一整类错误。而这一类正是
 * 「有来源」和「来源撑得起这句话」之间的全部差别。
 *
 * 做法：把原文和引句做同一种软归一化 —— 空白与常见中英标点折叠掉、字母折小写 ——
 * 在归一化空间里找子串，再把命中区间映射回原文坐标。映射靠归一化时同步记录的
 * 「归一化位 → 原文位」表。
 *
 * **宽容的只有排版。** 模型抄引句最常见的漂移是全半角标点、空格、书名号这几类，那些
 * 不该判成两句话。数字一个都不折 —— 「约 2 个月」和「约 3 个月」必须判成两句话，
 * 而那正是这一层存在的理由。折了数字，这道闸就只剩「这段话大概在那页上」，而报告里
 * 唯一会被人当场纠正的东西就是数字。
 */

/**
 * 折叠掉的字符。**只有零歧义的排版符号。** 汉字、数字、字母原样（字母折小写，
 * 因为引句里 AI 与 ai 不该算两句话）。
 */
const DROP = new Set(
  " \t\r\n　，,。.、；;：:！!？?「」『』“”\"'‘’（）()[]【】《》<>-—–·…*".split("")
);

type Normalized = { text: string; pos: number[] };

function norm(text: string): Normalized {
  const out: string[] = [];
  const pos: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (DROP.has(ch)) continue;
    out.push(ch.toLowerCase());
    pos.push(i);
  }
  return { text: out.join(""), pos };
}

/** `quote` 在 `text` 里的原文字符区间 `[start, end)`；定位不到返回 `null`。 */
export function locate(quote: string, text: string): [number, number] | null {
  const q = norm(quote ?? "");
  if (!q.text) return null;
  const t = norm(text ?? "");
  const at = t.text.indexOf(q.text);
  if (at < 0) return null;
  return [t.pos[at], t.pos[at + q.text.length - 1] + 1];
}

/** 定位得到就返回原文里那一段（不是模型抄的那一段）。给出口闸对账用。 */
export function excerpt(quote: string, text: string): string {
  const span = locate(quote, text);
  return span ? text.slice(span[0], span[1]) : "";
}
