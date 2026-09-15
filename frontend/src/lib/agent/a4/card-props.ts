/**
 * 主体卡的事实 → 第一优先命题。**确定性生成，不经模型。**
 *
 * ## 为什么（2026-09-05）
 *
 * N2 的命题全部从 N1 草稿的断言里抽（`buildPlanUser(draft, …)`）。草稿每轮不同、写手不同则
 * 更不同，于是同题同快照两轮入账 4 和 19（R-11）—— 研究深度的方差一半来自命题来源。而主体卡
 * 上那几样东西（在建项目、业务构成、客户结构）是这一轮研究的边界本身：它们对不对，直接决定
 * 报告的落点对不对。ISS-231 的主体卡写「合肥第 6 代柔性 AMOLED 产线」，它自己的 E1 说的是
 * 8.6 代线在建 —— 出口机检报了 A4-N05，但那时已经写完了。这几条要在取证第一波就被核掉。
 *
 * ## 做什么
 *
 * 从主体卡取最多八条：最新披露 ≤3、在建项目（权重过线的先）≤2、业务板块 ≤2、客户结构 1。
 * 每条带确定性的正向与反向问法，编号 `D8-F1`（`F` = filing）与 `D2-C1` / `D8-C1`（`C` = card，
 * 和计划抽出来的 `P` 系列分开，账上一眼看得出这条证据是替主体卡核的）。它们排在计划命题
 * **前面**，同一条链里先搜它们。
 *
 * ## 「最新披露」这一类为什么必须在这里，而且排最前（2026-09-07，ISS-238）
 *
 * 那一轮深研拿 **2024 年报**下了「现金流薄」的判断，而 2026 年 4 月发布的 2025 年报里经营
 * 现金流已经回升到 23 亿，报告的落点整个是错的。上一版命题只有项目 / 板块 / 客户三类，
 * 没有一条是「去把最新那份定期报告拿回来」—— 剩下的命题全部从 Claude 草稿的断言里抽，
 * 而草稿的知识停在 2025 年，它心里那份「最新年报」就是 2024 那份。
 *
 * 所以这一类不能等模型想起来：**年份从 `new Date()` 算，不从模型来**。这也是 `now` 这个
 * 参数存在的唯一理由 —— 不给它就没法钉住「2026 年跑的这一轮要去搜 2025 年年度报告」。
 *
 * 问自己家里的事（`inward`）没有外部主体，不生成。
 */

import type { SubjectCard } from "./anchor";
import type { PlannedProposition } from "./plan";

const MAX_PROJECTS = 2;
const MAX_SEGMENTS = 2;

const clean = (v: string): string => v.replace(/\s+/g, " ").trim();

/**
 * 最新披露那几条要核回来的东西。**「战略重点」这一栏是 238 漏掉的那一格**：年报「管理层
 * 讨论与分析」里公司自己说要做什么（238 那家写的是「深化大数据与 AI 数智变革」），它不在
 * 任何一份行业报告里，只能从这份原文里拿。
 */
const FILING_EVIDENCE =
  "定期报告原文里的：报告期、营业收入、归属于母公司股东的净利润、经营活动产生的现金流量净额、" +
  "分业务的收入构成，以及「管理层讨论与分析」里公司自己写的战略重点";

export function cardPropositions(card: SubjectCard, now: Date = new Date()): PlannedProposition[] {
  const subject = clean(card.subject);
  if (card.inward || !subject) return [];
  const out: PlannedProposition[] = [];

  /*
   * ---- 最新披露：排在项目 / 板块 / 客户之前 --------------------------------
   *
   * 排最前不是礼貌。命题的顺序就是这一波检索式发出去的顺序，也是抓取位保留
   * （`research/slots.ts`）挑页时看到的顺序 —— 排在后面的话，它和上一版一样要跟八个
   * 转载页抢那 8 个位子。
   *
   * 每条给两条正向问法：`site:` 那条是要害（它直接落在巨潮 / 官网上），但博查那一家对
   * `site:` 的支持没有承诺，只发它的话遇上不认这个算子的检索家就是整条命题空手。第二条
   * 是不带算子的同一个意思，兜住那种情况。
   */
  const year = now.getFullYear();
  const filings: { id: string; period: string; query: string }[] = [
    { id: "D8-F1", period: `${year - 1} 年年度报告`, query: `${subject} ${year - 1}年年度报告 site:cninfo.com.cn` },
    { id: "D8-F2", period: `${year} 年半年度报告`, query: `${subject} ${year}年半年度报告 site:cninfo.com.cn` },
    // 官网那条只在主体卡真给了域名时生成 —— 拼一条 `site:` 空域名的检索式等于白发一次。
    ...(card.website
      ? [{ id: "D8-F3", period: "最近的重大公告", query: `${subject} 公告 site:${card.website}` }]
      : []),
  ];
  for (const f of filings) {
    out.push({
      id: f.id,
      dimension: "D8",
      statement: `${subject} 最新一期公开披露（${f.period}）里的经营现状：报告期、营收、归母净利润、经营现金流净额、业务构成与公司自述的战略重点`,
      requiredEvidence: FILING_EVIDENCE,
      queries: [f.query, `${subject} ${f.period} 全文`],
      // 反向问法找的是「这份数还作不作数」：更正、补充、业绩预告修正、审计意见。
      counterQueries: [`${subject} 业绩预告修正 更正公告 补充公告`],
      sourceKinds: ["公司披露"],
      material: true,
      freshnessUrgent: true,
      extraRoundsCap: f.id === "D8-F1" ? 2 : 1,
    });
  }

  const projects = [...card.projects.filter((p) => p.heavy), ...card.projects.filter((p) => !p.heavy)]
    .filter((p) => p.name)
    .slice(0, MAX_PROJECTS);
  projects.forEach((p, i) => {
    const name = clean(p.name);
    const facts = [
      p.investment ? `投资 ${clean(p.investment)}` : "",
      p.onlineAt ? `${clean(p.onlineAt)} 投产` : "",
      p.techRoute ? `技术路线 ${clean(p.techRoute)}` : "",
    ].filter(Boolean);
    out.push({
      id: `D2-C${i + 1}`,
      dimension: "D2",
      statement: `${subject}「${name}」${facts.length ? `：${facts.join("，")}` : "在建"}`,
      requiredEvidence: "公司公告、年报或投资者关系材料里对该项目投资额、投产时间、技术路线与进度的原文",
      queries: [
        `${subject} ${name} 投资额 公告`,
        `${subject} ${name} 投产 时间 进度`,
        ...(p.techRoute ? [`${subject} ${name} ${clean(p.techRoute)}`] : []),
      ],
      counterQueries: [`${subject} ${name} 延期 变更 终止`],
      sourceKinds: ["公司披露", "媒体线索"],
      material: p.heavy,
      freshnessUrgent: true,
      extraRoundsCap: p.heavy ? 2 : 1,
    });
  });

  let d8 = 0;
  card.segments
    .filter((x) => x.name)
    .slice(0, MAX_SEGMENTS)
    .forEach((seg) => {
      const name = clean(seg.name);
      d8 += 1;
      out.push({
        id: `D8-C${d8}`,
        dimension: "D8",
        statement: `${subject} 的「${name}」板块${seg.weight ? `占 ${clean(seg.weight)}` : ""}，处于${seg.lifecycle}阶段`,
        requiredEvidence: "年报或半年报里分业务的收入构成与同比，或公司披露里对该板块的定位",
        queries: [`${subject} ${name} 收入 占比 年报`, `${subject} 分业务 收入 构成 同比`],
        counterQueries: [`${subject} ${name} 收入 下滑 收缩`],
        sourceKinds: ["公司披露", "行业机构"],
        material: true,
        freshnessUrgent: true,
        extraRoundsCap: 1,
      });
    });

  if (card.customers) {
    d8 += 1;
    out.push({
      id: `D8-C${d8}`,
      dimension: "D8",
      statement: `${subject} 的客户结构：${clean(card.customers)}`,
      requiredEvidence: "年报里前五大客户占比，或公司披露、可信媒体对主要客户与订单的报道",
      queries: [`${subject} 前五大客户 占比`, `${subject} 主要客户 订单`],
      counterQueries: [`${subject} 客户 流失 份额 下降`],
      sourceKinds: ["公司披露", "媒体线索"],
      material: true,
      freshnessUrgent: true,
      extraRoundsCap: 1,
    });
  }

  return out;
}
