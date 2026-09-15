/**
 * 抓取位保留：一波 8 页里，先给一手披露和主体材料留下位子。
 *
 * ## 为什么（2026-09-07，ISS-238）
 *
 * 那一轮深研拿 2024 年报下了「现金流薄」的判断，而 2026 年 4 月发布的 2025 年报（经营现金流
 * 回升到 23 亿）当时就挂在巨潮上、也确实被搜到了。它没进账的原因不是排序不好 ——
 * `rankHits` 给了它披露站那 2 分 —— 而是**位子不够**：一波只抓 `PAGES_PER_ROUND=8` 页，
 * 而八个转载页在标题里全都写着主体名（+3 分），分数比一份 PDF 年报（披露 +2、PDF −1）还高。
 * 于是每一波的八个位子都被同一批转述稿占满，年报排在第十几位，一次都没轮上。
 *
 * 排序解决不了这件事：加分再加也只是换一个名次，而名次在第 9 位和第 90 位对结果是一样的。
 * **这一层解决的是「哪几类必须有位子」，不是「谁更好」。**
 *
 * ## 三条规则，都写在明处
 *
 * 1. 一手披露（巨潮 / 沪深交易所 / 港交所 / 新三板 / 主体官网）最多占 2 位。
 * 2. 其余主体材料（标题或摘要里出现主体名）最多占 2 位。
 * 3. 剩下的位子按传入顺序 —— 也就是 `rankHits` 排完的顺序，不再动。
 *
 * 上限是 2 而不是更多：这一层是保底，不是改判。披露站一次搜出十几条（同一份公告的多个
 * 镜像页很常见），全放进来的话一波八页会变成「只读了一家的东西」，而共源折叠
 * （`independence.ts`）恰恰要靠这一波里有几家不同的来源才有得折。
 *
 * ## 输入必须是已经排好序的
 *
 * 这是**重排**，不是排序：一条都不丢，只是把该保的提前，剩下的原样跟在后面。所以
 * `rankHits` 的结果直接喂进来，两层各管各的，改任何一层都不影响另一层的理由。
 */

import { isDisclosureUrl, mentionsSubject } from "./rank";
import type { SearchHit } from "./search";

/** 一波默认抓几页。与 `a4/evidence.ts` 的 `PAGES_PER_ROUND` 对齐，由调用方显式传。 */
const DEFAULT_TOTAL = 8;

/** 一手披露最多占几位。 */
const MAX_DISCLOSURE = 2;
/** 其余主体材料最多占几位。 */
const MAX_SUBJECT = 2;

export type ReserveOpts = {
  /**
   * 除了 `DISCLOSURE_HOSTS` 那几家之外，还有哪些域名算一手披露。
   *
   * 实际传进来的是主体卡的官网域名（`SubjectCard.website`）：重大公告、业绩说明会材料和
   * 业务介绍都挂在自己的 IR 页上，那也是一手的。空串会被 `isDisclosureUrl` 跳过 ——
   * 模型不给官网时那一栏就是空串，而空串按 `includes` 匹配的话每一条 url 都算披露。
   */
  disclosureDomains?: readonly string[];
  /** 研究主体的名字（主体卡 `subject`）。不给就没有第二类保留位。 */
  subject?: string;
  /** 这一波的抓取位总数。保留位从里面出，不是额外加的。 */
  total?: number;
};

/**
 * 重排一波命中，让一手披露和主体材料先拿到位子。**输出是输入的一个排列，不多不少。**
 */
export function reserveSlots(hits: readonly SearchHit[], opts: ReserveOpts = {}): SearchHit[] {
  const total = Math.max(0, opts.total ?? DEFAULT_TOTAL);
  if (!hits.length || !total) return [...hits];

  const extra = opts.disclosureDomains ?? [];
  const subject = opts.subject ?? "";

  // 按下标分类，不按 url：同一个 url 万一出现两次，按 url 收口会把第二条整个吃掉，
  // 而这一层的全部承诺是「一条都不丢」。
  const disclosure: number[] = [];
  const subjectOwn: number[] = [];
  hits.forEach((hit, i) => {
    if (isDisclosureUrl(hit.url, extra)) disclosure.push(i);
    else if (mentionsSubject(hit, subject)) subjectOwn.push(i);
  });

  const reserved = [...disclosure.slice(0, MAX_DISCLOSURE), ...subjectOwn.slice(0, MAX_SUBJECT)].slice(0, total);
  if (!reserved.length) return [...hits];

  const taken = new Set(reserved);
  // 保留位按「披露在前、主体材料在后」摆，各类内部保持传入顺序；其余原样跟在后面。
  return [...reserved.map((i) => hits[i]), ...hits.filter((_, i) => !taken.has(i))];
}
