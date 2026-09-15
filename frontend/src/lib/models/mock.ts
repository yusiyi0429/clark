/**
 * 假模型。对齐自 `tkos-lab/scripts/verify_graphknowledge.py` 的用法。
 *
 * `TKOS_MODEL_MOCK=1` 时 `callModel()` 不出网，直接返回这里的罐头。为的是把
 * 「五段装配 → 快照冻结 → 自检 → Run 落库 → 写回」这一整条路跑通而**不烧
 * token**：这条路上的 bug（字段名写错、写回写到别的卡上）跟模型质量无关，
 * 却只有整跑一遍才暴露。
 *
 * 罐头内容按真 prompt 的输出格式写，尽量让质量门过 —— 过不了就调这里的文案，
 * **不要动 `validate` 规则**。
 *
 * 深研那一支开了区块开关（`TKOS_DR_BLOCKS=1`）时交的不是下面这些正文，而是一份 JSONL：
 * 那几份罐头在 `mock-blocks.ts`，因为它们要读这一轮的提示词才写得出来。
 */
import { blockCanned, type MockMsg } from "./mock-blocks";

/* -------------------------------------------------------------------------- */
/* 深研 v2 那七个节点（`a4/pipeline.ts`）                                       */
/* -------------------------------------------------------------------------- */

/**
 * 一份 JSONL。以换行收尾 —— 收尾那一行必须是完整的（同 `mock-blocks.ts` 里那一个）。
 *
 * 这一支的三份罐头（草稿、检索计划、对账）都是 JSONL 或大对象，写成一整行手抄的字符串
 * 会在某次改动之后错一个逗号而没人看得出来，所以这里由数据折出来。
 */
const v2Jsonl = (lines: Record<string, unknown>[]): string =>
  `${lines.map((x) => JSON.stringify(x)).join("\n")}\n`;

/** 那笔押上两成身家的在建项目。它的名字必须能在行业定义里找到（`anchor.ts` 的 `cardGaps`）。 */
const V2_HEAVY = "第 8.6 代 AMOLED 产线";
/** 行业定义。**超过 11 个字**（泛类目下限），而且写出主业和战略投入方向两头。 */
const V2_INDUSTRY = "柔性中小尺寸 AMOLED 面板，正向高世代中尺寸 AMOLED 的 IT 与车载应用扩张";

/**
 * 八维草稿的内容。**草稿那一份和对账那一份都从这里折** —— 两份各手写一套的话，对账那一步
 * 的「每条断言都要进变更日志」在离线下永远差着几条，而那条红是罐头的问题不是链路的问题。
 *
 * 每条断言三样标注（`tag`/`confidence`/`timeSensitive`）都填齐：少填一样这条就不算「已标注」
 * （`draft.ts` 的 `annotated`），而标注率不足九成会让 N1 每轮都补正一次。
 */
/*
 * **`answerIn` 这一栏罐头里也要有**（2026-09-07，ISS-240）。
 *
 * 它是 `draft.ts` 的标注率闸认的四样之一，缺了它离线跑每一轮都会挂一条「16 条断言里只有
 * 0 条带完整标注」—— 那条缺口是假的，而假缺口比没有缺口更坏：它教人不看缺陷清单。
 *
 * 而且这里**故意不是恒定值**（有一条落「要问对方」），理由同上面 `strongDimsOf` 那一段：
 * 一栏在罐头里恒定，靠它分流的那一整段代码离线就一次都执行不到。
 */
const V2_SECTIONS: {
  dim: string;
  thesis: string;
  body: string;
  assertions: {
    text: string;
    confidence: string;
    timeSensitive: boolean;
    loadBearing: boolean;
    /** 答案在谁手里（`draft.ts` 的 `ANSWER_SOURCES`）。**罐头里也要有** —— 见下面那段。 */
    answerIn: string;
  }[];
}[] = [
  {
    dim: "D1",
    thesis: "中小尺寸的增量已经从手机换机转到 IT 与车载这两块新面",
    body: "手机面板的渗透率到了成熟段，出货量随换机周期走；IT 与车载还在渗透期，单机面积是手机的数倍，所以面积口径的增量主要由这两块贡献。",
    /*
     * D1 这一维**故意有一条既承重又高置信**的断言。
     *
     * `strongDimsOf`（`pipeline.ts`）取的正是「承重 + 高置信」那一档，它决定
     * `gateOpen` 对这一维要一组还是两组独立来源，也决定 N3 末尾要不要给它补旁证。
     * 原来这份罐头里 `loadBearing: true` 永远配「中」、`confidence: "高"` 永远配
     * 非承重，两者**从不同时成立** —— 于是离线跑的 `strongDims` 恒为空数组，
     * 「强判断要两组」那条分支和补旁证那一整段**一次都没被执行过**。
     *
     * 只给 D1 一条，不是每维都给：要的是「有强有弱」的对照，全给等于换一个恒定值。
     */
    assertions: [
      { text: "手机 AMOLED 的渗透率进入成熟段，面积增量主要靠 IT 与车载", confidence: "高", timeSensitive: true, loadBearing: true, answerIn: "公开可查" },
      { text: "车载显示的单机面积是手机的数倍，同样出货量下拉动的面积不可比", confidence: "高", timeSensitive: false, loadBearing: false, answerIn: "公开可查" },
    ],
  },
  {
    dim: "D2",
    thesis: "高世代线的在建产能会在投产那一年集中释放，供需在那之前不会松",
    body: "面板是重资产周期行业：产能从开工到满产要三年上下，一条线的设计产能在爬坡结束后一次性进入市场，所以供给曲线是台阶不是斜坡。",
    assertions: [
      { text: "高世代 AMOLED 在建产线的设计产能在爬坡结束后集中释放", confidence: "中", timeSensitive: true, loadBearing: true, answerIn: "公开可查" },
      { text: "面板产能从开工到满产的周期在三年上下", confidence: "高", timeSensitive: false, loadBearing: false, answerIn: "要问对方" },
    ],
  },
  {
    dim: "D3",
    thesis: "光刻类图形化路线要靠中尺寸的良率经济性才能站住",
    body: "蒸镀的掩膜张力随基板尺寸放大而恶化，中尺寸上这一项是良率天花板；光刻类路线绕开了掩膜，代价是工序变长，所以它的胜负手是中尺寸单位面积成本。",
    assertions: [
      { text: "蒸镀掩膜的张力问题随基板尺寸放大而恶化，中尺寸上构成良率上限", confidence: "高", timeSensitive: false, loadBearing: true, answerIn: "公开可查" },
      { text: "光刻类图形化路线的工序更长，单位面积成本要靠良率补回来", confidence: "中", timeSensitive: true, loadBearing: true, answerIn: "公开可查" },
    ],
  },
  {
    dim: "D4",
    thesis: "第一梯队按高世代线的开工顺序重排，份额跟着产能走",
    body: "客户认证周期长，先投产的一方拿到的是先验证机会而不是先降价机会；所以格局的变量是开工顺序，不是当期价格。",
    assertions: [
      { text: "中尺寸 AMOLED 的份额排序跟随高世代线的投产顺序", confidence: "中", timeSensitive: true, loadBearing: true, answerIn: "公开可查" },
      { text: "整机客户的面板认证周期长于一个产能周期", confidence: "中", timeSensitive: false, loadBearing: false, answerIn: "公开可查" },
    ],
  },
  {
    dim: "D5",
    thesis: "驱动芯片和发光材料这两环仍是外供，它们决定扩产的实际节奏",
    body: "上游的瓶颈环节不随产线一起扩：驱动芯片的产能排期和发光材料的认证都在面板厂之外，所以扩产计划的实际执行速度由这两环封顶。",
    assertions: [
      { text: "驱动芯片与发光材料仍以外供为主，构成扩产节奏的实际约束", confidence: "中", timeSensitive: true, loadBearing: true, answerIn: "公开可查" },
      { text: "发光材料的客户认证周期长，切换供应商不在一个季度内完成", confidence: "中", timeSensitive: false, loadBearing: false, answerIn: "公开可查" },
    ],
  },
  {
    dim: "D6",
    thesis: "高世代线是各地产业政策明确支持的方向，资本开支能拿到配套",
    body: "重资产投入的地方配套是这一行的常规安排，它压低了单条线的实际资本成本；政策的方向性在这一轮没有反向变化的迹象。",
    assertions: [
      { text: "高世代显示产线在现行产业政策里属于明确支持的方向", confidence: "中", timeSensitive: true, loadBearing: false, answerIn: "公开可查" },
      { text: "地方配套能压低单条产线的实际资本成本", confidence: "中", timeSensitive: false, loadBearing: false, answerIn: "公开可查" },
    ],
  },
  {
    dim: "D7",
    thesis: "最大的下行风险是投产年撞上需求淡季，那一年的折旧要自己扛",
    body: "折旧从投产那天起计，收入要等认证和爬坡；两者之间的时间差就是这一行最典型的亏损区间，周期位置决定这个区间有多长。",
    assertions: [
      { text: "折旧从投产起计而收入要等认证爬坡，两者的时间差构成主要下行风险", confidence: "高", timeSensitive: false, loadBearing: true, answerIn: "公开可查" },
      { text: "当前周期位置接近上一轮扩产的消化末段", confidence: "低", timeSensitive: true, loadBearing: true, answerIn: "公开可查" },
    ],
  },
  {
    dim: "D8",
    thesis: `该盯的是 ${V2_HEAVY} 的爬坡进度和中尺寸客户的认证进展`,
    body: `这家公司未来两三年的变量集中在 ${V2_HEAVY} 上：它的投产时点决定折旧起点，它的良率决定中尺寸能不能接单，而客户认证决定产能有没有出口。`,
    assertions: [
      { text: `${V2_HEAVY} 的投产时点与爬坡良率是这家公司未来两三年的核心变量`, confidence: "中", timeSensitive: true, loadBearing: true, answerIn: "公开可查" },
      { text: "中尺寸客户的认证进展决定新增产能有没有出口", confidence: "中", timeSensitive: true, loadBearing: true, answerIn: "公开可查" },
    ],
  },
];

/** 每维两条命题（`plan.ts` 的 `MIN_PROPS_PER_DIM`），来源类型两类（`MIN_SOURCE_KINDS`）。 */
const V2_PROPS = V2_SECTIONS.flatMap((sec) =>
  sec.assertions.map((a, i) => ({
    dimension: sec.dim,
    statement: a.text,
    requiredEvidence: "带统计期间的第三方数据，或公司披露里的原文表述",
    queries: [`${sec.dim} ${a.text.slice(0, 12)} 最新数据`, `${a.text.slice(0, 10)} 2026`],
    counterQueries: [`${a.text.slice(0, 10)} 不成立`],
    sourceKinds: i === 0 ? ["行业机构", "公司披露"] : ["监管与政策", "媒体线索"],
    materialityWeight: a.loadBearing ? 0.8 : 0.4,
    freshnessUrgency: a.timeSensitive ? 0.9 : 0.2,
  }))
);

const CANNED: Record<string, unknown> = {
  "a1a.triage": {
    decision: "new_issue",
    signal_reading: "大厂把 To B 的入口从模型能力挪到了行业交付。",
    target_issue_code: "",
    rationale: "现有议题里最接近的那条讲的是模型能力对比，说的不是入口在谁手上这件事。",
  },
  "a1a.issue.new": {
    decision: "new_issue",
    sharp_title: "入口移到行业交付之后，我们的差异还剩什么？",
    issue_statement: "如果入口移到行业交付，我们靠模型能力建立的差异还剩多少？",
    what_happened: "大厂把 To B 的销售与交付合并成行业线。",
    evidence_boundary: "这只是一次组织公告，没有中标数据，也没有失败案例与成本，样本是一家。",
    business_consequence:
      "招标季在三个月内开始，入口一旦被占，明年再谈就是替换成本；" +
      "但如果这只是一次组织调整，我们提前改打法会丢掉现在唯一的差异。",
    real_question: "采购决策权此刻到底在技术评估侧还是行业交付侧？",
    source_line: "一家大厂的组织公告，二手转引，未独立核实。",
    shakes_assumption: "我们赌的是模型能力足以带动交付。",
    suggested_handling: "先查两个已投标客户的决策链此刻在谁手里。",
    cited_member_ids: [],
  },
  /*
   * 取代那条路的罐头用的是一个假编号，所以「被取代的议题在上下文里存在」和
   * 「引用 ID 真实」这两条自检在 mock 下**会红**。这是预期结果，不是缺陷：
   * mock 验的是这条路走不走得通，不是模型选得对不对。
   */
  "a1a.issue.update": {
    decision: "update_issue",
    target_issue_code: "ISS-MOCK-01",
    replaces: { code: "ISS-MOCK-01", statement_before: "（mock）旧议题的说法。" },
    sharp_title: "（mock）这件事只发生在一个行业还是三个？",
    issue_statement: "（mock）新议题把范围从三个行业收窄到一个。",
    what_happened: "（mock）新一批招标文件里，只有一个行业的技术评分权重在降。",
    evidence_boundary: "（mock）三个行业里只拿到一个行业的招标文件，时间窗只有一个季度。",
    business_consequence:
      "（mock）如果只是一个行业，覆盖面那条假设仍然成立，改打法的代价白付；" +
      "如果三个都在降，现在这条获客链就要重排。",
    real_question: "（mock）另外两个行业的技术评分权重有没有同步下降？",
    source_line: "（mock）一个行业的公开招标文件。",
    what_changed: "范围从三个行业收窄到一个",
    why_replace_not_new: "说的仍是同一件事，只是边界变了。",
    shakes_assumption: "（mock）动摇的是覆盖面那条假设。",
    suggested_handling: "（mock）先确认那一个行业的决策链。",
    cited_member_ids: [],
  },
  "a1a.issue.external": {
    decision: "new_issue",
    sharp_title: "入口从能力侧移到交付侧了吗？",
    issue_statement: "入口从能力侧移到交付侧之后，谁必须重新考虑自己在做什么？",
    what_happened: "同一个季度里，三家大厂各自把 To B 的销售与交付合并成行业线。",
    evidence_boundary:
      "三条都是企业自己发的组织公告，没有第三方核实的中标数据，也没有一例失败与成本；" +
      "「行业拐点」那句是媒体叙事，不是事实。",
    business_consequence:
      "靠单点能力定位的公司，其获客链依赖技术评估是主要门槛这条前提可能不再成立；" +
      "但如果这只是三家各自的组织调整，提前改定位反而丢掉现有差异。",
    real_question: "采购决策权是真的换了人，还是只是汇报线换了？",
    source_line: "三家大厂的组织公告，二手汇编，未独立核实。",
    why_it_qualifies:
      "它指向的是采购决策权的转移，一旦成立，靠单点能力定位的公司都要重新算自己的位置，" +
      "而这件事不是一次性事件，也不是执行层面的操作问题。",
    cited_member_ids: [],
  },
  /*
   * 「我自己有一件事」里贴了一整篇或一个链接时，替那段东西起的标题。
   *
   * 罐头是固定一句，所以单测断言标题内容没有意义 —— 那里该断言的是**这条路走通了**
   * （标题不等于原文、`titleByModel` 落了 true），以及模型挂掉时回落成原文首句。
   */
  "own.title": {
    title: "（假模型）这份材料在说什么",
  },
  "a3.pre-research": {
    status: "valid",
    statusReason: "",
    // 2026-09-05 预研 v3：一针见血那一句 + 一号位给定的前提（罐头议题里没有前提，空数组）。
    verdict: "值得现在投入：决策权换层之后，技术评分不再是进场票。",
    premises: [],
    question: "入口移到交付侧之后，我们的模型能力还能不能带动成单？",
    take:
      "采购决策权正在从技术评估侧移到行业交付侧。这让「能力更强所以会被选中」这条链断了一环。" +
      "在两个已投标客户身上，决策人已经换成了业务线负责人。",
    finding: [
      {
        label: "决策人已经换了层",
        text: "两个已投标客户的决策人在近一个季度换成了业务线负责人。技术评估不再是第一道门。",
        traces: [{ kind: "int", source: "投标记录" }],
      },
      {
        label: "评分口径跟着一起动",
        text: "同期公开招标文件里，技术评分权重从四成降到两成五。两件事同期发生，更像同一件事的两个表现。",
        traces: [{ kind: "ext", source: "公开招标文件" }],
      },
    ],
    openQuestion: [
      {
        text: "这个权重变化是这一个行业的事，还是三个行业都在发生？",
        traces: [{ kind: "agent", source: "本轮预研" }],
      },
    ],
    soWhat: "值得继续想：它压在我们最主要的那条获客假设上。",
  },
  /*
   * 命题编译。**两条，第二条故意查不到** —— 离线跑要能走通「有一条没闭合」那条路：
   * `buildUnresolved` 有内容、报告里那一节「未能核实的部分」被要求写出来。两条都能闭合
   * 的罐头只会让 HP-5 那一整段代码在离线下从来没被执行过。
   */
  "a4.props": {
    propositions: [
      {
        statement: "采购决策权在近一个季度已经从技术评估侧移到业务线负责人手上",
        requiredEvidence: "公开招标文件或主管部门口径下的评分权重变化，要带统计期间",
        queries: ["招标 技术评分 权重 下调", "采购决策 业务线 负责人"],
        counterQueries: ["技术评分 权重 未变 招标"],
        materialityWeight: 0.8,
        freshnessUrgency: 0.6,
      },
      {
        statement: "这一变化同时出现在另外两个行业，不只是单一行业的局部现象",
        requiredEvidence: "另外两个行业同期的公开招标文件，口径可比",
        queries: ["另外两个行业 招标 评分 权重 同期"],
        counterQueries: ["行业间 评分 权重 未同步"],
        materialityWeight: 0.4,
        freshnessUrgency: 0.3,
      },
    ],
  },
  /*
   * 证据抽取。**`exactQuote` 必须和 `research/fetch.ts` 里 `mockPage()` 的正文逐字对得上**
   * —— 对不上的话 `ledger.record` 的第三道闸（引句定位）会把每一条都拒掉，于是离线跑
   * 永远是空台账，「入账 → 折叠 → 覆盖判定 → 出口对账」这一整条就一次都没被执行过，
   * 而屏幕上看起来只是「这题没搜到东西」。改那边的假正文时这里要跟着改。
   *
   * 两条都写 P1：假正文里只有那一句数字，第二条命题因此闭不合 —— 那正是上面要的。
   * 也**不放 refutes**：反证条目的编号随抓到几页浮动（`A4-G03` 要求每一条都被引到），
   * 罐头报告没法预先知道该引哪几个号。
   */
  "a4.extract": {
    evidence: [
      {
        propositionId: "P1",
        claim: "示例口径下算力规模为 1590 EFLOPS，统计截至 2025 年末",
        exactQuote: "示例数值为 1590 EFLOPS，统计截至 2025 年末",
        supportRelation: "supports",
        evidenceType: "statistic",
        authorityClass: "official_statistics",
        usedAs: "current_state",
        value: 1590,
        unit: "EFLOPS",
        period: "2025-12-31",
        geography: "中国",
      },
      {
        propositionId: "P1",
        claim: "这一页自称是离线自测用的占位正文，不是真实来源",
        exactQuote: "这是离线自测用的占位正文，不是真实来源",
        supportRelation: "supports",
        evidenceType: "statement",
        authorityClass: "other",
        usedAs: "current_state",
      },
    ],
  },
  /*
   * 报告那一层的罐头是**一个字符串**，不是对象 —— 它那次调用走 `json:false`，要的就是
   * 报告正文（见 `a4/prompt.ts` 头部）。`mockText` 因此要认字符串，不能一律 stringify：
   * 套一层引号回去，`sourceText` 里就会存进一份带转义的假 JSON，而报告页签照样渲染，
   * 屏幕上看不出哪里不对。
   *
   * 它要过**出口对账**（`a4/gate.ts`），所以三件事是硬的：至少引一个真实存在的 `[E编号]`
   * （离线一轮至少入账到 E2）、有「未能核实的部分」这一节、**不写「未联网」** —— 离线跑
   * 走的是假检索加假页面，但入账那几段是真跑的，写「未联网」会被 A4-R07 判成自我否认。
   *
   * 它短，`validateReport` 的 A4-R09（篇幅）在 mock 下会红。**这是预期结果，不要为了
   * 让门全绿把它注水到一千五百字** —— 那一条全是 p1，不挡运行；而罐头的用处是把这条
   * 路跑通，不是演示一份好报告。
   */
  "a4.report": `采购决策权不是仍在技术评估侧，而是已经移到业务线负责人手上

## 核心判断

当前更支持这个判断：在我们已投标的两个客户处，决策人已经换成业务线负责人，技术评分不再是主要门槛。它的边界是样本只有两个客户，且都在同一个行业。

## 一、技术评分权重的下降不是评审口径的微调，而是决策人换了

公开招标文件里技术评分权重从四成降到两成五，与决策人更换发生在同一个季度。两件事同时发生，更像同一件事的两个表现。

## 二、我们靠模型能力带动成单的那条链断了一环

能力更强因此会被选中，这条链依赖技术评估是主要门槛。门槛移走之后，能力仍然是必要条件，但不再是胜负手。

## 对我们的当前含义

短期要确认另外两个行业的权重有没有同样在降。中期要看的是，进入业务线视野需要的是什么，而不是继续加深能力差。

## 最终判断

标题那句话现在成立到「当前更支持」这一档。若另外两个行业的技术评分权重没有同步下降，它就退回成这一个行业的局部现象。

## 未能核实的部分

另外两个行业同期的招标口径本轮没有取到。缺这一条，标题那句话只能按这一个行业成立，跨行业的推广要打对折。

## 决定性证据

投标记录：两个已投标客户的决策人在近一个季度换成业务线负责人。它把这条判断从推测变成有内部依据的判断。

外部取回的口径数据[E1]：它给出了本轮唯一一条带统计期间的现状数字，排掉了「口径没变只是叙事在变」这个替代解释。

外部材料的自述[E2]：它说明本轮取回的材料只是占位件，因此上面那条数字只能用来验证链路，不能用来支撑经营结论。`,
  /*
   * 第二条链路写的那一份原件（`alt` 槽位，屏幕上是「Claude」那一栏）。
   *
   * 键名从 `a4.report.alt` 改成 `a4.report.claude`，跟着这一栏 2026-08-25 换的那个模型走：
   * 罐头的键就是链路的 hint，写成槽位名的话，下一次换模型时这份正文会原地留下来 —— 而它
   * 的立场是照当时那个模型写的。旧键**不许留着**：两个键并存时离线跑到的是哪一份取决于
   * 谁先被查到，而两份正文不一样。
   *
   * 它和上面那份的**硬要求完全一样**（引真编号、有「未能核实的部分」、不写「未联网」），
   * 因为各条链路走的是同一道出口对账。但正文要写得看得出是几份不同的东西：小标题、口径、
   * 收口那句话都不一样，而且这一份的结论比 DeepSeek 那条保守一档 —— 罐头要验的正是「屏幕
   * 上那几栏是各条链路各写的一份」，几份一字不差的话，页签切过去看起来像是渲染错了。
   *
   * **不要把它写成另一份的改写**。几份原件在这个产品里的用处是对照，而对照的前提是它们
   * 真的可能不一致。
   */
  "a4.report.claude": `决策权是否转移尚未定论，但技术评分不再是唯一门槛这一点已经可以确认

## 核心判断

按现有材料，只能确认技术评分的权重在下降，还不足以确认采购决策权已经完成转移。两个客户、一个行业、一个季度，这个样本支撑得起前半句，支撑不起后半句。

## 一、权重下降与决策人更换同期发生，但同期不等于同因

这两件事都发生在近一个季度。可它们也可以各有来路：评分模板改版是行业层面的动作，决策人更换是客户内部的人事安排。本轮没有材料能把这两条分开。

## 二、真正被动摇的是「能力差可以自动兑现成订单」

无论决策权在谁手上，能力差要兑现都得经过一道翻译。以前那道翻译是技术评分，现在它至少不再是唯一的一道。这一条不依赖决策权归属，所以它比标题那句更硬。

## 对我们的当前含义

本季度不必改定位，但要改验证方式：在下一次投标里直接观察谁在提问、谁在拍板，这比再收集一轮公开文件更快。

## 最终判断

标题那句成立。若另外两个行业出现同向的权重下降，前半句会升格为「决策权正在转移」；若没有，本轮所见就是这一个行业的局部调整。

## 未能核实的部分

另外两个行业同期的招标口径本轮没有取到，客户内部人事变动的原因也没有取到。缺前者，跨行业推广不成立；缺后者，「同期」和「同因」分不开。

## 决定性证据

投标记录：决策人在近一个季度更换。它把「门槛可能变了」从猜测抬到了值得投入验证的一档。

外部取回的口径数据[E1]：本轮唯一一条带统计期间的现状数字，它排掉了「口径没变、只是叙事在变」这一种解释。

材料自身的说明[E2]：取回的这一页自称是占位件，所以上面那条数字只能验证链路是否通畅，不能进经营结论。`,
  /*
   * 第三条链路写的那一份原件（`synth` 槽位，屏幕上是「ChatGPT」那一栏）。
   *
   * 键名从 `a4.report.synth` 改成 `a4.report.gpt`，因为 2026-08-25 这一栏换了身份：它原来
   * 是「多模型报告」——读完前面两份再合出一份；现在它是**第三条独立链路**，自己编命题、
   * 自己联网取证、自己写。旧那份罐头是照着合成写的（开头一句就是「同一批材料支撑得起两种
   * 读法」），留着会让离线跑出来的屏幕看起来还是老设计。
   *
   * 硬要求同上面两份（引真编号、有「未能核实的部分」、不写「未联网」）—— 几份过的是同一
   * 道出口对账。这一份自己那两条（下面新接的那两条链路照它办）：
   *
   *   · **一个字都不许提到别的几份**（「第一份」「另一份报告」「两种读法」之类）。它不知道
   *     别人写了什么 —— 它跑的时候那几条还在跑。写成对照表的话，离线屏幕上就在演一个这
   *     一版已经不存在的步骤。
   *   · 结论要和别的几份**都不一样**，而且分歧要落在**取回的材料**上而不只是措辞上：屏幕
   *     上这几栏的用处就是让「有一条链路漏掉了某个来源」看得见，几份结论一致的罐头验不出
   *     这件事。这一份走第三种立场 —— 权重下降是行业性的模板改版，与决策人更换无关。
   *
   * 判断板和四节压缩从这一条压出来（`PRIMARY_SLOT = "synth"`），但四节那份罐头是单独的
   * 一条（`a4.digest`）—— 离线不会真去读这份正文。
   */
  "a4.report.gpt": `技术评分权重的下降是行业性的模板改版，把它读成我们这两个客户的决策权转移，会指错下一步

## 核心判断

更支持的读法是：评分权重下降来自招标模板的一次行业性改版，它和这两个客户的决策人更换是同期发生的两件事。它的边界是本轮只取到一条带统计期间的外部数字，还不足以把「行业性」钉死。

## 一、权重从四成降到两成五这个幅度，不像单个客户能定的

评分权重是招标文件的模板项。两个不同客户在同一个季度改出同一个幅度，比「两家各自决定这么改」更容易由一次模板改版解释。这一条不需要知道谁在拍板就能成立。

## 二、决策人换成业务线负责人，可能是结果而不是原因

模板改版之后技术分不再是主要区分项，采购这件事的重心自然移到预算和交付上，而那两样本来就归业务线。若是这个次序，那么「决策权转移」是模板改版的下游现象，对它做的任何应对都会晚一个季度。

## 对我们的当前含义

要问的不是「决策权在谁手上」，而是「这份模板还会不会继续改、由谁改」。前者在下一次投标里就能看到，但看到了也只是这两家的事；后者决定我们要不要在行业标准这一层投人。

## 最终判断

标题那句话成立到「更支持」这一档。若另外两个行业的权重没有同步下降，行业性这个前提就不成立，本轮所见退回成这两个客户各自的调整。

## 未能核实的部分

招标模板由谁维护、近一年改过几版，本轮没有取到；另外两个行业同期的权重也没有取到。缺前者，「模板改版」只是一个更省事的解释而不是有依据的结论；缺后者，行业性无从判断。

## 决定性证据

外部取回的口径数据[E1]：本轮唯一一条带统计期间的现状数字。它给了一个可以对照的时间点，因此「同一季度」这件事不再只是印象。

投标记录：两个客户的决策人都在近一个季度更换。同幅度、同期、跨客户，这三件一起出现才是把解释推向模板层的理由。

材料自身的说明[E2]：取回的这一页自称是占位件，所以上面那条数字只能用来验证链路是否通畅，不能进经营结论 —— 这也是上面把模板维护方列为主要缺口的原因。`,
  "a4.digest": {
    judgment: [
      {
        text: "采购决策权已经移到业务线，技术评分不再是主要门槛。",
        traces: [{ kind: "int", source: "投标记录" }],
      },
    ],
    keyEvidence: [
      {
        text: "两个已投标客户的决策人换成业务线负责人，技术评分权重同期下降。",
        traces: [{ kind: "ext", source: "公开招标文件" }],
      },
      // 带一个真编号，`traces` 故意留空：离线也要走一遍 `gate.bindCitations`
      // ——「编号换成可点开的溯源」这一段没被执行过的话，线上第一次跑才发现绑不上。
      { text: "外部取回的口径数字为 1590 EFLOPS，统计截至 2025 年末[E1]。", traces: [] },
    ],
    counters: [
      {
        text: "样本只有两个客户，可能是这一个行业的局部现象。",
        traces: [{ kind: "agent", source: "本轮深研" }],
      },
    ],
    unknowns: [
      { text: "另外两个行业的权重有没有同样在降。", traces: [{ kind: "agent", source: "本轮深研" }] },
    ],
    routeSuggestion: "值得升级成一次正式讨论：它动的是获客路径本身。",
  },
  "a4.challenge": {
    counters: [
      {
        text: "权重下降也可能是这一年招标模板的统一改版，与决策权归属无关。",
        traces: [{ kind: "ext", source: "招标模板改版说明" }],
      },
    ],
  },

  /* ---- 深研 v2 那七个节点（`a4/pipeline.ts`）---------------------------- */

  /**
   * N0 主体卡。三条硬账都过：行业定义超过 11 个字、业务构成非空、权重过线的在建项目
   * 名字能在行业定义里找到（`cardGaps`）。写成过不了的样子会让离线每一轮都先补正一次，
   * 而那一次补正交回来的还是同一份 —— 屏幕上表现成「模型不听话」，实情是罐头写错了。
   */
  "a4.anchor": {
    subject: "维信诺",
    segments: [
      { name: "柔性 AMOLED 手机面板", weight: "收入主体", lifecycle: "现金流" },
      { name: "中尺寸 IT 与车载显示", weight: "战略权重", lifecycle: "投入期" },
    ],
    projects: [
      {
        name: V2_HEAVY,
        investment: "（假模型）构造的投资额，本轮没有核过",
        onlineAt: "未来两三年内",
        techRoute: "光刻类图形化",
        heavy: true,
      },
    ],
    customers: "整机品牌为主，车载走 Tier 1",
    industry: V2_INDUSTRY,
    window: "当前时点 ± 未来 3 年",
  },

  /**
   * N1 先验草稿。八维一行，断言三样标注填齐，「我知道我不知道的」六条（下限五条）。
   *
   * 内容是**构造的行业常识**，不是这一轮查来的：每一条都能在离线跑里被后面的节点当成
   * 「未验证的先验」处理，那正是这一支要跑通的那条路（`P` 降 `P!`，不删）。
   */
  "a4.draft": v2Jsonl([
    { type: "draft_meta", thesis: "这一行的胜负手已经从手机换机周期移到中尺寸的良率经济性上" },
    ...V2_SECTIONS.map((sec) => ({
      type: "draft_section",
      dim: sec.dim,
      thesis: sec.thesis,
      body: sec.body,
      assertions: sec.assertions.map((a) => ({
        text: a.text,
        tag: "P",
        confidence: a.confidence,
        timeSensitive: a.timeSensitive,
        loadBearing: a.loadBearing,
      })),
    })),
    {
      type: "draft_unknowns",
      items: [
        "中尺寸 AMOLED 在 IT 应用上最近四个季度的实际出货面积",
        `${V2_HEAVY} 的爬坡良率与设备到厂进度`,
        "光刻类路线在中尺寸上的单位面积成本与蒸镀的实际差额",
        "驱动芯片在下一年度的产能排期",
        "整机客户对中尺寸面板的认证通过情况",
        "上一轮扩产产能在当前时点的消化程度",
      ],
    },
  ]),

  /**
   * N2 检索计划。每维两条命题（`planGaps` 的下限），每条两类来源、一条反向问法。
   *
   * 命题的陈述**和草稿里那几条断言逐字相同** —— 这一支的规矩是「命题只从草稿里抽」，
   * 罐头照这条规矩来，对账那一步才对得上。
   */
  "a4.plan": { propositions: V2_PROPS },

  /**
   * N4 逐条对账。四态各出现过，矛盾态一条（十六条里的一条，远低于三成那道线）——
   * 过了三成会触发「退回 N0 重跑一次」，那条路该由单测直接构造，不该每一轮离线都走。
   *
   * 变更日志覆盖草稿里全部十六条断言（`reconcileGaps` 的第一条检查），因为两份罐头
   * 折自同一个 `V2_SECTIONS`。
   */
  "a4.reconcile": v2Jsonl([
    { type: "merged_meta", thesis: "这一行的胜负手已经从手机换机周期移到中尺寸的良率经济性上" },
    ...V2_SECTIONS.map((sec) => ({
      type: "merged_section",
      dim: sec.dim,
      thesis: sec.thesis,
      body: sec.body,
      tags: sec.assertions.map((a) => (a.loadBearing ? "P!" : "P")),
    })),
    ...V2_SECTIONS.flatMap((sec, si) =>
      sec.assertions.map((a, ai) => ({
        type: "change",
        assertion: a.text,
        from: "P",
        // 承重的降 `P!` 并进待核清单；非承重的留 `P`。**没有一条被删**（`reconcile.ts` 头部）。
        to: a.loadBearing ? "P!" : "P",
        state: si === 6 && ai === 1 ? "矛盾" : a.loadBearing ? "未验证" : "证实",
        evidenceIds: [],
      }))
    ),
  ]),

  /**
   * N5 排结构。**离线这一份多半会被 `readOutline` 折掉**：`evidence_ids` 得是这一轮真跑
   * 出来的编号，而一份写死的罐头不可能知道（同 `mock-blocks.ts` 头部那一段）。折掉之后
   * 走的是「折成一节、涵盖全部编号」那条兜底路 —— 那条路本来也该在离线下被走到。
   */
  "a4.layer.outline": {
    thesis_draft: "中尺寸的良率经济性是这一行下一段的胜负手",
    sections: [
      {
        id: "S1",
        title: "增量已经换了面，手机换机周期不再是主要变量",
        question: "面积口径的增量此刻主要由哪几块应用贡献？",
        evidence_ids: [],
        expected_blocks: ["prose", "judgment"],
        min_blocks: 2,
      },
      {
        id: "S2",
        title: "中尺寸的良率经济性决定这条产线接不接得到单",
        question: "光刻类路线要在中尺寸上站住，得先满足什么？",
        evidence_ids: [],
        expected_blocks: ["prose", "judgment"],
        min_blocks: 2,
      },
    ],
    unassigned: [],
  },

  /**
   * N5 分节出稿。**每一节交回来的都是这一份** —— 罐头按 hint 认，认不出这一次写的是哪
   * 一节（`mock-blocks.ts` 靠读提示词里的「节号：」分得开，那份罐头是函数，这张表是静态
   * 的）。所以离线跑完会有一条「跨节重复」的账，那是罐头的已知红，不是链路的问题。
   *
   * 正文那几块**刻意短**：`layerGaps` 的第三条要求附录占到四成以上，而附录那几块在收口
   * 那一次交。正文写长了会让每一轮离线都挂着一条 A4-N07 的 p0，然后打回重写一遍同样的
   * 东西。数字一个都不写：带数字又没绑证据的句子归 A4-B02 判 p0，而编号这一份不知道。
   */
  "a4.layer.section": `{"heading":"增量换了面，不是手机卖得更好了","type":"prose","md":"手机那一块的渗透已经走完了它最陡的一段，面积上的增量此刻主要来自中尺寸的 IT 与车载。这两块的单机面积远大于手机，所以同样的出货台数在面积上不可比。\\n\\n这一段的依据是行业的结构性事实，本轮外部材料没有加进新的时间点。"}
{"type":"judgment","claim":"中尺寸的良率经济性决定这条 AMOLED 产线接不接得到单","confidence":"初步提示","direction":"限定","reasoningSummary":"蒸镀掩膜在中尺寸上构成良率上限，光刻类路线绕开了它但工序更长；两者的差额要靠良率补回来，而良率是这条产线自己的事。","upgradeCondition":"拿到这条产线爬坡阶段的良率区间，或整机客户的认证结论","falsifyCondition":"中尺寸上蒸镀的良率没有出现上限，或光刻类路线的工序成本无法由良率补回","evidenceRefs":["E90"],"internalValidationHooks":["这条产线的爬坡良率记录","中尺寸客户的认证进展"]}
`,

  /**
   * N5 收口。附录那几块都在这里交，所以它比正文长得多 —— `layerGaps` 第三条要的正是
   * 这个比例。`E90` 那一条是模型既有知识（同 `mock-blocks.ts` 的 `MODEL_REF`），**必须
   * 列进证据清单**，不列的话 A4-B06 会判「引了证据表里没有的编号」。
   */
  "a4.layer.closing": `{"type":"report_meta","title":"中尺寸的良率经济性是这一行下一段的胜负手","confidence":"初步提示","dataCutoff":"2026-08-20"}
{"type":"verdict_banner","text":"更站得住的读法是：这家公司未来两三年的位置由那条 AMOLED 产线的爬坡良率和中尺寸客户的认证决定，不由手机换机周期决定。","confidence":"初步提示","boundary":"只对中尺寸这一段成立；本轮外部材料只验证了取证链路，产线自己的数一条都没有。"}
{"type":"judgment","claim":"该盯的是那条 AMOLED 产线的爬坡进度，不是手机面板的季度出货","confidence":"初步提示","direction":"限定","reasoningSummary":"折旧从投产起计而收入要等认证，这个时间差是这一行最典型的亏损区间；它由爬坡进度和认证进展决定，与手机季度出货没有直接关系。","upgradeCondition":"拿到那条产线的设备到厂与爬坡时点，或任一家整机客户的认证结论","falsifyCondition":"这条产线的投产时点推迟到分析时间窗之外，或中尺寸客户认证与产能释放无关","evidenceRefs":["E90"],"internalValidationHooks":["这条产线的爬坡良率记录"]}
{"heading":"这几条本轮没能核实","type":"unverified_panel","items":[{"statement":"那条产线的爬坡良率区间","whyMatters":"缺它，中尺寸能不能接单只能靠推理，接不接得到单是这一份判断的落点","whatWouldSettle":"公司披露里的爬坡说明，或设备到厂与投产时点的公告","impactIfTrue":"若良率进入可量产区间，上面那条判断升一档","impactIfFalse":"若良率长期偏低，中尺寸这条路要重新算"},{"statement":"整机客户对中尺寸面板的认证进展","whyMatters":"缺它，新增产能有没有出口无从判断","whatWouldSettle":"客户侧的认证结论，或公司披露里的中尺寸出货表述","impactIfTrue":"若认证通过，产能释放能对上收入","impactIfFalse":"若认证未通过，投产之后的时间差会拉长"},{"statement":"驱动芯片与发光材料在下一年度的排期","whyMatters":"缺它，扩产计划的实际执行速度没有约束条件","whatWouldSettle":"上游厂商的排期说明，或公司披露里的采购安排","impactIfTrue":"若排期宽松，扩产按计划走","impactIfFalse":"若排期紧张，投产时点要往后推"}]}
{"heading":"这一份用到的材料","type":"evidence_list","items":[{"id":"E90","claim":"蒸镀掩膜的张力问题随基板尺寸放大而恶化，中尺寸上构成良率上限（模型既有知识，本轮没有核验）","sourceName":"既有的显示行业工艺常识","sourceType":"模型既有知识","updateDirection":{"target":"中尺寸的良率经济性","effect":"强化"}}]}
{"heading":"这几个数各自答得了什么、答不了什么","type":"caliber_map","rows":[{"metric":"手机面板季度出货","answersWhat":"现金流那一块此刻的量","cannotAnswer":"中尺寸这条新面走到哪一步","handling":"只用来看现有主业的量，不用来推断战略投入的进展"},{"metric":"那条产线的爬坡良率","answersWhat":"中尺寸能不能量产交付","cannotAnswer":"客户认不认这批面板","handling":"要和客户认证结论配着看，单独一个数不构成结论"},{"metric":"本轮取回的外部材料","answersWhat":"检索、抓页、逐字定位这条链路通不通","cannotAnswer":"这一行的任何一个数","handling":"只用来验证链路，不进经营结论"}]}
{"heading":"什么会推翻这一份","type":"falsify_card","conditions":["那条产线的投产时点推迟到分析时间窗之外","中尺寸上蒸镀的良率没有出现上限","整机客户的认证与产能释放之间没有对应关系"],"monitoringIndicators":["设备到厂与投产时点的公告","中尺寸出货面积的季度变化","上游驱动芯片的排期说明"]}
`,

  /**
   * N6 锚点相关性检查。交的是一句话，不是 JSON（`readAnchorVerdict` 要求去掉空白之后
   * 以「能」开头，而且带一个 `D<n>-P<n>` 的命题号）。
   *
   * 一律答「能」：离线跑要让「过了检查的锚点留在正文里」这条路走通。答「不能」的那一支
   * 由 `anchor-gate.test.ts` 直接测 `stripHooks`，不靠罐头来演 —— 在这里答「不能」的话，
   * 每一轮离线都会把判断块上的内部锚点全摘掉，而那不是这条路的常态。
   */
  "a4.anchor-gate": "能。这条内部锚点和 D8-P1 说的是同一件事：那条产线的爬坡进度。",
  "talk.verify": {
    pass: true,
    why: ["台账里两组独立源都指向这一句"],
  },

  /**
   * 一轮对谈之后的萃取（`a6/extract.ts`）。
   *
   * **补这个键是为了让 A6 那条写板路在离线下跑得到。** 没有它，假模型回的是兜底对象，
   * `formed` 恒为空 —— 于是「对谈里长出一条判断 → 上板」「他在对谈里认下一条」「他开出
   * 一支旁支」这三条写入路径离线一次都走不到。而 A6 这条路与对谈结算那条
   * （`landTalkCandidate`）**写的是同一张判断板**，两条路撞不撞得上、撞上之后回执说什么，
   * 在跑不到的时候连测都没法测。
   *
   * 交一条就够，而且**每个议题只会真的上板一次**：这张表是静态的，同一件议题第二轮交回
   * 来的还是这一句，`boardPush` 按正文前 30 字去重，第二轮起会照实记一行「和板上已有的
   * 重复，没上板」。这是罐头的性质，不是链路的问题。
   *
   * `replaces` 是 null：改写板上某一条要写得出 `changeFrom → changeTo` 的对子，而静态罐头
   * 编不出一个对得上真实板面的对子 —— 编一个的后果是每一轮都声称改写了一条它没读过的判断。
   * `confirms` 是空的：确认是这个产品里唯一一次权力转移，只能由他按下，假模型不许替他按。
   */
  "a6.turn": {
    formed: [
      {
        label: "这一轮的落点",
        statement: "这一轮先按台账上那一句往下走，等下一季度的实测数据到了再动它",
        basis: "这一轮双方都没有拿出新的证据，台账上那一句仍是唯一指得出依据的读法",
        boundary: "只说这一轮不动它，不主张长期不动",
        reopenIf: "拿到下一季度的实测数据，或者出现一条与台账相反的公开口径",
        by: "agent",
        replaces: null,
        changeLabel: "",
        changeFrom: "",
        changeTo: "",
      },
    ],
    confirms: [],
    ceoChallenge: "他追问这一句到底凭什么成立",
    aside: null,
  },

  /**
   * 预研里实体归一与靶点匹配那一次。`targetId` 是个编号，对不对得上取决于这一轮
   * 真喂进去的靶点清单 —— 对不上时 `matchTargets` 会照实丢掉并记一条账，
   * 那是罐头的性质，不是链路的问题。
   */
  "a3.targets": {
    entities: [{ name: "智谱 AI", kind: "company" }],
    hits: [{ targetId: "J-2", match: "challenges", why: "[P] 这家公司做的正是那条判断里说不会出现的新玩家" }],
    magnitude: "material",
  },
  /**
   * 预研里影响提案那一次。罐头写 `weakens` 不写 `overturns`：离线这一轮凑不出两组
   * 独立源，写成推翻只会每次都被机械降档，台账上白多一条降档记录。
   * `basis` 里留一条 `[P]` —— 先验依据是要用的，罐头也得把它标出来的样子跑出来。
   */
  "a3.impact": {
    impactType: "weakens",
    proposalType: "adjustJudgment",
    targetId: "J-2",
    statement: "那条判断要把「不会有新玩家」收窄成「不会有做同一档客户的新玩家」",
    basis: ["E1", "[P] 这家公司过去两年只做海外市场"],
  },
  /**
   * 预研里那一次异系批判。罐头写通过：机检不过的那几档根本走不到模型这一步
   * （`criticize` 直接打回），所以离线能跑到这里的只有机检已经过了的那一档。
   */
  "a3.critic": {
    pass: true,
    checks: [],
    why: ["前提用对了，结论和结尾指向同一个方向，没有从一家公司跳到整个市场"],
  },
};

export const modelMockOn = (): boolean => process.env.TKOS_MODEL_MOCK === "1";

/**
 * @param messages 这一轮真发出去的消息。区块那一支的罐头要读它 —— 那份 JSONL 得对着
 *   这一轮真跑出来的证据编号交账（见 `mock-blocks.ts` 头部）。给默认值是因为大部分
 *   调用点和单测只按 hint 认罐头，用不着它。
 */
export function mockText(hint: string | undefined, messages: MockMsg[] = []): string {
  /*
   * 区块那一支先问。它认的键和散文那张表**没有交集**（三段各带 `.outline`/`.section`/
   * `.closing` 后缀），唯一重叠的是链路自己那个 hint —— 那一个只在返修轮命中，判据是这一轮
   * 的提示词里有没有「出口校验没过」。所以关掉区块开关时这一问一律落空，散文罐头照旧。
   */
  const blocks = blockCanned(hint, messages);
  if (blocks) return blocks;

  /*
   * 「查一下」那一次作答（`talk/check.ts`）。**罐头得读这一轮真拿到的编号**，理由同
   * 区块那一支：这几条是刚落进台账、刚重排过号的，写死一个 `[E1]` 的罐头会让离线跑
   * 永远在编造引用 —— 而这条路唯一要守的规矩就是「编号只许从手上那几条里取」。
   * 一条都没有时不该走到这里（`answerFromCheck` 那时直接走查不到那一支），真走到了
   * 就交一句不带编号的话，让上层那道「引了台账里没有的号」的对账看得见。
   */
  if (hint === "talk.check") {
    const ids = [
      ...new Set(
        messages
          .map((m) => m.content)
          .join("\n")
          .matchAll(/^(E\d+)｜/gm),
      ),
    ].map((m) => m[1]);
    return ids.length
      ? `（假模型）这一轮现查回来的材料支持这个说法${ids.map((id) => `[${id}]`).join("")}。`
      : "（假模型）这一轮的材料答不到这个问题。";
  }

  /*
   * 交上来的材料有没有用（`a7/intake.ts`）。**默认判有用** —— 离线跑的主路是「材料收下、
   * 提炼接着跑」，判没用会让后面那一整段在离线永远走不到。
   *
   * 但判没用那一档也必须走得到：它决定不花提炼那一大笔，也决定屏幕上那句原话。所以留一个
   * **只在离线成立的记号** —— 材料里出现「不是会议记录」这几个字就判没用。假模型分不出
   * 一段话像不像一场会，硬编一个「像不像」的规则出来，只会让离线跑演示一条真模型根本不走
   * 的判法；而记号是记号这件事，写在这里就看得见。
   */
  if (hint === "a7.intake") {
    const body = messages.map((m) => m.content).join("\n");
    return body.includes("不是会议记录")
      ? JSON.stringify({
          usable: false,
          reason: "（假模型）这份材料里写着它不是会议记录，跟这场会那几件议题一件都对不上。",
        })
      : JSON.stringify({
          usable: true,
          reason: "（假模型）读起来是几个人在会上说的话，谈的事跟这场会的议题对得上。",
        });
  }

  /*
   * 会后提炼（`a7/debrief.ts`）。同上一支的理由：**罐头得读这一轮真拿到的议题号**。
   *
   * 写死一个 `ISS-000` 的话，A7 那道「指到了不在这场会上的议题号就丢掉」的闸会把整轮
   * 提炼全部丢光 —— 于是离线跑出来的结果永远是「这场会什么都没谈出来」，而那恰恰和
   * 一场只有寒暄的会长得一模一样。分不出来，这条路就等于没跑过。
   *
   * `due` 一个都不给：那一样只有会上真的说了时间才准填（A7 的三条硬规矩之一），而假
   * 模型手上没有任何具体的时间点 —— 编一个出来，离线跑就会一直在演示「它会编期限」。
   *
   * `owner` 分两种情况。**默认也不给**，理由和 `due` 一样：假模型手上没有除了一号位
   * 自己之外的任何真实人名，编一个出来，离线跑就会一直在演示「它会编负责人」。
   * **但转写正文里如果真的写着一号位自陈接下了这件事的那句话（「我来」），就把它原样
   * 搬到 `owner` 上。** 这不是在编：上一句「编一个出来」说的是凭空生成一个转写里从
   * 没出现过的名字，而这句话字面上就躺在转写正文里 —— A7 自己的规矩反过来要求这种
   * 情况必须填（`a7/debrief.ts`：「会上点了名就一定要填……漏掉一个，这条待办就没人
   * 认领了」）。罐头如果对着这句明摆着的话装看不见，演示的就不再是「假模型比真模型
   * 更保守」，而是「假模型比真模型更不老实」—— 那才是这条链路真正不该演示的样子。
   *
   * 同一条「不编手上没有的东西」的理由决定了另外两样怎么给：**只有第一条要点带
   * `boundary`**（第二条不带，让「会上没划边界就没有这个字段」那一支在离线跑里也被
   * 走到），**`consensus.reached` 恒为 `false` 且 `open` 至少一条**（多数会议就是没
   * 谈拢的，给 `true` 会让离线跑的每一张卡都默认高亮确认键 —— 那是这条链路最不该
   * 演示的样子）。
   *
   * ## 为什么是两条待办，而且 `principal` 一真一假
   *
   * 相三之后，面板右栏是**上下两层**：上层摆要他拍板的，下层摆点了他名的执行项。
   * 罐头只给一条待办的话，离线跑永远只有一层有东西 —— 而一层空着和「这一层坏了」
   * 在屏幕上长得一模一样，于是这条链路等于只跑过一半。所以两条：一条是只有他能做的
   * 选择（`needed` 为 true），一条是路已经定了、剩下照着做的（`needed` 为 false）。
   *
   * `owner` 那句「我」两条都挂，看起来像是把他一句话认成了两件事，其实不是：这两条
   * 待办的正文本来就**不是从转写里读出来的**（它们是写死的），转写里被读的只有
   * 「他自陈接了活没有」这一件事。所以「我」挂在哪几条上不是一次事实判断，而是这一轮
   * 要走哪几条路 —— 而两层都要有东西，才走得完。上面那段拒绝编 `owner` 针对的是
   * **凭空生成一个转写里没有的人名**，这里一个新名字都没有多出来。
   *
   * 两条的 `principal` 都写全（`needed` + `reason`）：判不出来那一支不在这里演示，
   * 它由 `resolvePrincipal` 的兜底负责，在单测里走（`store.action-items.test.ts`）。
   * 罐头故意交一份缺 `principal` 的待办反而会把两件事搅在一起 —— 离线跑再也分不出
   * 「模型判了要他拍板」和「模型压根没判、兜底把它推给了他」。
   *
   * 同一条理由给了 `label`：两条都写实在的短标签，离线跑才会走到「模型自己起了名字」
   * 这条真实路径，而不是每次都落到 `resolveLabel` 的兜底。
   */
  if (hint === "a7.debrief") {
    const body = messages.map((m) => m.content).join("\n");
    const ids = [...new Set(body.matchAll(/^### (ISS-[A-Za-z0-9-]+)｜/gm))].map(
      (m) => m[1],
    );
    /*
     * 判「转写里是不是真写着一号位自己接下了」，只用一个字面上的短语（「我来」，
     * 也认「我自己来」），够简单、够可复现，不必真的理解语义。这不是在替代
     * `resolveTodoAssignee`（那个函数判的是 `owner` 字段本身是不是一号位）——这里判
     * 的是更早一步：转写正文里有没有这句话，值不值得把它当成 `owner` 递出去。
     *
     * **这条正则只测转写本体，不测 `body`（system + user 拼起来的那一份）。**
     * `a7/debrief.ts` 的 `buildUser` 把转写放在 `## 录音转写` 这个标题之后
     * （其余部分是这场会的议题清单），这里从那个标题往后截，只在这一段里找「我来」。
     * 相三的规格明确要往 `a7/debrief.ts` 的 SYSTEM 里加一句「一号位说『我来做 X』
     * 也算点了名」——那句话一旦落地，如果这里继续测 `body`，会把 **system 提示词自己
     * 的措辞** 当成会上真说过的话，让离线跑的每一条待办都判给一号位（`owner: "我"`），
     * `store.action-items.test.ts` 里"别人说的不算"那条断言会先红，接着每一次离线
     * 演示都会把不该派给他的事安到他头上——这正是 `todo-assignee.ts` 那一整套判人
     * 逻辑要防的错。
     */
    const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
    const transcriptStart = userMsg.indexOf("## 录音转写");
    const transcript = transcriptStart >= 0 ? userMsg.slice(transcriptStart) : userMsg;
    const selfAssigned = /我(自己)?来/.test(transcript);
    return JSON.stringify({
      debriefs: ids.map((id) => ({
        issueId: id,
        summary: "（假模型）口径这一层定了，成本那一档还卡在实测数据上",
        /*
         * 这一段是**任务**，不是会上定下来的结论（口径见 `a7/debrief.ts` 文件头）。
         *
         * 换过一次：上一版这两条是「会上把口径定了下来」「成本那一档还没有定」——
         * 前者读完没有下一步，后者更糟，它正撞上出口机检那条「未决不许写成任务」
         * （A7-08，p0）。于是离线跑的每一轮都稳定多出一条 p0 台账记录，而那条记录
         * 说的是罐头的毛病，不是被测那条链路的。**一份会稳定报错的罐头等于一个假警报**，
         * 而假警报会训练人不看台账。
         */
        points: [
          {
            text: "（假模型）按台账上那一句把对外口径写成一页纸，本周内发给三个域各自确认",
            boundary: "（假模型）只写口径怎么表述，覆盖到哪几条产品线不在这一版里",
          },
          {
            text: "（假模型）把下一季度实测数据的采集口径定下来，说清取哪几个字段、谁的库",
          },
        ],
        todos: [
          {
            text: "定下成本那一档对外按哪个口径报",
            ...(selfAssigned ? { owner: "我" } : {}),
            principal: {
              needed: true,
              reason: "（假模型）两个口径各有各的代价，选哪一个只有他能定。",
            },
            label: "成本口径拍板",
          },
          {
            text: "把下一季度的实测数据口径先落成一页纸",
            ...(selfAssigned ? { owner: "我" } : {}),
            principal: {
              needed: false,
              reason: "（假模型）口径会上已经按台账那一句定了，这条剩下的是照着写。",
            },
            label: "数据口径整理",
          },
        ],
        open: ["（假模型）成本那一档按哪个口径算，下一轮要带实测数据回来"],
        consensus: {
          reached: false,
          reason: "（假模型）口径这一层落了锤，成本那一档还依赖没到手的实测数据",
        },
      })),
    });
  }

  /*
   * 扫描那两步的罐头是**现算的**，不是写死的对象。
   *
   * 两步都要「答的编号对得上问的编号」：拟检索式那一步回的 `kiq` 必须是策略正文里真有的
   * 那几个编号（`queries.ts` 的 `clean` 会把对不上的丢掉），研判那一步回的 `i` 必须落在
   * 这一批的条数里（`triage.ts` 的 `collect` 同理）。写死一份罐头，这两道校验在离线跑里
   * 就全部走空 —— 而它们正是这条链路最容易出错的地方。
   */
  if (hint === "scan.queries") {
    const body = messages.map((m) => m.content).join("\n");
    const codes = [...new Set([...body.matchAll(/^-\s+(KIQ\S+)/gm)].map((m) => m[1]))];
    return JSON.stringify({
      queries: codes.slice(0, 12).map((kiq) => ({ q: `（假检索式）${kiq}`, kiq })),
    });
  }
  if (hint === "scan.triage") {
    const body = messages.map((m) => m.content).join("\n");
    const ns = [...body.matchAll(/^【(\d+)】/gm)].map((m) => Number(m[1]));
    return JSON.stringify({
      items: ns.map((i) =>
        // 隔一条淘汰一条：过线的那几条和够不上门槛的那几条在离线跑里都要有。
        i % 2 === 0
          ? { i, reject: "（假模型）纯营销通稿" }
          : {
              i,
              dimensions: { 假设关联: 5, 影响幅度: 4, 时间窗: 4, 新颖度: 4, 可行动: 3 },
              kiq: "KIQ1.1",
              why: "（假模型）若为真，说明这条假设要重估。",
              suggested_issue: "（假模型）要不要现在跟？",
            },
      ),
    });
  }

  const hit = hint ? CANNED[hint] : undefined;
  // 字符串罐头原样返回：那几条链路要的是正文，不是 JSON。见上面 `a4.report` 处的注释。
  if (typeof hit === "string") return hit;
  /*
   * 抽取那一条要**把真命题编号回填进去**。
   *
   * 罐头里写死的是 `P1`，而真检索计划编出来的是 `D1-P1`、`D2-P1` 这种带维度前缀的号
   * （`plan.ts`）。两边对不上的后果不是少几条证据 —— 是 `coverageTable` 按
   * `propositionId` 配对时**一条都配不上**，于是离线跑的覆盖表恒为八维零组，
   * 而「入账 → 折叠 → 覆盖判定 → 出口对账 → 补旁证」这一整条**一次都没被真正执行过**。
   * 屏幕上看起来只是「这题没搜到东西」。
   *
   * 上面那条注释想要的是「第一条闭合、第二条闭不合」，回填之后那个意图才真的成立：
   * 现在是全都闭不合。
   */
  if (hint === "a4.extract" && hit) {
    const asked = /^([A-Za-z]\d+-[PC]\d+)[：:]/m.exec(
      messages.map((m) => m.content).join("\n")
    )?.[1];
    if (asked) return JSON.stringify(hit, (k, v) => (k === "propositionId" ? asked : v));
  }
  if (hit) return JSON.stringify(hit);
  /*
   * 认不出就给一个能 parse 的兜底，**不抛**。抛的话，一条还没登记罐头的链路
   * 在 mock 下表现成「模型挂了」，而真正的问题是罐头没写 —— 两件事要分得开。
   */
  return JSON.stringify({
    note: `（假模型）没有为 ${hint ?? "（未给 hint）"} 准备罐头，返回的是兜底对象。`,
  });
}
