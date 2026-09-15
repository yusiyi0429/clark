/**
 * 「这段话引到了哪几个编号」——**对谈层只有这一处答得出**。
 *
 * ## 为什么这一层和报告层必须认同一种形状
 *
 * 编号是报告层产出的（`a4/blocks/registry.ts:196` 那句注释是这个格式的出处：
 * `[E3]`、`[E3, E7]`、`[E3][E7]` 三种都要认出来），而报告正文原样进对谈前缀
 * （`buildAdvisorContext` → 报告正文 → `TALK_SYSTEM` 那一路）。模型照着上下文里的
 * 样子写多编号引用，是它最自然的行为。
 *
 * 所以两层认的形状必须同源：**报告层产出什么形状，对谈层就得认什么形状**。漂了一档的
 * 后果不是渲染难看，是机检静默失效 —— 对谈这一侧唯一活着的那道反谄媚机检
 * （`verifier.ts` 的 `findDesync` 判据 1「编号是编的」）会对 `[E9, E10]` 这种写法
 * 一声不吭地放行，于是一条编造的引用可以一路走到判断板上等他按确认。
 *
 * 这一层三个调用方（`verifier.ts` / `settle.ts` / `audit.ts`）从前各写各的字面正则，
 * 而且三份都只认单编号。**现在一个字面正则都不许再留**：要加一个调用方就 import 这里。
 *
 * 与 `registry.ts` / `gate.ts` 那一对的关系：那两处是渲染层与浏览器包的取舍（注释写在
 * `registry.ts:196`），本文件不并进去 —— 但**口径跟着那句注释走**，那边放宽了这边就得跟。
 */

/**
 * 行内引用的形状。与 `a4/blocks/registry.ts:202` 的 `INLINE_CITE` 同形。
 *
 * 每次用都现造一个（`new RegExp`）：带 `g` 的正则身上挂着 `lastIndex`，做成模块级常量
 * 共享的话，两次调用之间会互相把游标推着走 —— 症状是同一段文字第二次抠出来少几条。
 */
const CITE = String.raw`\[E\d+(?:\s*[,，]\s*E?\d+)*\]`;
/** 一段方括号里的每一个编号。`[E3, E7]` 要拆成两个。与 `registry.ts:203` 同形。 */
const ONE = String.raw`E?(\d+)`;

/**
 * 这段话引到的编号，去重、按出现顺序。
 *
 * 去重是有意的：同一条日志里把 `[E9]` 写两遍，是同一次引用说了两遍，不是两次引用。
 * 而 `[E9, E10]` 这种一次引两个的写法要拆成两条 —— 编造的编号各出一条账，正是要的。
 */
export function citedIds(text: string): string[] {
  const out: string[] = [];
  for (const m of (text ?? "").matchAll(new RegExp(CITE, "g"))) {
    for (const one of m[0].matchAll(new RegExp(ONE, "g"))) {
      const id = `E${one[1]}`;
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

/**
 * 第一处引用在这段话里的位置，没有引用时是 `-1`。
 *
 * 只有一个调用方：`settle.ts` 要在第一个编号周围截一段原文当触发物。它不自己再 `indexOf`
 * 一遍 —— 那样「认哪种形状」这件事又会有第二个答案（`[E1, E2]` 整段的起点，与 `[E1]`
 * 这个子串的起点，差着一个方括号）。
 */
export function firstCiteAt(text: string): number {
  const m = new RegExp(CITE).exec(text ?? "");
  return m ? m.index : -1;
}

/** 一组编号写回引用的样子。日志里的触发物照这个拼，别在调用方各拼各的。 */
export const citeText = (ids: readonly string[]): string => ids.map((id) => `[${id}]`).join("、");

/**
 * 一段话里引到的**图谱短码**（`01-J2` / `ISS-D6` / `DOC-05` 这一类）。
 *
 * 与上面 `citedIds` 是两个号段，不能合成一个函数：`E{n}` 是这份报告的台账号，短码是图里的
 * 对象号，两者的白名单来源完全不同（一个是 `doc.ledger`，一个是这一轮真载入过的那些）。
 *
 * ## 形状判据与 `looksLikeCode` 是同一条
 *
 * 由连接符分段、无空格。写死一张前缀表的代价是图里新增一类对象时这里静默漏检 —— 而漏检
 * 的表现是「一切正常」。**这里宁可多抠出几个再由白名单裁**：抠多了顶多多比对几次，抠漏了
 * 是一个编造的编号一路走到屏幕上。
 *
 * 排除 `E{n}`：那是另一个号段，由 `citedIds` 管。
 */
const SHORT_CODE = String.raw`\b[A-Za-z0-9]+(?:[-][A-Za-z0-9]+)+\b`;

export function citedCodes(text: string): string[] {
  const out: string[] = [];
  for (const m of (text ?? "").matchAll(new RegExp(SHORT_CODE, "g"))) {
    const code = m[0];
    if (/^E\d+$/.test(code)) continue;
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * 引了但这一轮没载入过的那几个短码。
 *
 * **大小写不敏感地比**：模型把 `iss-d6` 写成 `ISS-D6` 是同一条，报出来只会让人去查一个
 * 不存在的问题。
 *
 * 空的 `loaded` 时**一律不报**：那是「这一轮压根没带公司上下文」（图挂了、或者纯外部），
 * 此时每一个短码都会被判成编的，而那不是模型的错 —— 一份全是误报的清单等于没有清单。
 */
export function unknownCodes(text: string, loaded: Iterable<string>): string[] {
  const known = new Set([...loaded].map((c) => c.toLowerCase()));
  if (!known.size) return [];
  return citedCodes(text).filter((c) => !known.has(c.toLowerCase()));
}
