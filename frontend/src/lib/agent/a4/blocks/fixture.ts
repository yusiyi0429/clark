/**
 * 验收用的那一份报告。**十五种块各来一个，一条 p0 都不该有。**
 *
 * 内容照的是那轮算力中心报告（任务书 §6①「报告A」）：装机到有效产出的漏斗、上架率、
 * 电费占收入。它同时是三样东西的靶子 ——
 *
 *   · 解析器：整段 JSONL 从头解析，十五个块都要出来
 *   · 校验器：这一份必须干净；四条拦截用例各自在这一份上改一处再跑
 *   · 组件库：屏幕上那十五个组件的样张（明暗两套主题、窄面板不横向溢出）
 *
 * 所以它不是「随便造几个块」：字段填得比模型平均水平齐，因为它要能证明**组件在字段
 * 齐全时长什么样**；而字段缺失时长什么样，由改这一份的那几个用例去证明。
 *
 * 数字全是构造的。这一份不会进产品的任何一条路径 —— 它只被测试和样张页 import。
 */

import type { Evidence } from "@/lib/research/ledger";

import { assembleReport } from "./report";
import type { ReportBlocks } from "./schema";

/* -------------------------------------------------------------------------- */
/* 台账那一侧                                                                  */
/* -------------------------------------------------------------------------- */

type LedgerSeed = {
  id: string;
  claim: string;
  url: string;
  siteName: string;
  authorityClass: Evidence["authorityClass"];
  sourceTier: Evidence["sourceTier"];
  independenceGroup: string;
  supportRelation?: Evidence["supportRelation"];
};

/** E1 与 E4 同组（同一篇稿子的两处转载）—— 共源折叠那一条要有真实的靶子。 */
const SEEDS: LedgerSeed[] = [
  {
    id: "E1",
    claim: "全国已建成智算中心装机规模",
    url: "https://www.gov.example/stat/2026-q2",
    siteName: "国家统计口径公报",
    authorityClass: "official_statistics",
    sourceTier: "A",
    independenceGroup: "g1",
  },
  {
    id: "E2",
    claim: "样本机房的实际上架率",
    url: "https://research.example/idc-2026",
    siteName: "某行业研究院",
    authorityClass: "industry_body",
    sourceTier: "B",
    independenceGroup: "g2",
  },
  {
    id: "E3",
    claim: "工业电价区间",
    url: "https://www.nea.example/price",
    siteName: "能源主管部门价目表",
    authorityClass: "regulator",
    sourceTier: "A",
    independenceGroup: "g3",
  },
  {
    id: "E4",
    claim: "同一份装机数据的转载",
    url: "https://news.example/repost/2026",
    siteName: "某财经媒体",
    authorityClass: "media",
    sourceTier: "C",
    independenceGroup: "g1",
  },
  {
    id: "E5",
    claim: "两家运营商披露的单卡日均有效产出",
    url: "https://ir.example/2026h1.pdf",
    siteName: "上市公司半年报",
    authorityClass: "company_primary",
    sourceTier: "A",
    independenceGroup: "g4",
    supportRelation: "qualifies",
  },
];

const evidenceOf = (seed: LedgerSeed, i: number): Evidence => ({
  id: seed.id,
  propositionId: `P${i + 1}`,
  claim: seed.claim,
  exactQuote: `${seed.claim}的原句`,
  url: seed.url,
  supportRelation: seed.supportRelation ?? "supports",
  evidenceType: "statistic",
  authorityClass: seed.authorityClass,
  sourceDomain: seed.url.split("/")[2] ?? "",
  siteName: seed.siteName,
  contentHash: `hash-${seed.id}`,
  retrievedAt: "2026-08-25T09:00:00.000Z",
  sourceTier: seed.sourceTier,
  span: [100 + i, 140 + i],
  excerpt: `${seed.claim}的原句`,
  usedAs: "current_state",
  verificationStatus: "span_matched",
  independenceGroup: seed.independenceGroup,
});

/** 这一份 fixture 的台账。`buildRegistry` 拿它把模型那份清单折成证据表。 */
export const FIXTURE_LEDGER: Evidence[] = SEEDS.map(evidenceOf);

/* -------------------------------------------------------------------------- */
/* 模型那一侧                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 模型交上来的那些行。类型故意是宽的 —— 这就是模型交的东西，要走一遍 `readBlock`
 * 才成为块。写成 `Block[]` 会让编译器替模型把字段填对，那这份 fixture 就证明不了
 * 解析器在干活。
 */
const LINES: Record<string, unknown>[] = [
  {
    type: "report_meta",
    title: "装机在涨、有效产出没跟上：这一轮算力中心的瓶颈在上架与调度，不在卡",
    confidence: "较强支持",
    dataCutoff: "2026-08-20",
  },
  {
    type: "verdict_banner",
    text: "装机规模的增长是真的，但从装机到有效产出这条链上每一级都在掉量，瓶颈在上架与调度环节 [E1][E2]。",
    confidence: "较强支持",
    boundary: "只对公开披露过运营数据的第三方智算中心成立；自用集群与超算中心不在此列。",
  },
  {
    heading: "三个数说清这一轮的落差",
    type: "kpi_cards",
    cards: [
      {
        value: "62",
        unit: "%",
        label: "样本机房上架率",
        caliberNote: "上架率＝已上架机柜/已交付机柜，不含在建；样本是公开披露过运营数据的机房",
        delta: "较上一期 +4pt",
        evidenceRefs: ["E2"],
      },
      {
        value: "0.42–0.68",
        unit: "元/kWh",
        label: "工业电价区间",
        caliberNote: "含容量电费与政府性基金，分时电价按加权平均折算",
        evidenceRefs: ["E3"],
      },
      {
        value: "约 41",
        unit: "%",
        label: "有效产出/理论产能",
        caliberNote: "有效产出＝计费成功的推理请求折算卡时；分母按标称算力×可用小时",
        evidenceRefs: ["E5"],
      },
    ],
  },
  {
    heading: "这三个指标各自答不出什么",
    type: "caliber_map",
    rows: [
      {
        metric: "装机规模",
        answersWhat: "买了多少卡、建了多少机柜",
        cannotAnswer: "有多少在跑、跑的是不是付费任务",
        handling: "只用于判断供给侧的投入节奏，不用于推算产出 [E1]",
      },
      {
        metric: "上架率",
        answersWhat: "交付的机柜里有多少通电上架",
        cannotAnswer: "上架之后有没有被调度、调度之后有没有付费",
        handling: "作为漏斗的第二级，不等于利用率 [E2]",
      },
      {
        metric: "单卡日均有效产出",
        answersWhat: "计费成功的那部分算力",
        cannotAnswer: "内部试跑、免费额度、失败重试消耗的算力",
        handling: "两家的口径不同，只取交集区间，不做平均 [E5]",
      },
    ],
  },
  {
    heading: "从装机到有效产出，四级各掉多少",
    type: "funnel",
    stages: [
      { label: "已装机", value: 100, note: "以公报口径的装机规模为 100 [E1]" },
      { label: "已上架", value: 62, note: "样本机房上架率 [E2]" },
      { label: "可调度", value: 53, note: "上架后进入调度池的部分，按两家披露折算 [E5]" },
      { label: "有效产出", value: 41, note: "计费成功的那部分 [E5]" },
    ],
  },
  {
    heading: "三档电价下的单卡日成本不可相加",
    type: "bar_compare",
    nonAdditive: true,
    items: [
      { label: "低电价园区", value: 0.42, note: "价目表下限 [E3]" },
      { label: "常规工业电价", value: 0.55, note: "加权平均 [E3]" },
      { label: "高电价地区", value: 0.68, note: "价目表上限 [E3]" },
    ],
  },
  {
    heading: "分层看：谁的上架率撑得住",
    type: "layered_table",
    columns: ["机房类型", "上架率", "可调度比例", "口径来源"],
    rows: [
      ["一线城市自建", "71%", "60%", "行业研究院样本 [E2]"],
      ["中西部园区", "58%", "49%", "行业研究院样本 [E2]"],
      ["改造型机房", "44%", "31%", "两家披露折算 [E5]"],
    ],
    rowGrade: ["B", "B", "E"],
    evidenceRefs: ["E2", "E5"],
  },
  {
    heading: "拖动这几个参数，看电费占收入到哪一档就翻不过来",
    type: "param_model",
    layer: "算力租赁层",
    params: [
      { id: "price", label: "工业电价", default: 0.55, min: 0.3, max: 0.9, step: 0.01, unit: "元/kWh" },
      { id: "kw", label: "单卡等效功率", default: 1.2, min: 0.6, max: 2, step: 0.05, unit: "kW" },
      { id: "hours", label: "日均可调度小时", default: 14, min: 0, max: 24, step: 0.5, unit: "小时" },
      { id: "revenuePerHour", label: "单卡每小时租金", default: 9, min: 2, max: 30, step: 0.5, unit: "元" },
    ],
    outputs: [
      { label: "单卡日电费", expr: "price * kw * 24", unit: "元" },
      { label: "单卡日收入", expr: "revenuePerHour * hours", unit: "元" },
      { label: "电费占收入", expr: "price * kw * 24 / (revenuePerHour * hours) * 100", unit: "%" },
    ],
    disclaimer:
      "只算电与租金两项，不含折旧、带宽、人力与空置成本；跨层移植这个占比是错的（资产托管层与 Token 生产层的分母不是同一个）。",
  },
  {
    heading: "三档情景下这条链会走成什么样",
    type: "scenario_cards",
    cards: [
      {
        name: "维持现状",
        assumptions: ["上架率停在样本区间", "调度池不可用机时不变"],
        keyNumbers: ["有效产出/理论产能 约 41% [E5]", "电费占收入 约 22%"],
        triggerIndicators: ["下一期上架率样本未上行", "两家披露的计费成功率持平"],
      },
      {
        name: "上架先修好",
        assumptions: ["交付到上架的间隔压回一个季度以内", "需求侧不变"],
        keyNumbers: ["上架率 75% [E2]", "有效产出/理论产能 约 50%"],
        triggerIndicators: ["变电扩容验收提前", "在建机柜转上架的批次变密"],
      },
      {
        name: "需求先起来",
        assumptions: ["计费成功的请求量翻倍", "上架率不变"],
        keyNumbers: ["有效产出/理论产能 约 62% [E5]", "单卡日收入上行"],
        triggerIndicators: ["两家披露的客户数上行", "现货租金止跌"],
      },
    ],
  },
  {
    heading: "上架率是可修的，调度不是",
    type: "prose",
    md:
      "上架率的落差有一部分是工程节奏问题：变电扩容和机柜验收排在一起时，交付到上架之间会压掉一个季度 [E2]。" +
      "但可调度到有效产出之间那一段掉量不同源 —— 它掉在需求侧，两家披露的口径都显示计费成功的部分只有可调度的 77% 左右 [E5]。" +
      "这一段没有工程解法：把卡插满不会让付费请求变多。",
  },
  {
    heading: "对我们的当前含义",
    type: "prose",
    md:
      "我们自己的机房处在改造型这一档，所以上面那张分层表里最差的一行才是我们的基线 [E7]。" +
      "先修上架节奏、再谈调度，是这一轮唯一有把握的顺序 [E7]。",
  },
  {
    type: "judgment",
    claim: "这一轮算力中心的瓶颈在上架与调度，不在卡的供给",
    confidence: "较强支持",
    direction: "支持",
    reasoningSummary:
      "装机侧的增长有官方口径撑着，落差全部出现在装机之后的三级；两组互相独立的来源（公报与行业研究院样本）指向同一处收窄。",
    upgradeCondition: "再拿到一组不同来源的上架率样本，且区间与现有样本重叠",
    falsifyCondition: "出现一组样本显示上架率与有效产出同步高于八成 —— 那说明落差是样本偏差，不是环节问题",
    evidenceRefs: ["E1", "E2"],
    internalValidationHooks: ["我们自己三个机房的交付到上架间隔", "调度池里被判为不可用的机时占比"],
  },
  {
    type: "judgment",
    claim: "电价不是这一轮的决定变量",
    confidence: "当前更支持",
    direction: "限定",
    reasoningSummary:
      "在可调度小时正常的假设下，电费占收入落在两成上下；只有当可调度小时掉到个位数时它才成为主要矛盾。",
    upgradeCondition: "拿到同一批机房的电费实付数据与租金实收数据",
    falsifyCondition: "出现电价上行且租金同时下行的区域样本，使电费占收入越过四成",
    evidenceRefs: ["E3", "E5"],
    internalValidationHooks: ["我们各机房的实付电价与合同租金"],
  },
  {
    heading: "三条链路在这一处不一致",
    type: "divergence_view",
    topic: "可调度到有效产出之间的掉量，是需求不足还是调度能力不足",
    positions: [
      {
        lane: "DeepSeek",
        verdict: "需求侧不足是主因",
        keyBasis: "两家披露的计费成功率与其公开的客户数同向 [E5]",
        confidence: "当前更支持",
      },
      {
        lane: "Claude",
        verdict: "调度能力不足是主因",
        keyBasis: "行业研究院样本里可调度比例本身就低于上架率 [E2]",
        confidence: "初步提示",
      },
      {
        lane: "ChatGPT",
        verdict: "两者都在，量级分不开",
        keyBasis: "公开材料里没有一份把这两段分开计量 [E2][E5]",
        confidence: "初步提示",
      },
    ],
    adjudication: {
      status: "欠定",
      method: "需内部数据",
      note: "公开披露把这两段合并计量，外部证据无法分开。要我们自己机房的调度日志才裁得开。",
    },
  },
  {
    heading: "这几条本轮没能核实",
    type: "unverified_panel",
    items: [
      {
        statement: "改造型机房的调度池不可用机时占比",
        whyMatters: "它决定上面那条判断里「先修上架」的顺序是否成立",
        whatWouldSettle: "任一家运营商公开的调度日志汇总，或我们自己三个机房的同口径数据",
        impactIfTrue: "若占比高，瓶颈提前到上架之后的第一级，顺序不变",
        impactIfFalse: "若占比低，掉量全在需求侧，先修上架就是白修",
      },
    ],
  },
  {
    heading: "什么会推翻这份报告",
    type: "falsify_card",
    conditions: [
      "出现一组公开样本，上架率与有效产出同步高于八成",
      "官方口径改变装机的统计范围，使公报数与样本口径不再可比",
      "电价上行叠加租金下行，使电费占收入越过四成",
    ],
    monitoringIndicators: ["季度装机公报", "行业研究院上架率样本更新", "两家运营商的季度披露", "重点区域工业电价调整"],
  },
  {
    heading: "这一份用到的证据",
    type: "evidence_list",
    items: [
      { id: "E1", claim: "装机规模的增长有官方口径", updateDirection: { target: "瓶颈不在卡", effect: "强化" } },
      { id: "E2", claim: "样本机房上架率 62%", updateDirection: { target: "瓶颈在上架", effect: "强化" } },
      { id: "E3", claim: "工业电价区间 0.42–0.68 元/kWh", updateDirection: { target: "电价不是决定变量", effect: "限定" } },
      { id: "E4", claim: "同一份装机数据的媒体转载", updateDirection: { target: "瓶颈不在卡", effect: "强化" } },
      { id: "E5", claim: "单卡日均有效产出只有理论产能的四成", updateDirection: { target: "瓶颈在调度", effect: "强化" } },
      {
        id: "E6",
        claim: "改造型机房的变电扩容周期通常在一个季度以上",
        sourceName: "行业通识",
        sourceType: "模型既有知识",
        updateDirection: { target: "上架率是可修的", effect: "限定" },
      },
      {
        id: "E7",
        claim: "我们自己三个机房都属于改造型",
        sourceName: "内部机房台账",
        sourceType: "内部DOC",
        updateDirection: { target: "对我们的当前含义", effect: "限定" },
      },
    ],
  },
  /*
   * 证据利用率对账。E4 是这一份里唯一被弃用的那条 —— 它和 E1 同组（同一份装机数据的转载），
   * 所以这一行同时是「弃用理由写得出来」的样张：共源折叠之后剩下的那一条要说得清凭什么留
   * 另一条。它在 evidence_list 里照旧列着，正文一处都没引 —— A4-B11 那条只数正文，理由写在
   * 那边。
   */
  {
    heading: "取回来的证据都去哪儿了",
    type: "evidence_usage",
    used: ["E1", "E2", "E3", "E5"],
    discarded: [{ id: "E4", reason: "与 E1 是同一份装机数据的转载，时点更旧且不是一手，留 E1" }],
  },
];

/** 模型那一份的原样输出。**以换行收尾** —— 收尾的那一份必须是完整的。 */
export const FIXTURE_JSONL: string = `${LINES.map((x) => JSON.stringify(x)).join("\n")}\n`;

/** 这一份该解析出多少个块。写成常数是为了改 fixture 时测试会先红。 */
export const FIXTURE_BLOCK_COUNT = LINES.length - 1;

/* -------------------------------------------------------------------------- */
/* 组装好的那一份                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 落库形态的 fixture。**和真链路走的是同一个 `assembleReport`** —— 这一句是这份 fixture
 * 全部证明力的来源：自己拼一遍的话，它证明的只是「我拼得对」。
 */
export function fixtureReport(): ReportBlocks {
  return assembleReport({
    text: FIXTURE_JSONL,
    entries: FIXTURE_LEDGER,
    lane: { model: "gpt-5.6", short: "GPT-5.6", durationS: 214 },
    complete: true,
  }).report;
}
