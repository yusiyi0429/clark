import type { ReportBlocks } from "@/lib/agent/a4/blocks/schema";
import type { IssueReport } from "@/lib/data/types";

import type { CommandBrief, CommandBriefBundle } from "./types";

/**
 * 从这一轮的几份报告里把决断包挑出来。
 *
 * ## 为什么是「挑」，不是「读某一栏」
 *
 * 一轮深研同时跑几条链路，每条各写一份区块报告，而收口那一次只在**主源那一份**上多交
 * `command_brief`。所以正常情况下答案就是 `agent` 那一栏。但有两种真发生过的情形要兜住：
 *
 * · 主源那一栏还在跑，手上只有半份（`pending.blocks`）—— 半份里已经有决断包的话，那就是
 *   此刻屏幕上能给出的最好的一份；
 * · 主源那条链路挂了，别的链路写完了（`a4/run.ts` 允许一条挂不拖垮一轮）—— 那时决断包
 *   可能挂在 `agent:alt0` 上。
 *
 * 顺序因此是「主源优先，其余按页签顺序兜底」，而不是「扫一遍取第一个」：两份都在的时候
 * 必须是主源那一份，判断板和四节压缩压的也是它，三处不许指向不同的报告。
 *
 * ## 没有决断包时返回 `null`
 *
 * 这是硬要求，不是兜底：行业题、这一版之前跑出来的报告、以及这一轮参谋没写出行动建议的，
 * 都没有 `commandBrief`。**新报告没有命令包是合法的**，页面照常好用 —— 那时判断板底下
 * 那个「整理成行动建议」的入口不长出来，这一页就是判断、情报附件、知识关系三格
 * （见 `_views/advisor-view.tsx`）。这个函数返回 `null` 就是那条路的全部触发条件。
 *
 * 默认页**不**由它决定：默认恒为当前判断，有没有决断包都一样（同上）。
 */

/**
 * `commandBrief` 此刻还不在 `ReportBlocks` 上（产出那一侧在另一条线上做，见 `types.ts`）。
 * 用一个交叉类型把它读出来，不用 `any` —— 换成 `any` 的话，schema 落地后字段改了名，
 * 这里一声不吭地读到 `undefined`，而屏幕上的样子是「所有报告都没有决断包」。
 *
 * TODO(批 V·集成)：schema 里落地后删掉这个交叉类型，直接读 `blocks.commandBrief`。
 */
type BlocksWithBrief = ReportBlocks & { commandBrief?: CommandBrief };

const briefIn = (blocks: ReportBlocks | undefined): CommandBrief | undefined =>
  (blocks as BlocksWithBrief | undefined)?.commandBrief;

/** 一栏报告手上此刻那份区块报告 —— 落库的、只有原件的、还在跑的半份，三种都算。 */
const blocksOf = (r: IssueReport): ReportBlocks | undefined =>
  r.doc?.blocks ?? r.source?.blocks ?? r.pending?.blocks;

/** 一栏报告里的决断包（连着它自己那份证据表）。没有就是 `undefined`。 */
function bundleOf(r: IssueReport): CommandBriefBundle | undefined {
  const blocks = blocksOf(r);
  const brief = briefIn(blocks);
  if (!blocks || !brief) return undefined;
  return { brief, evidence: blocks.evidence, laneKey: r.key };
}

export function pickCommandBrief(reports: IssueReport[] | undefined): CommandBriefBundle | null {
  if (!reports) return null;
  const primary = reports.find((r) => r.key === "agent");
  if (primary) {
    const got = bundleOf(primary);
    if (got) return got;
  }
  for (const r of reports) {
    if (r.key === "agent") continue;
    const got = bundleOf(r);
    if (got) return got;
  }
  return null;
}
