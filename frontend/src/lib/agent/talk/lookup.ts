/**
 * 议事对话层的证据查找：按编号或语义取回证据的原文引句与口径。
 *
 * 语义查这一版是字面包含 + 按命中长度排序（长度相同保持台账原序）—— 一份报告的台账是
 * 几十条那一档的量，字面命中够用；而上向量检索会引入「没命中」这种没法向他解释的失败
 * （同理由见 `buildAdvisorContext` —— 「不建索引，索引会引入『检索没命中』这种没法解释的失败」，
 * `src/lib/data/store.ts:6747`）。
 */

import type { Evidence } from "@/lib/research/ledger";
import type { BlockEvidence } from "@/lib/agent/a4/blocks/schema";

export type Found = { id: string; claim: string; site: string; tier: string; quote?: string; measure?: string };

/**
 * 台账那份带原文引句、速查那份不带；同一个编号只留台账那条。
 *
 * 老报告（分层之前、或 TKOS_DR_V2=0 那条对照链）没有 `ledger`，那就只有速查那一份。
 * 正常的 v2 报告里两份编号是同一套（`buildRegistry` 把台账里有、清单里没列的也接在
 * 后面），所以并集实际多出来的只有对谈里现查到追加的那几条 —— 那正是要让他问得到的。
 *
 * **同一个编号绝不回两条。** 撞号时回两条的后果不是显示难看：他看到模型引 `[E1]`，
 * 而模型手上其实是两条不同的证据 —— 那时候「引的是哪一条」谁都说不清。
 */
export function mergeEntries(
  ledger: readonly Evidence[] | undefined,
  slim: readonly BlockEvidence[] | undefined,
): (Evidence | BlockEvidence)[] {
  const out: (Evidence | BlockEvidence)[] = [];
  const taken = new Set<string>();
  for (const e of ledger ?? []) {
    if (taken.has(e.id)) continue;
    taken.add(e.id);
    out.push(e);
  }
  for (const e of slim ?? []) {
    if (taken.has(e.id)) continue;
    taken.add(e.id);
    out.push(e);
  }
  return out;
}

/**
 * 一条证据 → 喂回模型的那个形状。**`Evidence` 变 `Found` 只有这一份映射。**
 *
 * 两个调用方：按编号 / 语义查回来的那一路（下面的 `lookupEvidence`），和轮内取证当场
 * 取回来的那一路（`turn.ts` 的 `micro_research`）。抄成两份的表现不是重复代码 ——
 * 上一版轮内取证那一支自己内联拼字符串，于是**整条「口径」行没了**：同一条证据，这一轮
 * 刚取回来时模型看不到它的口径，下一轮按编号查回来时才看得到。而口径正是这一层反复
 * 强调的东西（`TALK_SYSTEM` 第 7 条「他常挑口径就先把口径写清」）。
 *
 * 按字段在不在分，不按传进来的是哪一栏：`Evidence` 有原文引句与口径四件套，
 * `BlockEvidence` 只有编号、一句话、机构、等级 —— 缺的栏就让它缺，不编造。
 */
export function toFound(e: Evidence | BlockEvidence): Found {
  // 用一个 Record 视角访问属性，避免联合类型的类型收窄问题
  const rec = e as Record<string, unknown>;

  const found: Found = {
    id: e.id,
    claim: e.claim,
    site: (rec.siteName as string | undefined) ?? (rec.sourceDomain as string | undefined) ?? (rec.sourceName as string | undefined) ?? "",
    tier: (rec.sourceTier as string | undefined) ?? (rec.grade as string | undefined) ?? "",
  };

  // quote：只有 exactQuote 存在时才有
  if ("exactQuote" in e && typeof rec.exactQuote === "string") {
    found.quote = rec.exactQuote;
  }

  // measure：口径四件套至少有一样时才构造
  const value = rec.value;
  const unit = rec.unit;
  const precision = rec.precision;
  const period = rec.period;
  const geography = rec.geography;

  const hasMeasure = value !== undefined || unit !== undefined || precision !== undefined || period !== undefined || geography !== undefined;

  if (hasMeasure) {
    const parts: string[] = [];
    if (value !== undefined && unit !== undefined) {
      parts.push(`${value}${unit}`);
    }
    if (typeof precision === "string") parts.push(precision);
    if (typeof period === "string") parts.push(period);
    if (typeof geography === "string") parts.push(geography);
    found.measure = parts.join("，");
  }

  return found;
}

/**
 * 一条证据喂回模型的样子。缺原文引句就说清缺 —— 不许让 `claim` 冒充引句。
 *
 * **三条取证路共用这一份**：按编号 / 语义查回来的那一路（`turn.ts` 的
 * `evidence_lookup`）、轮内现取回来的那一路（`turn.ts` 的 `micro_research`），以及
 * 他按下「查一下」那一次的作答（`check.ts`）。各拼各的表现是同一条证据在不同轮里长得
 * 不一样 —— 上一版轮内取证那一支自己内联拼过一份，三处不一致，**整条「口径」行没了**，
 * 而口径正是这一层反复强调的东西（`TALK_SYSTEM` 第 7 条）。
 *
 * 住在 `lookup.ts` 而不是 `turn.ts`：`toFound` 在这里，而这两步是同一件事的两半 ——
 * 取字段、摆成字。放在 turn 上时 `check.ts` 要 import 一整个对谈轮才能拼一行字。
 */
export function describeFound(f: Found): string {
  const lines = [`${f.id}｜${f.claim}`, `来源：${f.site || "未标注"}（${f.tier || "未标注"} 档）`];
  lines.push(f.quote ? `原文：${f.quote}` : "这一条没有原文引句，别当引句用");
  if (f.measure) lines.push(`口径：${f.measure}`);
  return lines.join("\n");
}

/**
 * 按编号或语义取证据。
 *
 * - `q.id` 存在时按编号精确查找
 * - `q.text` 存在时按 `claim` 字面包含查找，多条都回，按命中长度排序（长度相同保持台账原序）
 * - 查不到返回空数组，不抛异常
 *
 * **入参可以是完整台账（`Evidence`）或速查形态（`BlockEvidence`）**。`Evidence` 有原文引句与口径，
 * `BlockEvidence` 只有编号、一句话、机构、等级 —— 缺的栏就让它缺，不编造。议事那一层最不能出的错
 * 就是拿 `claim`（模型自己写的）冒充 `exactQuote`（抓回来的原文）。
 */
export function lookupEvidence(
  entries: readonly (Evidence | BlockEvidence)[],
  q: { id?: string; text?: string },
): Found[] {
  let matched: readonly (Evidence | BlockEvidence)[];

  if (q.id) {
    // 按编号精确查找
    matched = entries.filter((e) => e.id === q.id);
  } else if (q.text) {
    // 按 claim 字面包含查找
    const text = q.text;
    const hits = entries
      .map((e) => {
        const claim = e.claim;
        const idx = claim.indexOf(text);
        return idx >= 0 ? { entry: e, matchLength: text.length } : null;
      })
      .filter((x): x is { entry: Evidence | BlockEvidence; matchLength: number } => x !== null);

    // 按命中长度排序，长度相同保持原序（sort 在 V8 是稳定的，但这里要的是「原序」这个语义）
    hits.sort((a, b) => b.matchLength - a.matchLength);
    matched = hits.map((h) => h.entry);
  } else {
    // 两个查询参数都没有，返回空
    matched = [];
  }

  // 构造返回值 —— 映射只有 `toFound` 一份，轮内取证那一路调的也是它
  return matched.map(toFound);
}
