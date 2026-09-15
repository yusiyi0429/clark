/**
 * ISS-239 第二轮的**冻结证据**。回放用，不是测试夹具的替代品。
 *
 * ## 为什么要有这一份
 *
 * `RUN-A4-mtqpegne-4`（2026-09-07 11:27:09 → 11:51:23，24 分 14 秒）那一轮的报告拿到 55 分，
 * 而失败的地方全在**机制**上：事实被对账修正了、行动建议仍照旧；材料截止日算成了 2020-12-31；
 * 判断板上的文档链接指向不存在的地址。这几件事都不需要重新联网就能验 —— 用它当时真的抓回来的
 * 那 31 条证据（13 个 URL）重走一遍草稿 / 对账 / 成稿，看的是**同样的证据下判断有没有跟着变**。
 *
 * 所以这一份的用法只有一个：**回放**。它不补造任何证据 —— 冻结证据没覆盖到的新问题，回放里就
 * 照实留成缺口，不许拿它跑出一份"完整的新研究"。
 *
 * ## 里面是什么
 *
 * · `LEDGER` —— 那一轮的 31 条台账原样（含 `period`、`usedAs`、`sourceTier`、`independenceGroup`）。
 *   **31 条来自 13 个 URL，不等于 31 个独立来源** —— 用它判"独立交叉验证"时要看 `independenceGroup`。
 * · `COMPANY_CONTEXT` —— 那一轮真实的公司上下文（791 字那一份，`context.json` 的 narrative）。
 *   它只说明 TKOS 是企业经营系统，**没有**证明它能做工艺缺陷分析、历史数据离线复现或良率优化。
 *   回放时不许往里加料：加了就不是同一个实验。
 * · `BASELINE` —— 那一轮的实测读数与出口违规，用来对照"改的是机制"而不是"换了个说法"。
 *
 * ## 基线里几个数的读法
 *
 * `durationMs` 是端到端 24 分 14 秒。`usage` 是整轮的 token。出口违规里 `A4-N09`（没拿到最新披露）
 * 和 `dataCutoff = 2020-12-31` 是**同一个病灶的两面**：E1 是官网「关于我们」页上「2020 年 12 月
 * 合肥第 6 代线建成」这句话 —— 一条**历史事件**，`usedAs` 写着 `historical_point`。它被当成了
 * 「一份可识别期次的一手披露」，于是整份材料的截止日被钉在 2020 年。同一轮里台账其实有 2025 年报
 * 和 2026 年的投资者关系记录（新浪镜像），它们反而因为域名不在表上而不算数。
 */

import type { Evidence } from "@/lib/research/ledger";

import snapshot from "./iss239.snapshot.json";

/** 这道题的原话。盲测要换的是**整道题**，不是把公司名替换掉。 */
export const QUERY: string = snapshot.query;

/** 那一轮真实的公司上下文（`context.json` 的 `renderedMarkdown`）。 */
export const COMPANY_CONTEXT: string = snapshot.companyContext;

/** 上下文的基准日。 */
export const CONTEXT_AS_OF: string = snapshot.contextAsOf;

/**
 * 那一轮的 31 条台账，原样。
 *
 * 断言而不是逐条校验：这份 JSON 是从落库的快照里导出来的，它**就是** `Evidence`；跑一遍
 * 校验器只会在字段名漂移时给出一个更晚、更难读的错。字段名真漂了，`tsc` 在这一行报。
 */
export const LEDGER = snapshot.ledger as unknown as Evidence[];

/** 那一轮的实测读数与出口违规。**单样本，不是 SLA**，几段并行的时间也不能相加。 */
export const BASELINE = snapshot.baseline;
