/**
 * N5 分层成稿。**正文给读者，校验机械给审计。**
 *
 * 上一版把「凭什么这么判 / 什么会推翻 / 什么会升档 / 什么内部数据能裁决」这四件事铺满
 * 正文，同一段口径限定重复三四遍 —— 内容密度不低，但同等篇幅里增量信息远少于一份普通
 * 行业分析。那套机械本身是这个产品最值钱的资产，问题只在位置。
 *
 * 所以这一步不删任何东西，只把它们收到附录：正文每节只留论点、机制、关键数，加 ≤3 行
 * 的「反证与先行指标」。
 */

import type { Block, BlockType, ReportBlocks } from "./blocks/schema";

export const APPENDIX_TYPES: readonly BlockType[] = [
  "evidence_list",      // 附录 A 证据台账
  "evidence_usage",     // 附录 B 弃用清单
  "unverified_panel",   // 附录 C 待核清单
  "judgment",           // 附录 D 判断强度与证伪条件总表
  "falsify_card",
  "caliber_map",        // 口径答得出/答不出那张表，正文里只留一段口径总注
  "divergence_view",
];

/**
 * 从一个块里提取所有可见文本。正文占比的分母是「屏幕上能读到的字」，不是代码长度。
 */
export function textOf(block: Block): string {
  switch (block.type) {
    case "prose":
      return block.md;
    case "verdict_banner":
      return block.text + (block.boundary || "");
    case "kpi_cards":
      return block.cards.map((c) => c.label + c.value + (c.unit || "") + c.caliberNote + (c.delta || "")).join("");
    case "caliber_map":
      return block.rows.map((r) => r.metric + r.answersWhat + r.cannotAnswer + r.handling).join("");
    case "layered_table":
      return block.columns.join("") + block.rows.flat().join("");
    case "funnel":
      return block.stages.map((s) => s.label + (s.note || "")).join("");
    case "bar_compare":
      return block.items.map((i) => i.label + (i.note || "")).join("");
    case "scenario_cards":
      return block.cards.map((c) => c.name + c.assumptions.join("") + c.keyNumbers.join("") + c.triggerIndicators.join("")).join("");
    case "judgment":
      return block.claim + block.reasoningSummary + block.upgradeCondition + block.falsifyCondition + block.internalValidationHooks.join("");
    case "unverified_panel":
      return block.items.map((i) => i.statement + i.whyMatters + i.whatWouldSettle + i.impactIfTrue + i.impactIfFalse).join("");
    case "evidence_list":
      return block.items.map((i) => i.claim + (i.sourceName || "")).join("");
    case "evidence_usage":
      return block.discarded.map((d) => d.reason).join("");
    case "divergence_view":
      return block.topic + block.positions.map((p) => p.verdict + p.keyBasis).join("") + block.adjudication.note;
    case "falsify_card":
      return block.conditions.join("") + block.monitoringIndicators.join("");
    case "param_model":
      return block.params.map((p) => p.label).join("") + block.outputs.map((o) => o.label).join("") + block.disclaimer;
  }
}

/**
 * 按类型切分正文与附录。保序。
 */
export function partition(blocks: Block[]): { body: Block[]; appendix: Block[] } {
  const body: Block[] = [];
  const appendix: Block[] = [];
  for (const b of blocks) {
    if ((APPENDIX_TYPES as readonly string[]).includes(b.type)) {
      appendix.push(b);
    } else {
      body.push(b);
    }
  }
  return { body, appendix };
}

/**
 * 正文占全文的比例（按去空白后的可见字数）。
 */
export function bodyShare(report: ReportBlocks): number {
  const { body, appendix } = partition(report.blocks);
  const bodyText = body.map(textOf).join("").replace(/\s+/g, "");
  const appendixText = appendix.map(textOf).join("").replace(/\s+/g, "");
  const total = bodyText.length + appendixText.length;
  return total > 0 ? bodyText.length / total : 0;
}

/**
 * 正文禁令机检。四条：
 * 1. 正文里出现 `答得出` 或 `答不出` → 报（该内容属于附录 D）
 * 2. 正文里 `口径` 出现在 2 个以上不同块 → 报（口径限定全文只许集中一段）
 * 3. `bodyShare > 0.6` → 报 `正文占全文 X%，超过 60%`
 * 4. 正文里出现 `证据不足` / `不足以判断` → 报（不足时论点基于 `P!` 给出并标注「此论点主要依赖先验，待核」）
 */
export function layerGaps(report: ReportBlocks): string[] {
  const gaps: string[] = [];
  const { body } = partition(report.blocks);

  // 规则 1：答得出/答不出
  const bodyTexts = body.map(textOf);
  if (bodyTexts.some((t) => /答得出|答不出/.test(t))) {
    gaps.push("正文里出现「答得出/答不出」—— 该内容属于附录口径表");
  }

  // 规则 2：口径出现在 2+ 块（集中一段 vs 散落各处）
  // 一个块里提三次「口径」= 集中讨论，通过；三个块各提一次 = 到处重复，拒绝。
  const blocksWithCaliber = body.filter((b) => /口径/.test(textOf(b)));
  if (blocksWithCaliber.length >= 2) {
    gaps.push(`正文里「口径」出现在 ${blocksWithCaliber.length} 个块 —— 口径限定全文只许集中一段`);
  }

  /*
   * 规则 3：正文超过 60%。
   *
   * **一个附录块都没有的时候不判。** 这条闸问的是「机械内容是不是还留在正文里」，而它
   * 的判据是比例 —— 比例的分母里一份附录都没有时，这个问题根本没被问到：那一份缺的不是
   * 位置，是收口整段（judgment / falsify_card / evidence_list 全在附录侧，收口不跑就一个
   * 都不会有）。
   *
   * 真发生过：`RUN-A4-mth5jkf0-6`（ISS-118）收口那一次被掐断，报告只剩四个块、附录为空，
   * 于是这条报「正文占 82%，超过 60%」，打回的指令是「把机械搬进附录」—— 而那一轮该做的
   * 是重跑收口。指错方向的打回比不打回更贵：它会让下一稿去搬一堆本来就该在正文里的话。
   *
   * 漏判的风险由 `lint.ts` 的 A4-B01 兜着：judgment 和 falsify_card 都是附录类型，一个
   * 附录块都没有的报告在那边是 p0，跑不掉。
   */
  const { appendix } = partition(report.blocks);
  const share = bodyShare(report);
  // 2026-09-04：0.6 → 0.8。正文压短、附录去重之后正文占比自然升高（ISS-228 是 62%），那是要的
  // 方向，不该被这条判成 p0 打回。这条防的是「附录空着、机检产物全塞进正文」，八成才是那个样子。
  if (appendix.length && share > 0.8) {
    gaps.push(`正文占全文 ${Math.round(share * 100)}%，超过 80%`);
  }

  // 规则 4：证据不足/不足以判断
  if (bodyTexts.some((t) => /证据不足|不足以判断/.test(t))) {
    gaps.push("正文里出现「证据不足/不足以判断」—— 不足时论点基于先验给出并标注「待核」");
  }

  return gaps;
}

/**
 * N5 分层成稿的提示词系统。
 *
 * 定义正文三段结构、附录 A-D 四项、以及四条正文禁令。
 */
export const LAYER_SYSTEM = `
# N5 分层成稿

**正文给读者，校验机械给审计。** 不删任何内容，只调整位置。

## 正文结构（三段）

1. **核心判断与边界**（verdict_banner + boundary）
2. **论点、机制、关键数**（prose、kpi_cards、layered_table、bar_compare、scenario_cards）
3. **反证与先行指标**（≤3 行，简要说明什么会推翻、什么是升档条件）

## 附录结构（四项）

- **附录 A：证据台账**（evidence_list）—— 每条证据的来源、档次、时点、独立性组
- **附录 B：弃用清单**（evidence_usage）—— 取回来没用的，一条一个理由
- **附录 C：待核清单**（unverified_panel）—— 查不到是合法结果，但必须写出差在哪
- **附录 D：判断强度与证伪条件总表**（judgment、falsify_card）—— 凭什么这么判、什么会推翻、什么会升档、什么内部数据能裁决

口径表（caliber_map）、分歧视图（divergence_view）也进附录。

## 正文禁令（四条）

1. **不许出现「答得出/答不出」** —— 该内容属于附录口径表
2. **「口径」只许集中一段** —— 不许在 2 个以上块里重复口径说明
3. **正文占比不超过 60%** —— 超过说明机械内容仍在正文里
4. **不许出现「证据不足以判断」** —— 不足时论点基于先验（标 P!）给出并标注「此论点主要依赖先验，待核」，不是不给论点

违反任一禁令 → 打回重写。
`.trim();
