/**
 * 区块化报告的形状。**这一份只定形状，不渲染、不判纪律。**
 *
 * 落库的规范形态是 JSON，屏幕上那一份是它的视图。这么定的收益不在好看：判断板取条目、
 * 跨轮比对同一条判断是升级了还是翻转了、以后换一套组件重渲染，都变成读字段，而不是
 * 再拿正则去扫一遍中文正文（`gate.ts` 现在干的就是后者）。
 *
 * ## 为什么是 JSONL，一行一个块
 *
 * 出稿这一步原来是刻意不套 JSON 模式的：整篇报告塞进一个字符串字段，两千多字中文
 * 转义一次，任何一处裸引号或换行都让整份 parse 不出来。一行一个块把这件事的粒度改了 ——
 * 坏掉的是**那一个块**，别的块照旧读得出来，而且重发只重发那一个，不重写整篇。
 * 边跑边出也只有这个形态支持：整块 JSON 要等最后一个字节才知道是不是合法的。
 *
 * ## 字段名一律 camelCase
 *
 * 任务书里写的是 snake_case。这个仓库对模型的契约从头到尾是 camelCase
 * （`exactQuote`、`supportRelation`、`materialityWeight`），一句提示词里混两套命名的
 * 结果是字段被写成另一种拼法然后静默丢掉。`type` 那几个值保持任务书的原样
 * （`verdict_banner`、`kpi_cards`）—— 那是块的名字，不是字段名。
 *
 * ## 证据的元数据不由模型填
 *
 * 事实归台账所有（HP-2）。模型只写两样：引哪个编号，以及这条证据强化/削弱/限定了
 * 哪一条判断。来源、档次、时点、地址、独立性组全部从台账映射过来（见 `registry.ts`）——
 * 让模型重填一遍已经确定的事实，等于给它一次改写事实的机会，而改写出来的那一份和
 * 真的那一份在屏幕上长得一样。
 *
 * 台账里没有的编号不是错误：模型自己的既有知识可以入列，但一律 `verified: false`、
 * `sourceType: 模型既有知识`、`origin: "model"`。禁止的是**匿名混进正文** ——
 * 一个没有编号的记忆里的数字，措辞精确、无从对账。
 *
 * ## 收得宽，拒得准
 *
 * 这一层只在「这一行压根不是一个块」时拒（不是对象、type 不认识、内容整个是空的）。
 * 缺 `falsifyCondition` 这类**违纪**不在这里拒 —— 在这里拒的表现是那个块凭空消失，
 * 而重写那一轮拿不到可指认的对象；那几条归 `lint.ts`，它报的是「第 3 个块缺证伪条件」。
 */

/* -------------------------------------------------------------------------- */
/* 枚举                                                                        */
/* -------------------------------------------------------------------------- */

/** 置信四挡。和报告正文里那四挡是同一套说法（`prompt.ts` 的 `STYLE`）。 */
export const CONFIDENCES = ["初步提示", "当前更支持", "较强支持", "接近确证"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

/** 这条判断和标题那句命题的关系。 */
export const DIRECTIONS = ["支持", "反对", "限定"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/**
 * 谁在说这句话。比台账的 `authorityClass` 多三档：内部文档、模型既有知识、来路不明。
 *
 * 「来路不明」不在任务书那张表上，是从台账那一档 `other` 折过来的 —— 文库、个人发布
 * 这种无人担责的域名。任务书那八档里没有一个装得下它：硬塞进「媒体转述」等于给一份
 * 上传到文库的 PPT 记一个媒体来源，而那份 PPT 里写着「工信部数据」也仍然是一份来路
 * 不明的 PPT。
 */
export const SOURCE_TYPES = [
  "官方一手",
  "公司披露",
  "学术论文",
  "行业机构",
  "媒体转述",
  "厂商宣传",
  "内部DOC",
  "模型既有知识",
  "来路不明",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const GRADES = ["A", "B", "C"] as const;
export type Grade = (typeof GRADES)[number];

/** 分层表那一列的可信度。`E` 是「估算」——它不在证据档次里，是这一格自己的性质。 */
export const ROW_GRADES = ["A", "B", "C", "E"] as const;
export type RowGrade = (typeof ROW_GRADES)[number];

export const UPDATE_EFFECTS = ["强化", "削弱", "限定"] as const;
export type UpdateEffect = (typeof UPDATE_EFFECTS)[number];

export const ADJUDICATION_STATUSES = ["已裁决", "待裁决", "欠定"] as const;
export type AdjudicationStatus = (typeof ADJUDICATION_STATUSES)[number];

/**
 * 怎么裁决这处分歧。三分法：可核查的事实去核查；证据已经闭合但缺一次算账的走程序；
 * 证据欠定的只有两条出路 —— 要内部数据，或者承认这是一条先验判断。
 *
 * 分得清才有意义：把「欠定」写成「待裁决」，读的人会以为再查一轮就有答案。
 */
export const ADJUDICATION_METHODS = ["事实核查", "程序执行", "需内部数据", "先验判断"] as const;
export type AdjudicationMethod = (typeof ADJUDICATION_METHODS)[number];

/** 这条证据是过了台账的，还是模型自己说的。**由代码填，模型写什么都不算。** */
export type EvidenceOrigin = "ledger" | "model";

export type UpdateDirection = { target: string; effect: UpdateEffect };

/* -------------------------------------------------------------------------- */
/* 证据                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 报告里那一枚编号背后的东西。全报告统一编号，`E` 开头的来自台账。
 *
 * `independenceGroup` 相同的几条在屏幕上要合并成「共源×3」：不合并的话，同一篇稿子的
 * 三份转载会呈现成三条独立证据 —— 那是这套东西最容易骗过自己的一种方式。
 */
export interface BlockEvidence {
  id: string;
  /** 这条证据在这份报告里支撑的那句话。模型写的（同一条证据在两份报告里支撑的可以不同）。 */
  claim: string;
  sourceName: string;
  sourceType: SourceType;
  /** 本轮是否联网核验过原文。台账里的条目必然为真（引句逐字定位过），别的一律为假。 */
  verified: boolean;
  retrievedAt: string;
  url?: string;
  independenceGroup: string;
  grade: Grade;
  origin: EvidenceOrigin;
  /** 它强化/削弱/限定了哪一条判断。模型写的 —— 这是它唯一说得清的一栏。 */
  updateDirection?: UpdateDirection;
}

/* -------------------------------------------------------------------------- */
/* 十五种块                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 每个块都可以起一节。
 *
 * `heading` 非空的块在章节导航里占一行 —— 导航是从块里数出来的，不是另外写一份目录，
 * 所以不会出现「目录里有这一节，正文里没有」。写它的时候标题本身就是判断（S03 §6），
 * 「市场情况」这种类目名等于没写。
 */
interface BlockBase {
  heading?: string;
  /**
   * 模型没给、由这一层填了默认值的字段名。
   *
   * 存在的理由只有一个：**「写了初步提示」和「压根没写分档」在读完之后长得一样**。
   * 缺分档要在 `lint.ts` 里被拒（§4.2），而拒的前提是分得出这两种。所以填默认值的
   * 同时留一条记账，不靠把字段变成可选的来表达缺失 —— 可选字段会让渲染层和判断板
   * 各写一次「没有的时候显示什么」。
   */
  defaulted?: string[];
}

/** 核心判断横幅。一份报告只该有一个 —— 两个横幅等于没有结论。 */
export interface VerdictBannerBlock extends BlockBase {
  type: "verdict_banner";
  text: string;
  confidence: Confidence;
  /** 这个判断在什么范围内成立。一句话。没有边界的判断没法证伪。 */
  boundary: string;
}

export interface KpiCard {
  /** 显示什么就写什么（`1.2–1.8`、`约 60`）。它不参与计算，所以不是数字类型。 */
  value: string;
  unit?: string;
  label: string;
  /** 口径脚注。这个数答的是哪一问 —— 缺了它，两个不同口径的数会被放在一起比。 */
  caliberNote: string;
  delta?: string;
  evidenceRefs: string[];
}

export interface KpiCardsBlock extends BlockBase {
  type: "kpi_cards";
  cards: KpiCard[];
}

/** 口径防火墙表。每个指标答得出什么、答不出什么、这份报告怎么处理它。 */
export interface CaliberMapBlock extends BlockBase {
  type: "caliber_map";
  rows: { metric: string; answersWhat: string; cannotAnswer: string; handling: string }[];
}

export interface LayeredTableBlock extends BlockBase {
  type: "layered_table";
  columns: string[];
  rows: string[][];
  /** 每一行的可信度，和 `rows` 等长。给不齐就整列不显示，不半列半空。 */
  rowGrade?: RowGrade[];
  evidenceRefs: string[];
}

/** 漏斗。装机→上架→可调度→有效产出 这一类，每一级掉了多少是它要说的话。 */
export interface FunnelBlock extends BlockBase {
  type: "funnel";
  stages: { label: string; value: number; note?: string }[];
}

export interface BarCompareBlock extends BlockBase {
  type: "bar_compare";
  items: { label: string; value: number; note?: string }[];
  /**
   * 这几项只可比较、不可相加。为真时屏幕上不画总量、不算占比 ——
   * 「三家份额加起来 140%」这种图是这么来的。
   */
  nonAdditive?: boolean;
}

export interface ScenarioCardsBlock extends BlockBase {
  type: "scenario_cards";
  cards: { name: string; assumptions: string[]; keyNumbers: string[]; triggerIndicators: string[] }[];
}

/** 散文段。行内 `[E1]` 渲染成证据芯片，编号本身留在原文里。 */
export interface ProseBlock extends BlockBase {
  type: "prose";
  md: string;
}

/**
 * 判断板条目的来源块。
 *
 * `falsifyCondition` 和 `upgradeCondition` 是两件事：前者说什么会推翻它，后者说什么会
 * 让它升一档。只有前者的判断永远升不上去，只有后者的判断永远推不倒。
 */
export interface JudgmentBlock extends BlockBase {
  type: "judgment";
  claim: string;
  confidence: Confidence;
  direction: Direction;
  reasoningSummary: string;
  upgradeCondition: string;
  falsifyCondition: string;
  evidenceRefs: string[];
  /** 什么内部数据能裁决它。内部文档只允许出现在这里和「对我们的当前含义」。 */
  internalValidationHooks: string[];
}

/** 未能核实的部分。查不到是合法结果（HP-5），但必须写出来，而且要写清差在哪。 */
export interface UnverifiedPanelBlock extends BlockBase {
  type: "unverified_panel";
  items: {
    statement: string;
    whyMatters: string;
    whatWouldSettle: string;
    impactIfTrue: string;
    impactIfFalse: string;
  }[];
}

/**
 * 证据清单。**只写编号和「它动了哪一条判断」**，别的元数据由 `registry.ts` 从台账补。
 *
 * 编号不在台账里也收下 —— 那是模型的既有知识，入列时被强制打上「未核验」。
 */
export interface EvidenceListBlock extends BlockBase {
  type: "evidence_list";
  items: {
    id: string;
    claim: string;
    /** 台账里那条以台账为准；不在台账里的一律改写成「模型既有知识」。 */
    sourceName?: string;
    sourceType?: SourceType;
    updateDirection?: UpdateDirection;
  }[];
}

/**
 * 证据利用率对账。**这一块是长度的真实引擎** —— 没用上的证据等于白检索。
 *
 * `used` 由代码从正文真的引到的编号折出来（事实归代码，见文件头「证据的元数据不由模型填」）；
 * 模型唯一说得清、也唯一替不掉的是 `discarded` 里那句**弃用理由** —— 这一条取回来了却没写
 * 进去，凭什么。校验器 A4-B11 卡的就是这条账：证据包里每条证据要么在 `used`，要么在
 * `discarded` 里带着理由，两边都没有就退回重写。
 *
 * 为什么不让代码自己把漏掉的那几条补进 `discarded`：补了这条规矩就永远过得去，而它要拦的
 * 恰恰是「取回来十八条、写进去六条、剩下十二条没人提」那一种 —— 补一句「未使用」等于把
 * 那十二条的账销了。
 */
export interface EvidenceUsageBlock extends BlockBase {
  type: "evidence_usage";
  /** 真的用上了的编号。 */
  used: string[];
  /** 取回来没用的，一条一个理由。理由是这一栏唯一的内容。 */
  discarded: { id: string; reason: string }[];
}

/**
 * 分歧视图。同一命题下并排摆各链路的裁决，这是判断板的入口组件。
 *
 * 三条链路各自取证，所以这里的分歧有两种来源：同一批证据的两种读法，或者有一条链路
 * 压根没看到另一条抓回来的那一页。后一种才指得出「谁漏了哪个来源」，所以 `keyBasis`
 * 要写具体依据，不是写立场。
 */
export interface DivergenceViewBlock extends BlockBase {
  type: "divergence_view";
  topic: string;
  positions: { lane: string; verdict: string; keyBasis: string; confidence: Confidence }[];
  adjudication: { status: AdjudicationStatus; method: AdjudicationMethod; note: string };
}

/** 推翻条件常驻卡。`monitoringIndicators` 留给以后接监控订阅。 */
export interface FalsifyCardBlock extends BlockBase {
  type: "falsify_card";
  conditions: string[];
  monitoringIndicators: string[];
}

/**
 * 参数化计算器。
 *
 * `expr` 是参数 id 上的算式字符串，由应用端的求值器算（`expr.ts`）——
 * **不执行模型给的 JS**。成本结构那类断言必须附一个这种块：占比是算出来的还是抄来的，
 * 只有能复算的那一份说得清（「电费占 30-50%」那次事故就是抄来的一个跨层占比）。
 */
export interface ParamModelBlock extends BlockBase {
  type: "param_model";
  params: { id: string; label: string; default: number; min: number; max: number; step: number; unit?: string }[];
  outputs: { label: string; expr: string; unit?: string }[];
  disclaimer: string;
  /** 这套算式属于哪一层（资产托管层 / 算力租赁层 / Token 生产层这一类）。跨层移植占比是错的。 */
  layer?: string;
}

/* -------------------------------------------------------------------------- */
/* 决断包                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 这一轮取回的证据对**预研 / 草稿那一版判断**做了什么。
 *
 * 四挡是有序的：确认了 → 收窄了范围 → 换了结论 → 反过来了。一号位读决断包时第一个要问的
 * 就是「查完这一圈，你原来那句话还算数吗」—— 这一栏答的正是它。没有这一栏的话，一份
 * 「查完之后什么都没变」的深研和一份「查完之后结论翻了」的深研，在屏幕上长得一样。
 */
export const EVIDENCE_EFFECTS = ["confirmed", "narrowed", "changed", "reversed"] as const;
export type EvidenceEffect = (typeof EVIDENCE_EFFECTS)[number];

/**
 * 一个字符串够不够格放进 `proposedOrders[].dueOn`。**只认 `2026-09-19` 这一种写法。**
 *
 * 这一栏下游会被当成日期消费（`store.ts` 渲染成「X 前」、批准那一步据它排期），所以它的
 * 判据必须是一处、而且窄：读那一层（`readCommandBrief`）拿它决定挪不挪，机检那一层
 * （`audit.ts` 的 A4-N08）拿同一个判据兜底。两边各写一个正则的下场是某一天它们不一样，
 * 而不一样的那一天没有任何一处看得出来。
 */
export const isDueDay = (raw: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(raw.trim());

/**
 * 决断包。**只在他明确进入行动整理之后才看得到这一屏**。
 *
 * ISS-238 那一批把它做成了决策题的默认落点；2026-09-07（ISS-239）改回来了：研究做完不等于
 * 已经形成决议，更不等于现在就该派命令。默认落点是当前判断、依据、成立条件和下一步要弄清的
 * 问题；这一块是他走进行动整理那一步之后才用得上的东西，**没有它的报告是合法的**。
 *
 * ## 它不是报告的一节
 *
 * 所以它不在 `Block` 联合里，也不进 `ReportBlocks.blocks` —— 它挂在 `ReportBlocks.commandBrief`
 * 上，是报告**之上**的一层。放进块序列的代价有两处，都不是小事：章节导航会多出一行
 * 「决断包」（导航是从块里数出来的），而屏幕上那十几个块渲染器是一个穷尽的 switch，
 * 多一种块就得多一个组件 —— 而这一层要的恰恰是它**不长得像报告的一节**。
 *
 * ## 没有 driId，命令只写角色
 *
 * `proposedOrders[].role` 写的是角色或领域（「产品负责人」「客户线」「交付技术」），
 * **不写人名，也没有人员编号这一栏**。本体现在没有人员名册（只有一千五百字的公司层叙述），
 * 让模型填人名它一定会填一个像样的 —— 一个不存在的名字、或者一个真名被派了一件他不知道的
 * 活。这是最伤信任的一类幻觉：它读起来完全正常，只有当事人自己看得出不对。DRI 在**批准那一步**
 * 由一号位或秘书指定，那时手上有真名册。
 *
 * ## 收得宽
 *
 * 缺栏落空（`situation` 一条没有就是空数组），只有**整块站不住**才 `ok: false` ——
 * 既没有主张、也没有要定的事和拟制命令的那一份，是一张空表单，留着它只会在屏幕上占一屏。
 */
export interface CommandBrief {
  /** 态势。≤3 条，只留**会改变行动**的事实 —— 背景写进报告正文，不写进这里。 */
  situation: { text: string; evidenceRefs: string[] }[];
  /** 建议。**唯一主张** —— 两个主张等于没有建议，同 `verdict_banner` 那条。 */
  recommendation: {
    /** 建议做什么。一句话，一件事。 */
    action: string;
    /** 想达到的终态。做完之后世界长什么样，不是「做完这件事」。 */
    intent: string;
    /** 为什么是现在。 */
    whyNow: string;
    confidence: Confidence;
    evidenceRefs: string[];
    /** 这一轮证据对预研/草稿那版判断的作用。 */
    evidenceEffect: EvidenceEffect;
    /** 哪几条证据造成的。写「证据支持」等于没写。 */
    evidenceEffectWhy: string;
  };
  /** 请决断。≤3 件，每件写清要定什么、不定的代价、建议怎么定、拍错了怎么退。 */
  decisionsRequired: {
    question: string;
    recommendedChoice: string;
    costOfDelay: string;
    recoveryIfWrong: string;
  }[];
  /**
   * 拟制命令。≤3 条，**批准之后才成为命令**。
   *
   * `role` 是角色/领域，不是人 —— 理由见上面「没有 driId」那一段。
   *
   * ## 排期分成三栏（2026-09-07）
   *
   * ISS-239 的决断包给出 9 月 11/14/18 三个确定日期，一个都说不出依据 —— 逼出它们的是旧闸
   * （`audit.ts` 的 A4-N08 只检查 `dueOn` 非空）。现在分成三栏，各答一问：
   *
   *   · `dueOn`　　　**会被当成日期去算天数的那一栏**（`store.ts` 渲染成「X 前」、UI 拿它排期）。
   *   　　　　　　　所以它只收 `2026-09-19` 这一种写法；说不出依据就留空。
   *   · `dueNote` 相对时间（「首访前」「立项后两周内」「日期待定」）。**任何一处都不许把它
   *   　　　　　　　当日期解析。** 有了它，「说不出确定日期」不必再伪装成一个确定日期。
   *   · `dueBasis`　 这个日期是怎么定出来的。有 `dueOn` 就该有它。
   *
   * 三栏都空也是合法的：没有排期好过替一号位约一个他没约过的时间。旧报告只有 `dueOn`，两个新栏
   * 都是可选的，读回来照旧。
   *
   * **`dueNote` 这个名字是跟落库那一侧对齐的**：`data/types.ts` 上的 `DecisionOrder.dueNote` 和
   * `splitDue()` 同一天落地，做的是同一件事的下一段（批准之后那条命令的排期）。同一个概念在两层
   * 里叫两个名字，接的人迟早会漏掉一层。批准那一步接过去的时候注意：这里已经分过栏了，
   * `splitDue(o.dueOn)` 在这一版上永远返回空的 `dueNote` —— 要取的是 `o.dueNote` 本身。
   */
  proposedOrders: {
    role: string;
    outcome: string;
    /** 确定的到期日，只放 `2026-09-19` 这一种写法。相对时间不写这里 —— 见上面那段。 */
    dueOn: string;
    /** 相对时间或「日期待定」。**不参与任何日期计算。** */
    dueNote?: string;
    /** 这个确定日期的依据（「对方 9 月 20 日董事会前」）。没有依据的确定日期是凭空的承诺。 */
    dueBasis?: string;
    acceptance: string[];
    resources?: string[];
  }[];
  /** 指挥边界：什么不许做、什么会改令、什么会终止、什么时候复盘。 */
  controls: {
    mustNot: string[];
    changeTriggers: string[];
    abortConditions: string[];
    reviewAt?: string;
  };
  /** 备选。≤2 条，每条写清它什么时候比主张好 —— 写不出「什么时候更好」的备选是凑数。 */
  alternatives?: { action: string; whenBetter: string }[];
  /**
   * 同 `BlockBase.defaulted`：模型没给、由这一层填了默认值的字段名。
   *
   * 2026-09-07 起还多一种：**被这一层挪过位置的字段名**（`proposedOrders[0].dueOn` 里那句
   * 相对时间挪去了 `dueNote`）。两种都是「屏幕上这一栏和模型交的不完全一样」，同一栏说得清。
   */
  defaulted?: string[];
}

export type Block =
  | VerdictBannerBlock
  | KpiCardsBlock
  | CaliberMapBlock
  | LayeredTableBlock
  | FunnelBlock
  | BarCompareBlock
  | ScenarioCardsBlock
  | ProseBlock
  | JudgmentBlock
  | UnverifiedPanelBlock
  | EvidenceListBlock
  | EvidenceUsageBlock
  | DivergenceViewBlock
  | FalsifyCardBlock
  | ParamModelBlock;

export type BlockType = Block["type"];

/* -------------------------------------------------------------------------- */
/* 报告                                                                        */
/* -------------------------------------------------------------------------- */

/** 模型交的那一行报告级元数据。别的几栏（模型、用时、证据包）是代码知道的事实。 */
export interface ReportMeta {
  /** 标题即判断。 */
  title: string;
  confidence: Confidence;
  /** 材料截止到哪一天。 */
  dataCutoff: string;
}

/** 解析不出来的一行。**留着** —— 「交了 14 个块、坏了 2 行」和「只交了 12 个块」不是一件事。 */
export interface BadLine {
  /** 第几行（从 1 数）。 */
  line: number;
  /** 原样留一截，够指认就行。 */
  text: string;
  why: string;
}

/** 落库形态。`ResearchDoc.blocks` 存的就是这个。 */
export interface ReportBlocks {
  title: string;
  confidence: Confidence;
  dataCutoff: string;
  /** 哪条链路写的。`model` 是别名，`short` 是屏幕上那两三个字。 */
  lane: { model: string; short: string; durationS?: number };
  /** 这一份消费的证据包。三条链路各自取证，所以三份报告的包 id 不同。 */
  evidencePackId: string;
  blocks: Block[];
  /**
   * 决断包。**不是默认落点**（2026-09-07 改回来的，见 `CommandBrief` 头上那段）：它是他明确
   * 进入行动整理之后才用得上的那一屏。
   *
   * 决策题也可以没有：交不出有依据的行动时整块不写，这一栏就是 `undefined`；行业题恒为空。它**不在 `blocks` 里**，
   * 理由写在 `CommandBrief` 上（章节导航会多出一行、渲染那个穷尽 switch 会多一种块，而这一层
   * 要的正是它不长得像报告的一节）。
   */
  commandBrief?: CommandBrief;
  /** 全报告统一编号的证据表。由 `registry.ts` 从台账 + 证据清单块折出来。 */
  evidence: BlockEvidence[];
  bad?: BadLine[];
  /**
   * 附录从第几个块开始。**正文和附录物理分离**，但仍是同一个 `blocks` 数组 ——
   * 拆成两个字段的话，判断板、章节导航、返修那三处都要各写一次「读哪一份」。
   *
   * 缺这一栏 = 这一份是分层之前写的，整份都当正文（旧报告照旧渲染）。
   */
  appendixFrom?: number;
}

/* -------------------------------------------------------------------------- */
/* 读一行                                                                      */
/* -------------------------------------------------------------------------- */

export type Read<T> = { ok: true; value: T } | { ok: false; why: string };

const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const isNum = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v : []).map(s).filter(Boolean);
const objs = (v: unknown): Record<string, unknown>[] =>
  (Array.isArray(v) ? v : []).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
const bool = (v: unknown): boolean => v === true;

const oneOf = <T extends readonly string[]>(list: T, v: unknown, fallback: T[number]): T[number] => {
  const got = s(v);
  return (list as readonly string[]).includes(got) ? (got as T[number]) : fallback;
};

/** 这一栏模型是真写了，还是待会儿要由 `oneOf` 填默认值。见 `BlockBase.defaulted`。 */
const stated = <T extends readonly string[]>(list: T, v: unknown): boolean =>
  (list as readonly string[]).includes(s(v));

/** 编号归一：`e3`、`E3 `、`[E3]` 都是 E3。屏幕上和校验器里必须是同一个字符串。 */
export const normalizeRef = (v: unknown): string => {
  const raw = s(v).replace(/[[\]]/g, "").toUpperCase();
  const m = /^E?(\d+)$/.exec(raw);
  return m ? `E${m[1]}` : raw;
};

const refs = (v: unknown): string[] => {
  const out: string[] = [];
  for (const one of (Array.isArray(v) ? v : []).map(normalizeRef).filter(Boolean)) {
    if (!out.includes(one)) out.push(one);
  }
  return out;
};

const dir = (v: unknown): UpdateDirection | undefined => {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const target = s(o.target);
  if (!target) return undefined;
  return { target, effect: oneOf(UPDATE_EFFECTS, o.effect, "限定") };
};

const withHeading = <T extends object>(o: Record<string, unknown>, block: T): T => {
  const heading = s(o.heading);
  return heading ? { ...block, heading } : block;
};

/** 读一行报告级元数据。缺标题就不算 —— 标题即判断，空标题的报告没有结论。 */
export function readMeta(raw: unknown): Read<ReportMeta> {
  if (!raw || typeof raw !== "object") return { ok: false, why: "不是一个对象" };
  const o = raw as Record<string, unknown>;
  const title = s(o.title);
  if (!title) return { ok: false, why: "report_meta 没有标题" };
  return {
    ok: true,
    value: { title, confidence: oneOf(CONFIDENCES, o.confidence, "初步提示"), dataCutoff: s(o.dataCutoff) },
  };
}

/**
 * 读一行块。
 *
 * 拒的只有三种：不是对象、`type` 不认识、内容整个是空的。空块要拒是因为它渲染出来是
 * 一块空白，而空白在 `lint.ts` 里没有可指认的对象 —— 报「第 3 个块是空的」比报
 * 「屏幕上少了一节」有用。
 */
export function readBlock(raw: unknown): Read<Block> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, why: "不是一个对象" };
  const o = raw as Record<string, unknown>;
  const type = s(o.type);
  if (!type) return { ok: false, why: "没有 type" };

  switch (type) {
    case "verdict_banner": {
      const text = s(o.text);
      if (!text) return { ok: false, why: "verdict_banner 没有正文" };
      const gaps = stated(CONFIDENCES, o.confidence) ? [] : ["confidence"];
      return {
        ok: true,
        value: withHeading(o, {
          type: "verdict_banner" as const,
          text,
          confidence: oneOf(CONFIDENCES, o.confidence, "初步提示"),
          boundary: s(o.boundary),
          ...(gaps.length ? { defaulted: gaps } : {}),
        }),
      };
    }

    case "kpi_cards": {
      const cards: KpiCard[] = objs(o.cards)
        .map((c) => ({
          value: s(c.value) || (isNum(c.value) ? String(c.value) : ""),
          unit: s(c.unit) || undefined,
          label: s(c.label),
          caliberNote: s(c.caliberNote),
          delta: s(c.delta) || undefined,
          evidenceRefs: refs(c.evidenceRefs),
        }))
        .filter((c) => c.value && c.label);
      if (!cards.length) return { ok: false, why: "kpi_cards 里没有一张带数和标签的卡" };
      return { ok: true, value: withHeading(o, { type: "kpi_cards" as const, cards }) };
    }

    case "caliber_map": {
      const rows = objs(o.rows)
        .map((r) => ({
          metric: s(r.metric),
          answersWhat: s(r.answersWhat),
          cannotAnswer: s(r.cannotAnswer),
          handling: s(r.handling),
        }))
        .filter((r) => r.metric);
      if (!rows.length) return { ok: false, why: "caliber_map 一行都没有" };
      return { ok: true, value: withHeading(o, { type: "caliber_map" as const, rows }) };
    }

    case "layered_table": {
      const columns = strs(o.columns);
      const rows = (Array.isArray(o.rows) ? o.rows : [])
        .map((r) => (Array.isArray(r) ? r.map((c) => (isNum(c) ? String(c) : s(c))) : []))
        .filter((r) => r.some(Boolean));
      if (!columns.length || !rows.length) return { ok: false, why: "layered_table 缺表头或缺行" };
      const grades = strs(o.rowGrade).map((g) => oneOf(ROW_GRADES, g, "E"));
      const block = {
        type: "layered_table" as const,
        columns,
        rows,
        evidenceRefs: refs(o.evidenceRefs),
        // 给不齐就整列不要：半列有档次半列空白，读的人会把空白读成「这一行没问题」。
        ...(grades.length === rows.length ? { rowGrade: grades } : {}),
      };
      return { ok: true, value: withHeading(o, block) };
    }

    case "funnel": {
      const stages = objs(o.stages)
        .map((x) => ({ label: s(x.label), value: num(x.value), note: s(x.note) || undefined }))
        .filter((x) => x.label);
      if (stages.length < 2) return { ok: false, why: "funnel 少于两级 —— 一级的漏斗不是漏斗" };
      return { ok: true, value: withHeading(o, { type: "funnel" as const, stages }) };
    }

    case "bar_compare": {
      const items = objs(o.items)
        .map((x) => ({ label: s(x.label), value: num(x.value), note: s(x.note) || undefined }))
        .filter((x) => x.label);
      if (!items.length) return { ok: false, why: "bar_compare 一项都没有" };
      const block = {
        type: "bar_compare" as const,
        items,
        ...(bool(o.nonAdditive) ? { nonAdditive: true as const } : {}),
      };
      return { ok: true, value: withHeading(o, block) };
    }

    case "scenario_cards": {
      const cards = objs(o.cards)
        .map((c) => ({
          name: s(c.name),
          assumptions: strs(c.assumptions),
          keyNumbers: strs(c.keyNumbers),
          triggerIndicators: strs(c.triggerIndicators),
        }))
        .filter((c) => c.name);
      if (!cards.length) return { ok: false, why: "scenario_cards 一张都没有" };
      return { ok: true, value: withHeading(o, { type: "scenario_cards" as const, cards }) };
    }

    case "prose": {
      const md = typeof o.md === "string" ? o.md.trim() : "";
      if (!md) return { ok: false, why: "prose 是空的" };
      return { ok: true, value: withHeading(o, { type: "prose" as const, md }) };
    }

    case "judgment": {
      const claim = s(o.claim);
      if (!claim) return { ok: false, why: "judgment 没有判断本身" };
      const gaps: string[] = [];
      if (!stated(CONFIDENCES, o.confidence)) gaps.push("confidence");
      if (!stated(DIRECTIONS, o.direction)) gaps.push("direction");
      return {
        ok: true,
        value: withHeading(o, {
          type: "judgment" as const,
          claim,
          // 缺分档不在这里拒（拒了这个块就凭空消失）——lint 报「第 N 个块缺 confidence」。
          confidence: oneOf(CONFIDENCES, o.confidence, "初步提示"),
          direction: oneOf(DIRECTIONS, o.direction, "限定"),
          ...(gaps.length ? { defaulted: gaps } : {}),
          reasoningSummary: s(o.reasoningSummary),
          upgradeCondition: s(o.upgradeCondition),
          falsifyCondition: s(o.falsifyCondition),
          evidenceRefs: refs(o.evidenceRefs),
          internalValidationHooks: strs(o.internalValidationHooks),
        }),
      };
    }

    case "unverified_panel": {
      const items = objs(o.items)
        .map((x) => ({
          statement: s(x.statement),
          whyMatters: s(x.whyMatters),
          whatWouldSettle: s(x.whatWouldSettle),
          impactIfTrue: s(x.impactIfTrue),
          impactIfFalse: s(x.impactIfFalse),
        }))
        .filter((x) => x.statement);
      if (!items.length) return { ok: false, why: "unverified_panel 一条都没有" };
      return { ok: true, value: withHeading(o, { type: "unverified_panel" as const, items }) };
    }

    case "evidence_list": {
      const items = objs(o.items)
        .map((x) => {
          const one: EvidenceListBlock["items"][number] = { id: normalizeRef(x.id), claim: s(x.claim) };
          const name = s(x.sourceName);
          if (name) one.sourceName = name;
          const st = s(x.sourceType);
          if ((SOURCE_TYPES as readonly string[]).includes(st)) one.sourceType = st as SourceType;
          const d = dir(x.updateDirection);
          if (d) one.updateDirection = d;
          return one;
        })
        .filter((x) => x.id);
      if (!items.length) return { ok: false, why: "evidence_list 一条都没有" };
      return { ok: true, value: withHeading(o, { type: "evidence_list" as const, items }) };
    }

    case "evidence_usage": {
      const used = refs(o.used);
      const discarded = objs(o.discarded)
        .map((x) => ({ id: normalizeRef(x.id), reason: s(x.reason) }))
        .filter((x) => x.id);
      // 两边都空的那一行没有任何内容可对账，等于没交。缺理由不在这里拒 —— 那一条 A4-B11 报。
      if (!used.length && !discarded.length) {
        return { ok: false, why: "evidence_usage 用上的和弃用的两边都是空的" };
      }
      return { ok: true, value: withHeading(o, { type: "evidence_usage" as const, used, discarded }) };
    }

    case "divergence_view": {
      const topic = s(o.topic);
      const positions = objs(o.positions)
        .map((p) => ({
          lane: s(p.lane),
          verdict: s(p.verdict),
          keyBasis: s(p.keyBasis),
          confidence: oneOf(CONFIDENCES, p.confidence, "初步提示"),
        }))
        .filter((p) => p.lane && p.verdict);
      if (!topic || positions.length < 2) {
        return { ok: false, why: "divergence_view 缺命题，或者只有一方立场 —— 一方没有分歧" };
      }
      const adj = (o.adjudication ?? {}) as Record<string, unknown>;
      return {
        ok: true,
        value: withHeading(o, {
          type: "divergence_view" as const,
          topic,
          positions,
          adjudication: {
            status: oneOf(ADJUDICATION_STATUSES, adj.status, "待裁决"),
            method: oneOf(ADJUDICATION_METHODS, adj.method, "事实核查"),
            note: s(adj.note),
          },
        }),
      };
    }

    case "falsify_card": {
      const conditions = strs(o.conditions);
      if (!conditions.length) return { ok: false, why: "falsify_card 一条推翻条件都没有" };
      return {
        ok: true,
        value: withHeading(o, {
          type: "falsify_card" as const,
          conditions,
          monitoringIndicators: strs(o.monitoringIndicators),
        }),
      };
    }

    case "param_model": {
      const params = objs(o.params)
        .map((p) => ({
          id: s(p.id),
          label: s(p.label),
          default: num(p.default),
          min: num(p.min),
          max: num(p.max),
          // 步长为 0 的滑块拖不动。给不出就按量程的百分之一。
          step: num(p.step) || Math.abs(num(p.max) - num(p.min)) / 100 || 1,
          unit: s(p.unit) || undefined,
        }))
        .filter((p) => p.id && p.max > p.min);
      const outputs = objs(o.outputs)
        .map((x) => ({ label: s(x.label), expr: s(x.expr), unit: s(x.unit) || undefined }))
        .filter((x) => x.label && x.expr);
      if (!params.length || !outputs.length) {
        return { ok: false, why: "param_model 缺参数或缺输出 —— 拖不动也算不出的计算器" };
      }
      const block = {
        type: "param_model" as const,
        params,
        outputs,
        disclaimer: s(o.disclaimer),
        ...(s(o.layer) ? { layer: s(o.layer) } : {}),
      };
      return { ok: true, value: withHeading(o, block) };
    }

    default:
      return { ok: false, why: `不认识的块类型「${type.slice(0, 30)}」` };
  }
}

/** 这一行是报告级元数据吗。`report_meta` 不是块，所以它不在 `Block` 联合里。 */
export const isMetaLine = (raw: unknown): boolean =>
  !!raw && typeof raw === "object" && s((raw as Record<string, unknown>).type) === "report_meta";

/**
 * 这一行是决断包吗。
 *
 * 和 `isMetaLine` 同一类：它是**报告级**的一行，不是块。所以 `readBlock` 不认它
 * （认了就得进 `Block` 联合，而那会一路推到章节导航和渲染那个穷尽 switch 上），
 * 由 `parse.ts` 像收 `report_meta` 那样单独收一次。
 */
export const isCommandBriefLine = (raw: unknown): boolean =>
  !!raw && typeof raw === "object" && s((raw as Record<string, unknown>).type) === "command_brief";

/**
 * 读一行决断包。
 *
 * 宽容度和 `readBlock` 一致：缺栏落空、枚举给不出就落默认值并记进 `defaulted`。
 * **只有一种情形拒**：既没有主张（`recommendation.action`）、也没有要定的事和拟制命令 ——
 * 那是一张空表单，收下它的结果是屏幕上那一屏什么都没有，而一号位以为这一轮没给建议。
 * 只有 `situation` 有内容的那一份也拒：几条事实不是决断包，它是报告正文该有的东西。
 *
 * **不截断超出上限的条目。** 提示词里写着 `situation` / `decisionsRequired` / `proposedOrders`
 * 各 ≤3，但那是对模型的要求，不是这一层的权力：截掉第四条等于把「它没守规矩」这件事
 * 抹掉，而抹掉之后没有任何一处看得出来。多交了由屏幕和机检去说。
 *
 * **唯一一处改内容的地方**是排期：`dueOn` 里写的不是日期时挪去 `dueNote`，理由在下面
 * 那段注释里（那一栏下游会被当成日期消费）。挪了会记进 `defaulted`，不是静悄悄的。
 */
export function readCommandBrief(raw: unknown): Read<CommandBrief> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, why: "不是一个对象" };
  const o = raw as Record<string, unknown>;

  const situation = objs(o.situation)
    .map((x) => ({ text: s(x.text), evidenceRefs: refs(x.evidenceRefs) }))
    .filter((x) => x.text);

  const r = (o.recommendation ?? {}) as Record<string, unknown>;
  const gaps: string[] = [];
  if (!stated(CONFIDENCES, r.confidence)) gaps.push("recommendation.confidence");
  if (!stated(EVIDENCE_EFFECTS, r.evidenceEffect)) gaps.push("recommendation.evidenceEffect");
  const recommendation: CommandBrief["recommendation"] = {
    action: s(r.action),
    intent: s(r.intent),
    whyNow: s(r.whyNow),
    confidence: oneOf(CONFIDENCES, r.confidence, "初步提示"),
    evidenceRefs: refs(r.evidenceRefs),
    /*
     * 没写的时候落 `confirmed`：四挡里它是**最不惊动人的那一挡**（这一轮什么都没改变），
     * 同 `confidence` 落「初步提示」的道理 —— 默认值要往「没有新消息」那一边落，不往
     * 「结论翻了」那一边落。落了默认值这件事记在 `defaulted` 里，屏幕据此显示成未标注。
     */
    evidenceEffect: oneOf(EVIDENCE_EFFECTS, r.evidenceEffect, "confirmed"),
    evidenceEffectWhy: s(r.evidenceEffectWhy),
  };

  const decisionsRequired = objs(o.decisionsRequired)
    .map((x) => ({
      question: s(x.question),
      recommendedChoice: s(x.recommendedChoice),
      costOfDelay: s(x.costOfDelay),
      recoveryIfWrong: s(x.recoveryIfWrong),
    }))
    .filter((x) => x.question);

  const proposedOrders = objs(o.proposedOrders)
    .map((x, i) => {
      /*
       * **`dueOn` 里不是日期的那一种挪去 `dueNote`。**
       *
       * 这一层平时不改模型交的内容（`readBlock` 那套只落默认值），这里破一次例，理由是
       * 这一栏下游会被当成日期消费：`store.ts` 把它渲染成「X 前」、批准那一步拿它排期。
       * 「首访前」留在这一栏里的下场不是显示成一句相对时间，是变成一个谁也没约过的到期日
       * （ISS-239 那三个九月的日子就是这么来的）。挪过去不丢内容，也不替它编一个日期 ——
       * 而且记进 `defaulted`，屏幕和机检都看得见这一条被动过。
       *
       * 认得出的写法**只有 `2026-09-19` 这一种**（`isDueDay`）。「2026 年 9 月 19 日」「9 月中」
       * 「2026-09」都当相对时间挪走 —— 少认几种写法的代价只是那几条落在 `dueNote` 上，
       * 而多认一种的代价是下游的日期解析器要去猜。提示词里给的就是这一种写法。
       */
      const rawDue = s(x.dueOn);
      const looksLikeDay = isDueDay(rawDue);
      const relative = s(x.dueNote) || (rawDue && !looksLikeDay ? rawDue : "");
      if (rawDue && !looksLikeDay) gaps.push(`proposedOrders[${i}].dueOn`);
      const one: CommandBrief["proposedOrders"][number] = {
        // 角色/领域，不是人。模型写了人名也照收 —— 换掉它等于替它编一个角色；
        // 拦这件事的地方是提示词和批准那一步，不是这里。
        role: s(x.role),
        outcome: s(x.outcome),
        dueOn: looksLikeDay ? rawDue : "",
        ...(relative ? { dueNote: relative } : {}),
        ...(s(x.dueBasis) ? { dueBasis: s(x.dueBasis) } : {}),
        acceptance: strs(x.acceptance),
      };
      const res = strs(x.resources);
      if (res.length) one.resources = res;
      return one;
    })
    .filter((x) => x.role || x.outcome);

  const c = (o.controls ?? {}) as Record<string, unknown>;
  const controls: CommandBrief["controls"] = {
    mustNot: strs(c.mustNot),
    changeTriggers: strs(c.changeTriggers),
    abortConditions: strs(c.abortConditions),
    ...(s(c.reviewAt) ? { reviewAt: s(c.reviewAt) } : {}),
  };

  const alternatives = objs(o.alternatives)
    .map((x) => ({ action: s(x.action), whenBetter: s(x.whenBetter) }))
    .filter((x) => x.action);

  if (!recommendation.action && !decisionsRequired.length && !proposedOrders.length) {
    return { ok: false, why: "command_brief 既没有主张，也没有要定的事和拟制命令 —— 这是一张空表单" };
  }

  return {
    ok: true,
    value: {
      situation,
      recommendation,
      decisionsRequired,
      proposedOrders,
      controls,
      ...(alternatives.length ? { alternatives } : {}),
      ...(gaps.length ? { defaulted: gaps } : {}),
    },
  };
}
