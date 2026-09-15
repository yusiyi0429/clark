/**
 * 证据台账。**事实归台账所有，不归模型所有（HP-2）。**
 *
 * 报告正文里每个事实性数字都要绑一条台账条目。模型记忆里的数字不许入文 —— 那是
 * 「整体上架率约 60%」这一整类错误的来源：一个记忆里的旧数，措辞精确、无从对账。
 *
 * ## 入账三道门，全是确定性的，不调模型
 *
 * 1. **七项必填** —— 少一项直接拒。缺 `authorityClass` 的条目下游没法判「核心结论是不是
 *    只有媒体转述在撑」；缺 `supportRelation` 的条目没法判「反证有没有被应答」。
 * 2. **URL 必须抓过** —— 不在本轮快照里的地址一律拒（HP-1）。检索摘要里的裸数字进不来。
 * 3. **引句必须在原文里定位得到** —— `spanmatch.locate` 说不在，就是不在。
 *
 * 第三道是性价比最高的一道：确定性、零成本，抓的是「引了一个真实存在的页面，但那页里
 * 根本没有这个数字」。而这正是「有来源」和「来源撑得起这句话」之间的全部差别。
 *
 * ## 被拒的留着
 *
 * `rejections` 不清空。「抽了 12 条，进了 5 条，7 条因为引句定位不到被拒」是这次运行
 * 最有信息量的一行 —— 拒得多说明抽取在编，拒得少说明抽取在抄。只留成功条目的话，
 * 一次「12 条全被拒」和一次「一条都没抽」在记录里长得一模一样。
 */

import { locate } from "./spanmatch";
import { attributable } from "./coverage";
import type { Snapshot } from "./fetch";

/** 这条证据对命题是什么关系。反证必须能被单独数出来（CH-4 靠它）。 */
export type SupportRelation = "supports" | "refutes" | "qualifies";

export type EvidenceType = "statistic" | "statement" | "event" | "document";

/** 谁在说这句话。档次（`sourceTier`）由它推出来。 */
export type AuthorityClass =
  | "regulator"
  | "official_statistics"
  | "company_primary"
  | "industry_body"
  | "media"
  | "other";

/** 这个数被当成什么用。区分不开就抓不到「拿旧数描述现状」（GOLD-02）。 */
export type UsedAs = "current_state" | "historical_point";

/** A 政府监管与法定披露 / B 行业机构与券商 / C 主流媒体 / D 转载与其他。 */
export type SourceTier = "A" | "B" | "C" | "D";

/** 抽取器交上来的一条。`sourceTier` 与 `span` 由代码补，不许模型自己填。 */
export type EvidenceDraft = {
  propositionId: string;
  claim: string;
  exactQuote: string;
  url: string;
  supportRelation: SupportRelation;
  evidenceType: EvidenceType;
  authorityClass: AuthorityClass;
  usedAs?: UsedAs;
  /** 口径四件套。缺了不拒，但缺了口径检查就没有物质基础，所以抽取提示词里要求填。 */
  value?: number;
  unit?: string;
  precision?: string;
  period?: string;
  geography?: string;
};

export type Evidence = EvidenceDraft & {
  id: string;
  sourceDomain: string;
  siteName?: string;
  contentHash: string;
  retrievedAt: string;
  sourceTier: SourceTier;
  /** 引句在快照原文里的字符区间。事后重放靠它。 */
  span: [number, number];
  /** 原文里那一段（不是模型抄的那一段）。出口闸对账用这个。 */
  excerpt: string;
  usedAs: UsedAs;
  verificationStatus: "span_matched";
  /** `independence.assign` 折出来的组。入账时先留空，抓取批次结束后统一回填。 */
  independenceGroup: string;
};

export type Rejection = { propositionId: string; claim: string; url: string; why: string };

const REQUIRED = [
  ["propositionId", "命题编号"],
  ["claim", "这条证据支持的说法"],
  ["exactQuote", "原文引句"],
  ["url", "来源地址"],
  ["supportRelation", "支持还是反驳"],
  ["evidenceType", "证据类型"],
  ["authorityClass", "谁在说"],
] as const;

/**
 * `authorityClass` → A/B/C/D（DM-3a）。
 *
 * 无人担责的域名（文库、个人发布）一律压到 D，**不管抽取器给了什么档** —— 一份上传到
 * 文库的 PPT 里写着「工信部数据」，它仍然是一份来路不明的 PPT。
 */
function tierOf(authority: AuthorityClass, domain: string): SourceTier {
  if (!attributable(domain)) return "D";
  switch (authority) {
    case "regulator":
    case "official_statistics":
    case "company_primary":
      return "A";
    case "industry_body":
      return "B";
    case "media":
      return "C";
    default:
      return "D";
  }
}

const domainOf = (url: string): string => (url.includes("://") ? url.split("/")[2] ?? "" : "");

/**
 * 台账。一次深研一本。
 *
 * 不落盘 —— MVP 里它活在这一次运行里，最终形态是报告的溯源码与「未能核实」一节。
 * 落库那一档等有人要「跨两次深研比对同一个数」的时候再说。
 */
export class Ledger {
  readonly entries: Evidence[] = [];
  readonly rejections: Rejection[] = [];
  /** 抓回来的快照，按 URL。入账时要拿原文做引句定位。 */
  private readonly pages = new Map<string, Snapshot>();
  /** 去重键：同一页、同一命题、同一段原文，只入一次。 */
  private readonly seen = new Set<string>();
  private n = 0;

  /** 把这一批快照挂进来。挂过的 URL 才允许入账。 */
  archive(pages: Snapshot[]): void {
    for (const p of pages) this.pages.set(p.url, p);
  }

  snapshot(url: string): Snapshot | undefined {
    return this.pages.get(url);
  }

  byId(id: string): Evidence | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /**
   * 入账，或者说明为什么不入。
   *
   * 返回入账后的条目；被拒返回 `null`，原因已记进 `rejections`。
   */
  record(d: EvidenceDraft): Evidence | null {
    const reject = (why: string): null => {
      this.rejections.push({
        propositionId: d.propositionId ?? "",
        claim: (d.claim ?? "").slice(0, 120),
        url: d.url ?? "",
        why,
      });
      return null;
    };

    const missing = REQUIRED.filter(([k]) => !String(d[k] ?? "").trim()).map(([, label]) => label);
    if (missing.length) return reject(`缺必填项：${missing.join("、")}`);

    const page = this.pages.get(d.url);
    // 没抓过的地址进不来。这一句就是 HP-1：搜索摘要不能创建证据。
    if (!page) return reject("这个地址本轮没有抓到正文，摘要里的数字不能入账");

    const span = locate(d.exactQuote, page.text);
    if (!span) {
      return reject(
        page.truncated
          ? "引句在抓到的正文里定位不到（这一页被截断过，也可能在截掉的部分里）"
          : "引句在原文里定位不到"
      );
    }

    const key = `${page.contentHash}|${d.propositionId}|${span[0]}-${span[1]}`;
    if (this.seen.has(key)) return reject("同一页同一段原文已为这条命题入过账");
    this.seen.add(key);

    this.n += 1;
    const sourceDomain = domainOf(d.url);
    const entry: Evidence = {
      ...d,
      id: `E${this.n}`,
      sourceDomain,
      siteName: page.title || undefined,
      contentHash: page.contentHash,
      retrievedAt: page.retrievedAt,
      sourceTier: tierOf(d.authorityClass, sourceDomain),
      span,
      excerpt: page.text.slice(span[0], span[1]),
      usedAs: d.usedAs ?? "current_state",
      verificationStatus: "span_matched",
      independenceGroup: "",
    };
    this.entries.push(entry);
    return entry;
  }

  /**
   * 把**别处已经记好**的证据并进这本账，统一重编号。
   *
   * 两个用处，是同一件事：
   *
   *  · `sweep` 合并四条维度链（每条又按波各建一本台账）
   *  · A4 拿预研那一轮记下的证据垫底（`A4Input.preEvidence`）
   *
   * ## 为什么必须重编号
   *
   * `record` 的编号是**实例内自增**（`this.n` 从 0 起），所以两本账的条目编号一定撞。
   * 原来的合并是 `merged.entries.push(...run.entries)` —— 绕过这里，编号原样带过去，
   * 于是证据包里会有好几条不同的证据都叫 `E1`。**而报告正文引的就是这个编号**：
   * 一号位看到「[E1]」时，它指向哪一条取决于下游先遇到谁。这类错不会报，只会让
   * 溯源静默失真。
   *
   * 顺序照传入顺序，所以调用方保序（`mapPool` 保序、`CHAINS` 定序）时，同一批输入
   * 跑两遍得到的是同一套编号。
   *
   * ## 除了编号，一个字都不动
   *
   * 引句、跨度、档次、`contentHash` 都是记账那一刻核出来的结论，重编号不该碰它们。
   * 去重键要补进来，否则同一页同一段会被再入一次账 —— 而覆盖判定数的是独立来源，
   * 重复入账会让一条只有一个来源的命题看起来有两个。
   *
   * ## 不往 `pages` 里塞
   *
   * 并进来的条目没有对应的快照（预研那一轮的正文没留着，留着会让 `PreResearchDoc`
   * 膨胀到不可接受）。代价是 `snapshot(url)` 对这些 URL 返回 undefined，于是
   * `evidence.ts` 那句 `hits.filter((x) => !ledger.snapshot(x.url))` 不会跳过它们，
   * 同一个地址**可能被再抓一次**。这是有意的取舍：重抓一次的代价是几秒，而拿一份
   * 只有摘录的假快照去给新引句定位，会把「这一页确实没有这句话」判成「有」。
   */
  adopt(prior: readonly Evidence[]): Evidence[] {
    const out: Evidence[] = [];
    for (const e of prior) {
      this.n += 1;
      const entry: Evidence = { ...e, id: `E${this.n}` };
      this.seen.add(`${e.contentHash}|${e.propositionId}|${e.span[0]}-${e.span[1]}`);
      this.entries.push(entry);
      out.push(entry);
    }
    return out;
  }

  /** 回填独立性组。`groups` 是 URL → 组名。 */
  fold(groups: Map<string, string>): void {
    for (const e of this.entries) e.independenceGroup = groups.get(e.url) ?? `dom:${e.sourceDomain}`;
  }

  forProposition(propositionId: string): Evidence[] {
    return this.entries.filter((e) => e.propositionId === propositionId);
  }
}
