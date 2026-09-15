/**
 * 一手披露的识别与报告期的算术。**两个消费者，所以它不住在其中任何一个里面。**
 *
 * · 出口机检 A4-N09（`audit.ts`）：台账里有没有最近一期披露，没有就是 p1。
 * · 装配那一步（`blocks/report.ts`）：`report_meta.dataCutoff` 由代码改写成台账里最晚的
 *   那份披露的报告期，不信模型写的那一行。
 *
 * ISS-238 那份报告文首写着「材料截至 2026-08-20」，而它手上最新的那份年报是 2024 年的 ——
 * 那一行从来没有任何一步核过，它是模型顺手写的一个日期。两处判据必须是同一份代码：一边
 * 认得出、另一边认不出的话，屏幕上会出现「机检说没拿到最新披露」和「材料截至上个月」
 * 并排放着。
 *
 * ## 2026-09-07（ISS-239）：一份日期治好了 238，又病成了另一样
 *
 * 上面那条改法只问了「是不是一手披露域名」和「报告期认不认得出」，于是 `RUN-A4-mtqpegne-4`
 * 的屏幕上写着**「材料截至 2020-12-31」**，而同一份台账里躺着 2025 年报和 2026 年 5 月的
 * 投资者交流记录。逐条查那份台账（`replay/iss239.snapshot.json`，31 条）之后，两处判错各有
 * 自己的原因：
 *
 *   · **E1** 是维信诺官网「发展历程」那一页，说合肥 G6 产线 2020 年 12 月点亮 ——
 *     `evidenceType: "event"`、`usedAs: "historical_point"`、`period: "2020-12"`。它在
 *     官网上，所以过了域名那道闸；它有一个认得出的「期次」，所以进了取最大值那一步。
 *     可这个 2020-12 是**那条产线哪一年建成**，不是**这份材料写到哪一期**。台账里唯一
 *     一条既在披露域名上、期次又认得出的就是它，取最大值取的就是它。
 *   · **E25–E31**（2025 年报的七条）和 **E12–E14**（2026-05-29 投资者交流记录）都在
 *     `vip.stock.finance.sina.com.cn` 上，`authorityClass: "company_primary"`、A 级 ——
 *     内容是公司自己签发的，站不是公司的。域名那道闸只认巨潮/交易所/官网，于是这七条
 *     一条都没进计算。
 *
 * 所以这一版把**三种时间彻底分开**，谁也不许替谁说话：
 *
 *   · **检索时间**（`retrievedAt`）—— 我们哪天抓的。它永远不是材料截止日。
 *   · **经营数据报告期**（`period` 且 `periodKind === "reporting"`）—— 这份数是哪一期的。
 *     只有它能当材料截止日。
 *   · **事件发生时间**（`periodKind === "event"`）—— 某条产线哪一年建成、某场交流哪天开的。
 *     它是一个时点，不是一段报告期；拿它当截止日就是 ISS-239 屏幕上那个 2020-12-31。
 *
 * 以及把**来源身份**从两档拆成三档（`disclosureOrigin`）：一手 / 镜像转载的公司披露 /
 * 第三方转述。镜像那一档**不自动升格成一手**（原站与报告身份没核过），但它也**不等于
 * 「完全没有近期公司材料」** —— 新浪那两台机器上挂的确实是维信诺自己发的年报。
 */

import type { AuthorityClass, EvidenceType, UsedAs } from "@/lib/research/ledger";
import { DISCLOSURE_HOSTS, hostOf } from "@/lib/research/rank";

/** 报告期落在最近几个月内才算「拿到了最近一期披露」。 */
export const FRESHNESS_MONTHS = 15;

/**
 * 这条规则要看的那几栏。**按 `@/lib/research/ledger` 的 `Evidence` 取子集**，所以
 * `pipeline.ts` 直接把 `ledger.entries` 递进来就赋得上，不用映射一遍。
 *
 * 只列真用得着的栏：多列一栏就多一个「那边改了字段名这边编译红」的接触面。
 */
export type AuditEvidence = {
  id: string;
  url: string;
  sourceDomain: string;
  sourceTier: "A" | "B" | "C" | "D";
  /**
   * 口径四件套里的报告期，自由文本（「2025 年度」「2026年第一季度」「2025H1」）。
   * **可能为空** —— 台账入账七项必填里没有它，抽取提示词只是「要求填」。
   *
   * **这一栏装的不一定是报告期。** ISS-239 那份台账里它同时装着「2020-12」（产线点亮那
   * 个月）、「2026-05-29」（那场投资者交流开会那天）和「2025年」（年报那一期）——
   * 三种时间挤在一个字段里。分得开它们的是 `periodKind`，不是这一栏本身。
   */
  period?: string;
  retrievedAt: string;
  /**
   * ---- 下面三栏是 2026-09-07 加的，全可选 ----
   *
   * 可选不是因为它们不重要，是因为**接线次序**：`audit.ts` 在别人手上，它现在递进来的
   * 对象里就有这三栏（台账 `Evidence` 是这个类型的超集），但按 `AuditEvidence` 手工造
   * 测试数据的地方不递也照常编译。缺省时 `periodKind` 只能靠期次的字面形状判 ——
   * 判得出 ISO 全日期和年份区间，判不出「这条讲的是一件事而不是一期数」。
   */
  /** 这是一个数、一句话、一件事，还是一份文档。台账 `Evidence` 那一栏。 */
  evidenceType?: EvidenceType;
  /** 这个数被当成现状用还是当成历史时点用。 */
  usedAs?: UsedAs;
  /** 谁在说这句话。镜像站上的公司披露靠它认出来。 */
  authorityClass?: AuthorityClass;
};

/** 主机名后缀匹配。抄 `rank.ts` 的 `isDisclosureUrl`：不用 `includes`，空串直接跳过。 */
const hostMatches = (host: string, domains: readonly string[]): boolean => {
  for (const d of domains) {
    const dom = d.trim().toLowerCase();
    if (!dom) continue;
    if (host === dom || host.endsWith(`.${dom}`)) return true;
  }
  return false;
};

/**
 * 这条台账证据是不是**一手披露**（巨潮 / 上交所 / 深交所 / 港交所 / 新三板 / 主体官网）。
 *
 * 域名表从 `@/lib/research/rank` 的 `DISCLOSURE_HOSTS` 来 —— 抓取位保留和抓取超时放宽用的
 * 是同一张表，这里再抄一份的话，哪天加了一家而这道闸不认，表现是「明明抓回来了却报没拿到」。
 *
 * `url` 取不出主机名时退到 `sourceDomain`（台账里那一栏是裸主机名，不是地址）：证据是从
 * 别处折过来的那几条（`resupply.ts` 的种子）url 可能是相对地址或者脏串。
 */
export function isDisclosureEvidence(
  entry: Pick<AuditEvidence, "url" | "sourceDomain">,
  extraDomains: readonly string[] = []
): boolean {
  const host = hostOf(entry.url) || (entry.sourceDomain ?? "").trim().toLowerCase();
  if (!host) return false;
  return hostMatches(host, [...DISCLOSURE_HOSTS, ...extraDomains]);
}

/**
 * 报告期字符串 → 这一期**结束**的那一天。认不出来返回 `null`。
 *
 * 取结束日而不是开始日：「2025 年度」在 2026 年 4 月才发得出来，拿 2025-01-01 去比窗口
 * 会把一份刚发的年报判成旧数。
 *
 * 认的粒度按 `calc.ts` 那条 `PERIOD` 正则的同一套词：年 / 季度 / 上下半年 / 月。没有更细的
 * 粒度词就按**年末**算 —— 「2024 年年度报告」「2025 年」都是这一支。
 */
export function periodEnd(period: string | undefined): Date | null {
  const raw = (period ?? "").trim();
  if (!raw) return null;
  const year = /(20\d{2})/.exec(raw);
  if (!year) return null;
  const y = Number(year[1]);

  // 先季度、再半年、再月：「2026 年第一季度」里也有「年」，谁先谁后决定认成 3 月还是 12 月。
  const q = /第?\s*([一二三四1-4])\s*季度|Q\s*([1-4])/i.exec(raw);
  let endMonth = 12;
  if (q) {
    const cn: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4 };
    const n = q[2] ? Number(q[2]) : (cn[q[1]] ?? Number(q[1]));
    endMonth = n * 3;
  } else if (/上半年|中期|半年度|半年报|H\s*1/i.test(raw)) {
    endMonth = 6;
  } else if (/下半年|H\s*2/i.test(raw)) {
    endMonth = 12;
  } else {
    const m = /(\d{1,2})\s*月/.exec(raw);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 12) endMonth = n;
    }
  }
  // UTC：本机时区会让「12 月 31 日」在东八区落到下一年 1 月 1 日，窗口边界上差一天。
  return new Date(Date.UTC(y, endMonth, 0));
}

/**
 * 报告期在不在窗口内。**认不出报告期一律算不在。**
 *
 * 这一头故意从严：认不出就当没拿到，报的是 p1，代价是清单上多一句；反过来放行的代价是
 * ISS-238 那一种 —— 拿 2024 年报下「现金流薄」的判断，而 2025 年报当时就挂在巨潮上。
 */
export function periodWithin(period: string | undefined, now: Date, months: number = FRESHNESS_MONTHS): boolean {
  const end = periodEnd(period);
  if (!end) return false;
  const cutoff = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate());
  return end.getTime() >= cutoff;
}

/* -------------------------------------------------------------------------- */
/* 三种时间：检索时间 / 经营数据报告期 / 事件发生时间                          */
/* -------------------------------------------------------------------------- */

/**
 * `period` 这一栏装的是哪一种时间。
 *
 * · `reporting` —— 经营数据报告期。「2025 年度」「2026年第一季度」「2025H1」「2025年」。
 *   **只有这一种能当材料截止日。**
 * · `event` —— 事件发生时间。某天、某月、某段年份区间：「2020-12」（产线点亮）、
 *   「2026-05-29」（开了一场投资者交流）、「2020-2022」（爬坡爬了两年）。
 * · `none` —— 认不出来（空、「最近一期」这种词、`periodEnd` 解不开的串）。
 *
 * ## 判据的次序就是判据本身
 *
 * 六步，一步一步往下落，先命中先算数：
 *
 *   1. `periodEnd` 解不开 → `none`。连哪一天结束都算不出来的期次不参与任何比较。
 *   2. `evidenceType === "event"` → `event`。**这一步最要紧** —— ISS-239 的 E1 就死在
 *      这里没有这一步：抽取器已经把它标成 event 了，而计算截止日的那段代码没看这一栏。
 *   3. 期次里有报告期专用词（年度 / 年报 / 半年 / 中期 / 季度 / H1 / Q1 / 报告期）→
 *      `reporting`。这几个词只用来说一段经营数据的口径，没有别的用法。
 *   4. 形如一个具体日子（`2026-05-29`、`2024年5月29日`）或者一段年份区间（`2020-2022`）
 *      → `event`。**一天不是一期。** E12/E13/E14 的 `period` 全是「2026-05-29」——
 *      那是那场交流会开会那天，而旧代码把它读成「2026 年」，再落成 2026-12-31。
 *   5. `usedAs === "historical_point"` → `event`。抽取器已经说了这个数是当历史点用的，
 *      当历史点用的数按定义就不在描述当期。
 *   6. 光秃秃一个年份（「2025年」「2025」）→ `reporting`；剩下的（「2020-12」这种没有
 *      报告期词的月份戳）→ `event`。
 *
 * 最后那一支**故意往 `event` 落**：判错成 `reporting` 的代价是屏幕上多一个假的截止日
 * （ISS-239 那一种，最贵）；判错成 `event` 的代价是这一条不参与截止日计算，够不着的话
 * 那一栏落成「未确定」—— 而「未确定」是一句真话。
 */
export type PeriodKind = "reporting" | "event" | "none";

/** 报告期专用词。这几个词只用来说一段经营数据的口径。 */
const REPORTING_WORD = /年度|年报|半年|中期|季度|报告期|[Hh]\s*[12]\b|[Qq]\s*[1-4]\b/;
/** 一个具体的日子。`2026-05-29`、`2026/5/29`、`2024年5月29日`。 */
const ONE_DAY = /(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/;
/** 一段年份区间。`2020-2022`、`2020 至 2022`。 */
const YEAR_SPAN = /20\d{2}\s*[-—~～至到]\s*20\d{2}/;
/** 光秃秃一个年份。 */
const BARE_YEAR = /^\s*(20\d{2})\s*年?\s*$/;

export function periodKind(
  entry: Pick<AuditEvidence, "period" | "evidenceType" | "usedAs">
): PeriodKind {
  const raw = (entry.period ?? "").trim();
  if (!periodEnd(raw)) return "none";
  if (entry.evidenceType === "event") return "event";
  if (REPORTING_WORD.test(raw)) return "reporting";
  if (ONE_DAY.test(raw) || YEAR_SPAN.test(raw)) return "event";
  if (entry.usedAs === "historical_point") return "event";
  if (BARE_YEAR.test(raw)) return "reporting";
  return "event";
}

/* -------------------------------------------------------------------------- */
/* 来源身份：一手 / 镜像转载的公司披露 / 第三方转述                            */
/* -------------------------------------------------------------------------- */

/**
 * · `primary` —— 一手披露。巨潮 / 交易所 / 新三板 / 主体自己的官网。发行人签字发出来的，
 *   而且**发在自己的机器上**。
 * · `mirrored` —— 镜像转载的公司披露。内容是公司自己发的（年报摘要、投资者关系活动记录），
 *   站不是公司的。**它不是一手**（原站与这份转载的身份没有核过，那需要拿原站的同一份
 *   文件逐字比一遍，这一轮没做），但它**也不是媒体转述** —— 里面那几行字是公司写的。
 * · `thirdparty` —— 媒体、研究机构、论坛，以及一切说不清的。
 */
export type DisclosureOrigin = "primary" | "mirrored" | "thirdparty";

/**
 * 已知的**公司披露镜像站**。这张表不是「可信来源表」，是「这台机器上挂的是公司发的原件」。
 *
 * 只列到主机这一级，**绝不列 `sina.com.cn`**：`finance.sina.com.cn` 上是新浪自己的稿子
 * （ISS-239 的 E8 就在那儿，媒体转述），而 `vip.stock.finance.sina.com.cn/corp/view/…`
 * 挂的是交易所公告和投资者关系活动记录的原文，`money.finance.sina.com.cn` 是 F10 公司
 * 资料。差一段主机名就是两件事，所以按后缀段比（`hostMatches`），不用 `includes`。
 *
 * ISS-239 实测：E11–E14、E25–E31 共十一条在 `vip.stock…`，E16 在 `money.finance…`，
 * 全部 `authorityClass: "company_primary"`、A 级。质量评估里人工打开核对过 E11 那一条
 * （2026 年 5 月 19 日投资者关系活动记录），设备搬入的表述确实在那一页上。
 */
export const DISCLOSURE_MIRROR_HOSTS = [
  "vip.stock.finance.sina.com.cn",
  "money.finance.sina.com.cn",
] as const;

/**
 * 这一条的来源身份。
 *
 * 镜像那一档有两条入口，命中任一即算：
 *
 *   · 主机名在 `DISCLOSURE_MIRROR_HOSTS` 上 —— 这台机器专门挂公司原件；
 *   · 抽取器把它标成了 `company_primary` —— 说这句话的是公司自己。
 *
 * 两条都是**充分条件**（or），因为它们各自漏的东西不一样：镜像站的表永远列不全（世上
 * 有几十台这样的机器），而 `authorityClass` 是模型标的、会标错。两条并起来的代价是
 * 一篇被标成 `company_primary` 的媒体稿会落进 `mirrored` —— 而 `mirrored` 这一档
 * **在屏幕上和缺陷清单里都要写明「原站未核对」**，所以标错的那一条不会伪装成一手。
 */
export function disclosureOrigin(
  entry: Pick<AuditEvidence, "url" | "sourceDomain" | "authorityClass">,
  extraDomains: readonly string[] = []
): DisclosureOrigin {
  if (isDisclosureEvidence(entry, extraDomains)) return "primary";
  const host = hostOf(entry.url) || (entry.sourceDomain ?? "").trim().toLowerCase();
  if (host && hostMatches(host, DISCLOSURE_MIRROR_HOSTS)) return "mirrored";
  if (entry.authorityClass === "company_primary") return "mirrored";
  return "thirdparty";
}

/* -------------------------------------------------------------------------- */
/* 材料截至哪一天                                                              */
/* -------------------------------------------------------------------------- */

export interface MaterialCutoff {
  /**
   * `dated` = 台账里真有一份带经营数据报告期的公司材料；`undetermined` = 没有。
   *
   * **没有第三种。** 尤其没有「回落到模型写的那一行」—— 模型写的那个日期从来没有一步
   * 核过，它是 ISS-238 和 ISS-239 两次「材料截至」错得离谱的同一个来源。
   */
  status: "dated" | "undetermined";
  /** 这一期结束的那一天，`YYYY-MM-DD`。`undetermined` 时是空串。 */
  date: string;
  /** 撑起这一天的那几条是一手还是镜像。`undetermined` 时不给。 */
  origin?: Exclude<DisclosureOrigin, "thirdparty">;
  /** 期次原文（「2025年」）。屏幕上不一定显示，但缺陷清单和 trace 要说得出是哪一期。 */
  period: string;
  /** 撑起这一天的证据编号，按台账顺序。 */
  refs: string[];
  /** 屏幕上「材料截至 ___」那一格里的字。**镜像那一档要把「未核对」带上去。** */
  label: string;
  /** 为什么是这一天、或者为什么未确定。一句话，进 trace 与缺陷清单。 */
  why: string;
}

/**
 * 「材料截至哪一天」**由台账定，不由模型写；而且只由经营数据报告期定。**
 *
 * 三条判据，缺一不可：
 *
 *   1. **来源身份不是第三方转述**（`disclosureOrigin !== "thirdparty"`）。转载页上的
 *      日期是它自己发稿那天，跟里面那份数是哪一期无关 —— 拿它当截止日会把一篇今天转载
 *      2024 年报的稿子读成「材料截至今天」，比模型写的那一行还糟。
 *   2. **期次是经营数据报告期**（`periodKind === "reporting"`）。ISS-239 的 E1 卡在这里：
 *      它在官网上（过第 1 条），期次「2020-12」也认得出，但那是产线点亮那个月。
 *   3. **取这几条里最晚的那一期。** 同一期有好几条（ISS-239 的 2025 年报有七条）时
 *      编号全列出来。
 *
 * 一条都不剩时**返回 `undetermined`，屏幕上写「未确定」**。这一条 2026-09-07 改过口径：
 * 上一版落回模型写的那一行，理由是「空格读起来像还没算」。ISS-239 证明那个理由站不住 ——
 * 落回去之后屏幕上是一个**看着像核过、其实没核过**的日期，而那比空格贵得多。「未确定」
 * 三个字既不是空格也不是假日期。
 */
export function materialCutoff(
  entries: readonly AuditEvidence[],
  disclosureDomains: readonly string[] = []
): MaterialCutoff {
  let best: { at: number; period: string; refs: string[]; primary: boolean } | undefined;
  for (const e of entries) {
    const origin = disclosureOrigin(e, disclosureDomains);
    if (origin === "thirdparty") continue;
    if (periodKind(e) !== "reporting") continue;
    const end = periodEnd(e.period);
    if (!end) continue;
    const at = end.getTime();
    if (!best || at > best.at) {
      best = { at, period: (e.period ?? "").trim(), refs: [e.id], primary: origin === "primary" };
    } else if (at === best.at) {
      best.refs.push(e.id);
      // 同一期里只要有一条是一手的，这一天就算一手撑起来的 —— 镜像那份是它的副本。
      best.primary = best.primary || origin === "primary";
    }
  }

  if (!best) {
    return {
      status: "undetermined",
      date: "",
      period: "",
      refs: [],
      label: "未确定",
      why:
        `台账 ${entries.length} 条里没有一条带得出经营数据报告期：` +
        "事件发生时间（产线哪一年建成、公告哪天发的）和检索时间（我们哪天抓的）都不是材料截止日。",
    };
  }

  const date = new Date(best.at).toISOString().slice(0, 10);
  const refs = best.refs.join("、");
  return {
    status: "dated",
    date,
    origin: best.primary ? "primary" : "mirrored",
    period: best.period,
    refs: best.refs,
    label: best.primary ? date : `${date}（镜像转载的公司披露，原站未核对）`,
    why: best.primary
      ? `台账里最晚的一份一手披露报告期是「${best.period}」（${refs}）。`
      : `台账里最晚的一份公司披露报告期是「${best.period}」（${refs}），取自镜像转载站 —— ` +
        "内容是公司自己发的，但原站与这份转载的身份没有逐字核过，所以不升格为一手。",
  };
}

/* -------------------------------------------------------------------------- */
/* 新鲜度：拿没拿到最近一期（A4-N09 的判据）                                   */
/* -------------------------------------------------------------------------- */

export interface DisclosureFreshness {
  /** 有没有一份最近一期的**一手**披露。这是 A4-N09 原本问的那一件事。 */
  primaryFresh: boolean;
  /** 有没有最近一期的**公司材料**，含镜像转载。**这一栏答的才是「有没有近期公司信息」。** */
  companyFresh: boolean;
  /** 撑起 `primaryFresh` 的编号。 */
  primaryRefs: string[];
  /** 落在镜像那一档的编号。 */
  mirroredRefs: string[];
  /** 窗口内最晚的那一期的期次原文，没有就是空串。 */
  latestPeriod: string;
}

/**
 * 台账里有没有最近一期的公司材料，**一手和镜像分开数**。
 *
 * ISS-239 的机检说了一句「没拿到最新披露」，而同一份台账里挂着 2025 年报和 2026 年 5 月的
 * 投资者交流记录。那句话不算撒谎（它检查的是指定域名 + 期次，两条都不满足），但读的人
 * 从它读到的是「这家公司近期没有公开信息」—— 而那是假的。所以这里把两问分开：
 *
 *   · `primaryFresh === false` 该说的是「**没从一手站上拿到**最近一期」；
 *   · `companyFresh === false` 才是「**近期公司材料一条都没有**」。
 *
 * 窗口和 `periodWithin` 同一个（`FRESHNESS_MONTHS`）；期次种类同 `materialCutoff`
 * （只认 `reporting`）—— 一条产线的建成年份再新也不是一期经营数据。
 */
export function disclosureFreshness(
  entries: readonly AuditEvidence[],
  now: Date,
  opts: { disclosureDomains?: readonly string[]; months?: number } = {}
): DisclosureFreshness {
  const domains = opts.disclosureDomains ?? [];
  const months = opts.months ?? FRESHNESS_MONTHS;
  const primaryRefs: string[] = [];
  const mirroredRefs: string[] = [];
  let latest: { at: number; period: string } | undefined;

  for (const e of entries) {
    const origin = disclosureOrigin(e, domains);
    if (origin === "thirdparty") continue;
    if (periodKind(e) !== "reporting") continue;
    if (!periodWithin(e.period, now, months)) continue;
    (origin === "primary" ? primaryRefs : mirroredRefs).push(e.id);
    const end = periodEnd(e.period);
    if (end && (!latest || end.getTime() > latest.at)) {
      latest = { at: end.getTime(), period: (e.period ?? "").trim() };
    }
  }

  return {
    primaryFresh: primaryRefs.length > 0,
    companyFresh: primaryRefs.length + mirroredRefs.length > 0,
    primaryRefs,
    mirroredRefs,
    latestPeriod: latest?.period ?? "",
  };
}
