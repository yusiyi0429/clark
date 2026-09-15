/**
 * 检索命中的排序：决定一波里**抓哪几页**。
 *
 * ## 为什么要有这一层（2026-09-04）
 *
 * ISS-227 那一轮四条链共命中 560 条，每链只抓 5 页，抓的顺序是「通义种子在前、检索结果按
 * 返回顺序」。结果抓到的是 jiepei.com 的设计页、hangyan.co 的图表页、csdn 的论坛帖 ——
 * 16 次抽取只入账 1 条。**560 条里不缺好页，缺的是挑页。**
 *
 * ## 只做三件事，都是启发式，都写在明处
 *
 * 1. **提到研究主体的排前面。** 命题是行业宏观的（渗透率、代线、稼动率），但这份报告要落回
 *    的是这一家公司；标题或摘要里出现主体名的那几页，抽出来的才是能改判断的东西
 *    （227 里唯一入账的那条就是这样一页）。
 * 2. **披露与财经主站加分，论坛 / 问答 / 图表聚合减分。** 加分的是交易所、巨潮、政府站与
 *    几家有采编的财经媒体；减分的是 bbs / 贴吧 / 知乎 / csdn / 微博 / 图表站 —— 这些页要么
 *    没有可核的原句，要么是二手转述。
 * 3. **种子只加一分。** 通义那一步挑的页有它的判断，但 227 证明它也会挑到设计站和论坛；
 *    一分意味着同分时它先，垃圾站的减分照样压得过它。
 *
 * 分数是排序键，不是过滤：一条都不丢，只是排到后面。抓不抓得到、抽不抽得出仍由后面的步骤
 * 说了算。排序稳定：同分保持原顺序，两家检索的返回顺序仍是最后的裁决。
 *
 * **不做的事**：不按发布时间排（各家给的时间格式不一、常缺）；不按域名白名单过滤（那是
 * `fetch.ts` 头部那条防注入的白名单，管的是「只抓检索返回过的地址」，与好坏无关）。
 */
import type { SearchHit } from "./search";

/** 有采编、有原文可核的站。加 2 分。 */
const STRONG_HOSTS = [
  "cninfo.com.cn",
  "sse.com.cn",
  "szse.cn",
  "gov.cn",
  "stcn.com",
  "cs.com.cn",
  "cls.cn",
  "21jingji.com",
  "yicai.com",
  "caixin.com",
  "finance.sina.com.cn",
  "finance.eastmoney.com",
  "eet-china.com",
  "laoyaoba.com",
  "ofweek.com",
];

/**
 * **一手披露的落点。** 这几家站上的东西是发行人自己签字发出来的，不是谁转述的。
 *
 * 2026-09-07 单独拉出来（`STRONG_HOSTS` 里已经有前三家，那两张表管的不是同一件事）：
 * `STRONG_HOSTS` 是排序加分，而这张表决定**抓取位保留**（`research/slots.ts`）和
 * **抓取超时与体积放宽**（`fetch.ts` 的 `limitsFor`）—— 两处都不是「好一点」，是
 * 「不这么做就永远拿不到」。
 *
 * ISS-238 的账：一份深研拿 2024 年报下了「现金流薄」的判断，而 2026 年 4 月发布的 2025 年报
 * （经营现金流回升到 23 亿）当时就挂在巨潮上。它没进来的直接原因有两个，都在这张表上 ——
 * 年报要和八个转载页抢一波 8 个抓取位；年报 PDF 5–20 MB，30 秒抓不完。
 *
 * 调用方会把主体卡的官网域名（`SubjectCard.website`）并进来：重大公告和 IR 材料也是一手的。
 */
export const DISCLOSURE_HOSTS = [
  "cninfo.com.cn",
  "static.cninfo.com.cn",
  "sse.com.cn",
  "szse.cn",
  "hkexnews.hk",
  "neeq.com.cn",
] as const;

/** url → 主机名。取不出来（相对地址、脏字符串）时返回空串，下面那个判定跟着落假。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * 这个地址是不是一手披露。**按主机名的后缀段比，不用 `url.includes`。**
 *
 * `includes` 在这里会出两种事：`cninfo.com.cn` 出现在别人的查询串里（`?q=cninfo.com.cn`）
 * 也算命中；而 `extra` 里混进一个空串时它对每一条 url 都成立 —— 官网域名是模型给的，
 * 空串是它最常见的产物。所以这里只认 `host === d` 或 `host` 以 `.d` 结尾，空串直接跳过。
 */
export function isDisclosureUrl(url: string, extra: readonly string[] = []): boolean {
  const host = hostOf(url);
  if (!host) return false;
  for (const d of [...DISCLOSURE_HOSTS, ...extra]) {
    const dom = d.trim().toLowerCase();
    if (!dom) continue;
    if (host === dom || host.endsWith(`.${dom}`)) return true;
  }
  return false;
}

/** 论坛、问答、图表聚合、个人号。减 3 分。 */
const WEAK_HOSTS = [
  "bbs.",
  "tieba.",
  "zhihu.com",
  "csdn.net",
  "douban.com",
  "weibo.",
  "hangyan.co",
  "/charts/",
  "jiepei.com",
  "baijiahao.baidu.com",
  "caifuhao.eastmoney.com",
  "sohu.com/a/",
  "toutiao.com",
];

/**
 * 这台抓取器**抓不动**的站。抵掉 `STRONG_HOSTS` 那 2 分，再压 1 分。
 *
 * 2026-09-04 三轮真运行（228/229/230）的抓取失败清单里，合肥市政府各子站（hfxz / drc / gxj / gxq）
 * 一共 403/521 了 14 次，eet-china 的 /mp/ 页超时了 10 次，两家加起来占掉了三轮里约三分之一的
 * 抓取名额（一波只有 8 页）。它们在 `STRONG_HOSTS` 里各加着 2 分（gov.cn、eet-china.com），
 * 于是每一波都排在前面、每一波都白抓。这里不是说它们不好，是说**我们拿不到**——哪天抓取层
 * 过得去了，把它从这张表上摘掉即可。分数仍不是过滤：命中里只剩它们时照样抓。
 */
const UNREACHABLE_HOSTS = ["hefei.gov.cn", "eet-china.com/mp/"];

/** 主体名切成 ≥2 字的片段：「维信诺」整词命中最好，但「维信诺科技股份」这类长名要能按片段认。 */
export function subjectTokens(subject: string): string[] {
  const s = subject.replace(/[（(].*?[)）]/g, "").trim();
  if (!s) return [];
  const parts = s.split(/[\s·、,，/]+/).filter((x) => x.length >= 2);
  return parts.length ? parts : [s];
}

/**
 * 标题或摘要里提到主体没有。
 *
 * 抬出来是因为抓取位保留（`research/slots.ts`）问的是同一件事，而两边各写一份的话，
 * 「排序认得出这是主体材料、保留位认不出」会成立，且没有任何症状。
 */
export function mentionsSubject(hit: SearchHit, subject: string): boolean {
  const tokens = subjectTokens(subject);
  if (!tokens.length) return false;
  const text = `${hit.title ?? ""} ${hit.snippet ?? ""}`;
  return tokens.some((t) => text.includes(t));
}

export function scoreHit(hit: SearchHit, subject: string, isSeed: boolean): number {
  let score = 0;
  const url = hit.url.toLowerCase();
  if (mentionsSubject(hit, subject)) score += 3;
  if (STRONG_HOSTS.some((h) => url.includes(h))) score += 2;
  if (WEAK_HOSTS.some((h) => url.includes(h))) score -= 3;
  if (UNREACHABLE_HOSTS.some((h) => url.includes(h))) score -= 3;
  // PDF 现在能抓了（`fetch.ts`），但仍比 HTML 慢、正文也更容易是扫描件，压半档。
  if (/\.pdf(\?|$)/.test(url)) score -= 1;
  if (isSeed) score += 1;
  return score;
}

/**
 * 稳定排序。`seedUrls` 里的地址按种子计分。
 */
export function rankHits(hits: readonly SearchHit[], subject: string, seedUrls: ReadonlySet<string>): SearchHit[] {
  return hits
    .map((hit, i) => ({ hit, i, score: scoreHit(hit, subject, seedUrls.has(hit.url)) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.hit);
}
