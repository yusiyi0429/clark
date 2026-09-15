/**
 * 「这一份手上没有外部证据」这句声明。
 *
 * ## 为什么要有这一层
 *
 * 真发生过：两家检索一家 403、一家免费额度用尽，二十条检索式条条报错，一份外部证据都
 * 没入账 —— 而这一轮的产出是一份格式漂亮的报告，运行记录写着 ok。要翻到运营台、再展开
 * 那条默认折起来的事件明细，才看得见「入账 0 条」。
 *
 * 报告本身没说假话（`A4-R07` 逼着它写了「未联网」那一句），但那句话在一份三千字的原文
 * 中间，而一号位是从判断板往下读的。**一份没有外部证据的报告和一份有二十条证据的报告，
 * 在他打开的那一屏上长得一模一样** —— 这是这个产品最不能有的一种相同。
 *
 * ## 答的是「空在哪一格」，不是「有没有」
 *
 * 「有没有」是一个布尔值，`recorded === 0` 就够了。这里多做的是分格，因为五种空法的
 * 下一步动作完全不同：
 *
 *  · 压根没联网          —— 正常状态（provider=none 的对照组），没什么要做的。
 *  · 检索全线报错        —— 去控制台（额度 / 开通 / key），代码这边无事可做。
 *  · 检索通了但搜不到    —— 换问法。**这一格最要紧和上一格分开**：说成「检索失败」会让
 *                           他去查一个好着的账号，说成「搜不到」会让他去改一个发不出去
 *                           的问法。
 *  · 搜到了抓不下来      —— 看抓取那一层（反爬、超时）。
 *  · 抓下来了没过入账闸  —— 看抽取那一层（引句定位不上、口径缺件）。
 *
 * 五种在报告上原本长得一模一样。
 *
 * ## 只描述，不判罚
 *
 * 这一层不返回 severity、不置 `degraded`、不进质量门。空手不是违规（HP-5：查不到是合法
 * 结果），它是一件**必须说出来的事实**。判罚会把它推进重修循环，而重修救不回一个欠费的
 * 账号 —— 那只会让一轮深研多烧两遍模型钱之后仍然空手。
 */
import type { NoExternalEvidence } from "@/lib/data/types";

import type { Round } from "./evidence";

export type { NoExternalEvidence } from "@/lib/data/types";

/** 原话最多带几条。同一句重复三十遍不多给一点信息，而它要进报告顶上那一行。 */
const ERRORS_SHOWN = 2;

/**
 * 每条原话最多带这么长。
 *
 * 有上限是因为这句话要上屏：厂商那句人话现在写得很足（豆包 10406 那一条把「账号有余额」
 * 和「开通了付费调用」是两个开关这件事讲完要一百多字），两条原封不动贴上来，报告顶上那
 * 一行就成了一屏字，而一屏字和没写是一个效果。完整原话仍然在 trace 里。
 */
const ERROR_CLIP = 200;

/**
 * 这一轮到底空没空手；空了的话空在哪一格。
 *
 * 返回 `undefined` = 入账过外部证据，没什么要声明的。**有值就是一份没有外部证据的报告**，
 * 调用方要把它摆到人看得见的地方（报告顶上那一行、事件标题），不是只落进 trace。
 *
 * 数按**主源那一条链路**传（判断板和四节都只从它压出来）。别的链路各自的数在
 * `A4Evidencing.lanes` 里，一条一条摆着。
 */
export function noExternalEvidence(a: {
  /** 检索家的中文说法（「博查 + 豆包搜索」）。上屏用它，不用代号。 */
  providerLabel: string;
  /** 主源编了几条待查命题。0 = 这一轮根本没走取证那几步。 */
  propositions: number;
  /** 主源入账几条。>0 就返回 undefined。 */
  recorded: number;
  /** 主源每一轮的账。**加起来看** —— 补搜轮换了问法，只看最后一轮会把「搜到过」说成没搜到。 */
  rounds: Round[];
}): NoExternalEvidence | undefined {
  if (a.recorded > 0) return undefined;

  const headline = (tail: string) => `这一份没有外部证据 · ${tail}`;

  // ---- 压根没联网 --------------------------------------------------------
  /*
   * 判据是「编了几条命题」而不是「跑了几轮」：命题是取证的入口，没有命题就一条检索式
   * 都没发出去。这一格不提检索家 —— 提了会让人去查一个通着的接口。
   */
  if (!a.propositions || !a.rounds.length) {
    return {
      headline: headline("这一轮没有联网取证"),
      why: "这一轮没有联网取证。报告里的外部说法全部来自模型的既有知识，落地引用之前每一条都要先自己核一遍。",
    };
  }

  const sum = (pick: (r: Round) => number) => a.rounds.reduce((n, r) => n + pick(r), 0);
  const queries = sum((r) => r.queries);
  const hits = sum((r) => r.hits);
  const fetched = sum((r) => r.fetched);
  const rejected = sum((r) => r.rejected);
  const failures = sum((r) => r.searchErrors.length);
  /*
   * 一次「尝试」是一条检索式发给一家。除以家数才答得出「是不是条条都失败」——
   * 而每一家在 `searchAll` 里都留了一格账，挂掉的那家也有，所以这个数是准的。
   */
  const attempts = sum((r) => r.queries * Object.keys(r.hitsByProvider).length);
  const tail = "报告里的外部说法全部来自模型的既有知识，落地引用之前每一条都要先自己核一遍。";

  // ---- 一条结果都没回来：检索坏了，还是这几个问法搜不到 --------------------
  if (!hits) {
    if (!failures) {
      return {
        headline: headline("检索通着，但一条结果都没搜到"),
        why: `检索走${a.providerLabel}，${queries} 条检索式一条结果都没搜到 —— 接口是通的，是这几个问法在外面搜不到东西。${tail}`,
      };
    }
    /*
     * 「条条都失败」和「失败了几条」是两句话。前者才说得出「这一份等于没联网」，而后者
     * 读起来像是运气不好 —— 那一轮四十次尝试四十次报错，说成「有几条失败」是在掩饰。
     */
    const shape =
      attempts && failures >= attempts
        ? `${queries} 条检索式发给${a.providerLabel}，每一条都失败`
        : `${queries} 条检索式发给${a.providerLabel}，${attempts} 次里有 ${failures} 次报错，剩下的一条结果都没回来`;
    // 原话去重之后只带头几条：处置方式（充值 / 换 key / 降并发）就写在厂商那句话里。
    const said = [...new Set(a.rounds.flatMap((r) => r.searchErrors))]
      .slice(0, ERRORS_SHOWN)
      .map((e) => (e.length > ERROR_CLIP ? `${e.slice(0, ERROR_CLIP)}…` : e));
    return {
      headline: headline("检索这一层没出网成功"),
      why: `${shape}。原话：${said.join("；")}。${tail}`,
    };
  }

  // ---- 搜到了，卡在后面两格 ------------------------------------------------
  if (!fetched) {
    return {
      headline: headline("搜到了，一页都没抓下来"),
      why: `检索走${a.providerLabel}，搜到 ${hits} 条地址，一页都没抓下来（反爬或超时）—— 证据只能来自抓回来的正文，所以这一轮手上是空的。${tail}`,
    };
  }
  return {
    headline: headline("抓下来了，没有一条过入账闸"),
    why: `检索走${a.providerLabel}，搜到 ${hits} 条、抓下 ${fetched} 页，其中 ${rejected} 条没过入账闸（引句定位不上或口径缺件），入账 0 条 —— 检索和抓取都是通的，卡在抽取这一层。${tail}`,
  };
}
