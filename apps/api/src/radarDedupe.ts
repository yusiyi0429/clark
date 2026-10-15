import type { TIssueLocation } from "@warmap/contracts";

/**
 * 雷达去重：议题层（升级前判重、挂靠）与信号层（同一篇文章不同来源只留一条）共用的确定性相似度。
 *
 * 相似度 = 归一化后 token bigram 的 Dice 系数：中文按单字切分，连续的英文 / 数字算一个 token
 * （否则「TokenOps」一个词会贡献 7 个 bigram，把所有带同一英文名的标题都拉成「相似」）。
 * 议题标题还会先去掉公司名与「是否 / 要不要」等提问套话，只比较真正的决策内容。
 */

/** 同一战场两条议题标题相似度达到该值视为同一个决策问题（模型漏判时的兜底）。 */
export const ISSUE_DUPLICATE_THRESHOLD = 0.6;
/** 两条信号的文章标题相似度达到该值视为同一篇文章（转载、移动版、不同检索来源）。 */
export const ARTICLE_DUPLICATE_THRESHOLD = 0.8;
/** 文章标题核心部分太短时不做标题去重，避免把「快讯」「早报」之类的短标题误判为同一篇。 */
export const ARTICLE_TITLE_MIN_LENGTH = 8;
/** 信号层去重回看的已入库信号天数。 */
export const ARTICLE_DEDUPE_LOOKBACK_DAYS = 14;

const QUESTION_FILLERS = ["是否需要", "是否要", "要不要", "是不是", "是否", "应否", "能否", "如何", "怎样", "怎么"];

function baseNormalize(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

/** 中文单字、英文 / 数字连续串各算一个 token；标点与空白丢弃。 */
export function titleTokens(value: string): string[] {
  return baseNormalize(value).match(/[a-z0-9]+|[\p{Script=Han}]|[^\s\p{P}\p{S}a-z0-9\p{Script=Han}]/gu) ?? [];
}

function bigrams(tokens: string[]): Map<string, number> {
  const grams = new Map<string, number>();
  if (tokens.length === 1) grams.set(tokens[0], 1);
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const gram = `${tokens[index]}\u0000${tokens[index + 1]}`;
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

/** token bigram Dice 系数，0–1。 */
export function tokenSimilarity(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  if (left.join(" ") === right.join(" ")) return 1;
  const a = bigrams(left);
  const b = bigrams(right);
  let shared = 0;
  let total = 0;
  for (const count of a.values()) total += count;
  for (const count of b.values()) total += count;
  for (const [gram, count] of a) shared += Math.min(count, b.get(gram) ?? 0);
  return total === 0 ? 0 : (2 * shared) / total;
}

/** 议题标题的决策内容：去掉公司名（中文名与代号）和提问套话。 */
export function issueTitleCore(title: string, companyNames: string[] = []): string[] {
  let text = baseNormalize(title);
  const names = [...companyNames].filter(Boolean).map(baseNormalize).sort((a, b) => b.length - a.length);
  for (const name of names) text = text.split(name).join(" ");
  for (const filler of QUESTION_FILLERS) text = text.split(filler).join(" ");
  return titleTokens(text);
}

export function issueTitleSimilarity(left: string, right: string, companyNames: string[] = []): number {
  return tokenSimilarity(issueTitleCore(left, companyNames), issueTitleCore(right, companyNames));
}

/**
 * 两个议题是否在同一个战场范围：capability 只和同一 capability 比；
 * 战场 / 公司级按关联战场集合有交集判定；两边都是未归属的公司级也算同一范围。
 */
export function sameIssueScope(left: TIssueLocation, right: TIssueLocation): boolean {
  if (left.level === "capability" || right.level === "capability") {
    return left.level === "capability" && right.level === "capability" && left.capabilityId === right.capabilityId;
  }
  const set = (location: TIssueLocation) => location.level === "battlefield" ? [location.battlefieldId]
    : location.level === "company" ? location.relatedBattlefieldIds : [];
  const a = set(left);
  const b = set(right);
  if (a.length === 0 && b.length === 0) return true;
  return a.some((id) => b.includes(id));
}

export type ExistingIssueRef = { id: string; title: string; location: TIssueLocation };

/** 同一范围内与候选标题最相似且达到阈值的现有议题；没有则 null。 */
export function findSimilarIssue<T extends ExistingIssueRef>(
  candidate: { title: string; location: TIssueLocation },
  existing: T[],
  companyNames: string[] = [],
  threshold = ISSUE_DUPLICATE_THRESHOLD,
): { issue: T; similarity: number } | null {
  let best: { issue: T; similarity: number } | null = null;
  for (const issue of existing) {
    if (!sameIssueScope(candidate.location, issue.location)) continue;
    const similarity = issueTitleSimilarity(candidate.title, issue.title, companyNames);
    if (similarity >= threshold && (!best || similarity > best.similarity)) best = { issue, similarity };
  }
  return best;
}

/**
 * 文章标题核心：网页标题常带「_腾讯新闻」「-虎嗅网」「|服务器|机房」之类的站点名与标签，
 * 按分隔符切开取最长的一段作为正文标题。
 */
export function articleTitleCore(title: string): string {
  const parts = baseNormalize(title).split(/[_|｜]/u)
    // 末尾「-站点名」：分隔符后不超过 14 个字符才当站点名切掉
    .flatMap((part) => part.split(/\s*[-–—]+\s*(?=[^-–—]{1,14}$)/u))
    .map((part) => part.trim()).filter(Boolean);
  const longest = parts.reduce((best, part) => (part.length > best.length ? part : best), "");
  return longest || baseNormalize(title).trim();
}

export function sameArticle(leftTitle: string, rightTitle: string, threshold = ARTICLE_DUPLICATE_THRESHOLD): boolean {
  const left = titleTokens(articleTitleCore(leftTitle));
  const right = titleTokens(articleTitleCore(rightTitle));
  if (left.length < ARTICLE_TITLE_MIN_LENGTH || right.length < ARTICLE_TITLE_MIN_LENGTH) return false;
  return tokenSimilarity(left, right) >= threshold;
}

/** 议题依据里「雷达补充」条目：存在 issues.origin_ref.supplementarySignals。 */
export type SupplementarySignal = {
  signalId: string;
  sourceTitle: string;
  sourceUrl: string;
  evidenceQuote: string;
  summary: string;
  attachedAt: string;
  /** model：模型判定同一决策问题；similarity：标题相似度兜底；merge：清理脚本合并。 */
  via: "model" | "similarity" | "merge";
};

export const SUPPLEMENT_TITLE_PREFIX = "雷达补充：";

export function supplementarySignalsOf(originRef: unknown): SupplementarySignal[] {
  if (!originRef || typeof originRef !== "object") return [];
  const list = (originRef as { supplementarySignals?: unknown }).supplementarySignals;
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is SupplementarySignal => !!item && typeof item === "object"
    && typeof (item as SupplementarySignal).signalId === "string"
    && typeof (item as SupplementarySignal).sourceTitle === "string"
    && typeof (item as SupplementarySignal).evidenceQuote === "string"
    && (item as SupplementarySignal).evidenceQuote.length > 0);
}

/** 把雷达补充信号投影成议题页「判断的依据」条目，已有同一句引文的不重复列。 */
export function withSupplementaryEvidence<T extends { quote: string; sourceTitle: string; sourceUrl?: string }>(
  evidence: T[],
  originRef: unknown,
): (T | { quote: string; sourceTitle: string; sourceUrl?: string })[] {
  const supplements = supplementarySignalsOf(originRef);
  if (supplements.length === 0) return evidence;
  const quotes = new Set(evidence.map((item) => item.quote));
  const extra = supplements.filter((item) => !quotes.has(item.evidenceQuote)).map((item) => ({
    quote: item.evidenceQuote,
    sourceTitle: `${SUPPLEMENT_TITLE_PREFIX}${item.sourceTitle}`.slice(0, 500),
    ...(/^https?:\/\/\S+$/.test(item.sourceUrl) ? { sourceUrl: item.sourceUrl } : {}),
  }));
  return [...evidence, ...extra];
}
