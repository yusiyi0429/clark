/**
 * 取证编排。**检索 → 抓取 → 抽取 → 入账 → 折叠 → 判定**，一轮一遍。
 *
 * 这个文件的全部职责是把六段串起来并把每一段的数字留下来。判定在 `props.ts`，
 * 各段机制在 `src/lib/research/`。
 *
 * ## 为什么补搜必须有上限
 *
 * 「没闭合就再搜一轮」这句话写起来自然，跑起来会一直搜到超时 —— 而超时的报告和搜不到
 * 的报告在结果页上都是一片空白。所以轮数由 `Harness.budget.maxRounds` 和每条命题的
 * `extraRoundsCap` 同时封顶，用完就落终态，报告照实写（HP-5）。
 *
 * ## 抽取一页一次调用
 *
 * 不是为了省 token，是为了让失败局部化：某一页格式怪、把抽取顶崩了，只丢那一页，
 * 其余照常入账。整批一次调用的话一处 JSON 坏掉整轮取证归零。
 *
 * **这几页是并着抽的，入账是按页序串着入的。** 抽一页和抽另一页之间没有任何依赖，串着
 * 等只是把等待时间加起来 —— 一页 50 秒、五页四分钟，一轮深研有四条链、每条最多三波，
 * 这一处就是 2026-08-27 那一轮跑到 47 分钟的主要来源（ISS-112）。入账不能跟着并：台账
 * 编号（`E1`、`E2`…）就是入账顺序，而报告正文引的是编号，谁先回来谁先记的话同一批页
 * 跑两遍会得到两套账。所以抽取只负责把稿子读出来，`ledger.record` 留在外面按页序走。
 *
 * ## 这一整套是**按链路**跑的，一轮深研跑三遍
 *
 * 三条链路（DeepSeek / Claude / ChatGPT）各自编命题、各自取证，所以这个函数一轮里被调用
 * 三次，三份台账互不相干（见 `run.ts` 的链路表）。它们唯一共用的东西是检索家阵容。
 *
 * 因此每次调用都要带一个 `LaneRef`：**抽取用哪个模型、进度报到哪条链路、trace 上署谁的
 * 名。** 少了它，三条链路会用同一个模型抽取（`callMessages` 不给 slot 就回落到 harness
 * 那个），而屏幕上和 trace 上会出现三组一模一样的「第 1 轮取证」，谁也分不出是哪条链路的。
 */

import type { Harness } from "@/lib/agent/harness";
import { parseJson } from "@/lib/agent/json";
import { mapPool } from "@/lib/agent/pool";
import type { Slot } from "@/lib/models/slots";
import { fetchPages, distrustBlock, type Snapshot } from "@/lib/research/fetch";
import { assign } from "@/lib/research/independence";
import { Ledger, type EvidenceDraft } from "@/lib/research/ledger";
import { tally, type Tally } from "@/lib/research/coverage";
import { searchAll, type SearchAccount, type SearchHit, type SearchProvider } from "@/lib/research/search";
import { rankHits } from "@/lib/research/rank";
import { reserveSlots } from "@/lib/research/slots";

import { A4_EXTRACT_SYSTEM, buildA4ExtractUser } from "./prompt";
import { judge, type Proposition, type Verdict } from "./props";

/** 一轮取证的账。每个数都要能上屏 —— 漏斗少一格就说不清是哪一段掉的。 */
export type Round = {
  no: number;
  /** 这一轮为哪几条命题搜的。 */
  propositionIds: string[];
  queries: number;
  counterQueries: number;
  hits: number;
  /**
   * 这一轮每家各出了几条。同时用几家时才有第二个键。
   *
   * 两家 `returned` 都高而 `unique` 都低 = 它们在搜同一批页，那时该换问法而不是再加一家。
   * 「哪家搜得好」只能这么答。
   */
  hitsByProvider: Record<string, SearchAccount>;
  fetched: number;
  fetchFailed: number;
  recorded: number;
  rejected: number;
  /** 检索本身报的错（限流之类），原话带家名。 */
  searchErrors: string[];
  /**
   * 这一轮抓的页里有几页来自 N2′ 的种子表，不是本轮检索搜来的（`a4/seed.ts`）。
   *
   * **单独一格**，不并进 `hits`：这两类页的来路不一样，而漏斗上分不开的话，「这一轮
   * 检索什么都没搜到、全靠种子撑着」会读成「这一轮检索发挥正常」。
   *
   * 可选，而且**缺席的含义是「这一轮跑在这一格存在之前」，不是零**：`Round` 是落库的形状
   * （运营台读的就是它），2026-09-01 之前的那些运行记录里没有这一格。读的那一侧要分开
   * 这两件事 —— 拿 `?? 0` 抹平会让历史上每一轮都显示成「一条种子都没用上」，而那是句假话。
   */
  seeded?: number;
};

export type Evidencing = {
  ledger: Ledger;
  rounds: Round[];
  verdicts: Verdict[];
  tallies: Tally[];
  /** 抓回来的全部快照，按 URL 存过一份在台账里，这里留一份给独立性折叠用。 */
  pages: Snapshot[];
};

/** 一轮最多抓几页。抓得多不等于知道得多，而每一页都要过一次抽取调用。 */
const PAGES_PER_ROUND = 8;

/**
 * 一轮里最多用几条 N2′ 种子（`a4/seed.ts`）。**必须小于 `PAGES_PER_ROUND`。**
 *
 * 3 而不是 5：一波全是种子的话，共源率（`cosource.ts` 的 `waveShare`）量的就不再是
 * 「我们的问法在不在撞同一批稿子」—— 而改问法那条闸是靠这个数开的。留两页给本轮检索，
 * 它才还答着原来那个问题。
 */
export const SEEDS_PER_ROUND = 3;

/**
 * 跑这一遍取证的是哪条链路。见文件头最后一节。
 */
export type LaneRef = {
  /**
   * 这条链路的模型槽位。**抽取那几次调用也走它** —— 三条链路要各自取证，那么「从这一页里
   * 读出了什么」也得是各自读的。不给这个字段的话 `callMessages` 会回落到 harness 的槽位，
   * 于是三条链路的证据台账其实是同一个模型抽出来的，而屏幕上写着三条独立研究。
   */
  slot: Slot;
  /** 屏幕和 trace 上指认这条链路的字：「DeepSeek」。每条 note、每次调用的标签都带它。 */
  label: string;
  /** 往这条链路自己的进度上报一句（不占步号）。三条链路各有一块表，见 `DraftReport`。 */
  substep: (suffix: string) => void;
};

/**
 * 抽一页的证据。抽取器只看这一页，看不到别的页，也看不到公司上下文 ——
 * 它的活是「这页里有没有能回答这几条命题的原句」，不是下判断。
 *
 * **只读出来，不入账**（见文件头）：入账要按页序，而这几页是并着抽的。抽不出来的
 * 那一页返回空数组 —— 空数组和「这页里确实没有」在台账上是同一件事，都是零条证据。
 */
async function extract(
  h: Harness,
  lane: LaneRef,
  page: Snapshot & { sourceDomainHint?: string },
  props: Proposition[]
): Promise<EvidenceDraft[]> {
  let text: string;
  try {
    text = (
      await h.callMessages(
        `模型调用 · a4.extract（${lane.label} · ${page.sourceDomainHint ?? page.url.slice(0, 60)}）`,
        [
          { role: "system", content: A4_EXTRACT_SYSTEM },
          {
            role: "user",
            content: buildA4ExtractUser({
              props: props.map((p) => ({ id: p.id, statement: p.statement, requiredEvidence: p.requiredEvidence })),
              url: page.url,
              title: page.title,
              // 抓回来的正文一律套一层：它是待核查的材料，不是指令。
              body: distrustBlock(page.url, page.text),
            }),
          },
        ],
        /*
         * 6000，理由同 `run.ts` 里那个 `JSON_MAX_TOKENS`：这一次也落在推理模型的槽位上，
         * 思考 token 和正文分同一个额度。**这一步截断的样子最难看出来**：下面那个 catch
         * 把它读成「这一页没抽出东西」，于是台账上少几条证据，而漏斗数字上表现成「外面
         * 就是没有」。一页最多也就抽出十来条证据，正文占不到这个数的一半。
         */
        { slot: lane.slot, maxTokens: 6000 },
        { promptKey: "a4.extract", url: page.url, contentHash: page.contentHash, lane: lane.label },
        "a4.extract"
      )
    ).text;
  } catch (e) {
    // 一页抽不出来不该拖垮整轮（也不该拖垮别的链路）。
    console.warn(
      `[tkos:a4] ${lane.label} 抽取失败 ${page.url}：${e instanceof Error ? e.message : e}`
    );
    return [];
  }
  let drafts: unknown;
  try {
    drafts = parseJson<{ evidence?: unknown }>(text).evidence ?? [];
  } catch (e) {
    // 同上：一页的 JSON 坏掉只丢那一页。以前这一句在 `extract` 外面，抛出来会连着
    // 打断同一轮里其余几页 —— 并着抽之后更要在这里接住，`mapPool` 不吞异常。
    console.warn(
      `[tkos:a4] ${lane.label} 抽取结果不是合法 JSON ${page.url}：${e instanceof Error ? e.message : e}`
    );
    return [];
  }
  // url 由代码填，不用模型抄的那个 —— 抄错一个字符就变成「没抓过的地址」而被拒，
  // 而真正的原因（模型手抄了 url）在拒绝理由里看不出来。
  return (Array.isArray(drafts) ? (drafts as EvidenceDraft[]) : []).map((d) => ({
    ...d,
    url: page.url,
  }));
}

/**
 * 一轮里同时抽几页。
 *
 * ## 这个数**不再**是限流的那道闸
 *
 * 2026-09-07 起真正管并发的是 `models/gate.ts`（按出口排队，撞限时等一个位子而不是失败）。
 * 四条链一起跑（`sweep.ts` 的 `CHAIN_CONCURRENCY` 从 2 改到 4）之后，同一时刻会有 4×5 = 20
 * 个 flash 调用一起要位子 —— 方舟那个池默认 12，多出来的八个在门口排着，排了多久记在 trace
 * 的 `queuedMs` 上。**所以这个数不用跟着改**：调大它只会让队排得更长，调小它只会让位子闲着。
 *
 * ## 它还剩下的意义
 *
 * 一波抓 8 页（`PAGES_PER_ROUND`）而这里是 5，意思是那 8 页分两批抽。留着分批是因为每一页的
 * 提示词里都塞着整页正文 —— 一次把八页全摊开，峰值内存和一次失败的代价都翻一倍，而 gate 那
 * 边只管出网，不管这一侧摊开了多少东西。
 *
 * 上一版这里写的是「上一级还有闸：四条链两条两条跑，所以最多十个在飞，那是限流扛得住的量」。
 * 那句话现在不成立了 —— 靠调用方自己数并发这件事整个交给了 gate。
 */
const EXTRACT_CONCURRENCY = 5;

/** 这一轮该给谁搜：还没闭合、且轮数没用完的那几条。 */
function pending(props: Proposition[], verdicts: Verdict[], roundNo: number): Proposition[] {
  if (roundNo === 1) return props;
  const byId = new Map(verdicts.map((v) => [v.propositionId, v]));
  return props.filter((p) => {
    const v = byId.get(p.id);
    if (!v || v.ok) return false;
    if (v.terminal) return false;
    return roundNo <= p.extraRoundsCap + 1;
  });
}

/**
 * 跑完**一条链路**的取证。返回它自己的台账、每轮的账、每条命题的判定。
 *
 * `maxRounds` 与 `searchK` 来自 `Harness.budget`（随思考深度变）。第一轮永远跑，
 * 之后每一轮只服务还没闭合的命题。
 *
 * 三条链路同时调这个函数，各自一份台账。检索家阵容是共用的（那是这台机器的配置），
 * 但发出去的检索式是各自编的命题带出来的，所以抓回来的页也各不相同。
 */
export async function gatherEvidence(
  h: Harness,
  /** 这一轮的检索家阵容（`providers().list`）。每条检索式发给每一家，按 URL 去重。 */
  search: SearchProvider[],
  props: Proposition[],
  budget: { searchK: number; maxRounds: number; maxPages?: number },
  /** 跑这一遍的是哪条链路 —— 抽取用它的模型，进度报到它那一栏。 */
  lane: LaneRef,
  opts: {
    /**
     * N2′ 分给这条链的种子地址（`a4/seed.ts` 的 `routeSeeds`）。
     *
     * 它们**和检索结果并进同一批 `hits`**，而不是走一条自己的抓取路径：白名单、按 URL 去
     * 重、`withHint` 那行站名提示、`ledger.snapshot` 的重抓判断，四件事都挂在那一批上，
     * 各走各的话这四件里迟早有一件对种子不生效，而不生效的表现全是静默的。
     */
    seeds?: readonly SearchHit[];
    /**
     * 研究主体的名字（N0 主体卡的 `subject`）。给了就用来排命中：标题或摘要里提到它的页
     * 排前面（`research/rank.ts`）。不给就只按站点好坏排。
     */
    subject?: string;
    /**
     * 除交易所与巨潮之外还算一手披露的域名 —— 实际传进来的是主体卡的官网
     * （`SubjectCard.website`），沿 `sweep.ts` 从 `pipeline.ts` 递下来。
     *
     * 它进的是抓取位保留那一层（`research/slots.ts`），不进排序：这一栏改变的是
     * 「这一波有没有位子留给一手披露」，不是「谁排得更靠前」。
     */
    disclosureDomains?: readonly string[];
  } = {}
): Promise<Evidencing> {
  const ledger = new Ledger();
  const rounds: Round[] = [];
  const pages: Snapshot[] = [];
  let verdicts: Verdict[] = [];
  let tallies: Tally[] = [];
  /** 每条命题累计发出去过几条反向检索。义务检的是这个数，不是搜到几条。 */
  const counterSent = new Map<string, number>();
  /** 每条命题被搜过几轮。 */
  const roundsUsed = new Map<string, number>();

  for (let no = 1; no <= Math.max(1, budget.maxRounds); no += 1) {
    const todo = pending(props, verdicts, no);
    if (!todo.length) break;

    // ---- 检索 -------------------------------------------------------------
    lane.substep(`第 ${no} 轮检索（${todo.length} 条命题）`);
    const queries: string[] = [];
    let counterQueries = 0;
    for (const p of todo) {
      roundsUsed.set(p.id, (roundsUsed.get(p.id) ?? 0) + 1);
      queries.push(...p.queries);
      // 反向问法每一轮都发。只在第一轮发的话，补搜轮里这条义务就靠「上一轮发过」
      // 记账，而那等于让一条行为义务由历史满足。
      for (const q of p.counterQueries) {
        queries.push(q);
        counterQueries += 1;
        counterSent.set(p.id, (counterSent.get(p.id) ?? 0) + 1);
      }
    }
    const { hits: found, errors, perProvider } = await searchAll(search, queries, budget.searchK);

    /*
     * N2′ 的种子插在检索结果**前面**，每轮最多 `SEEDS_PER_ROUND` 条。
     *
     * 排前面：它们是这一步的全部意义 —— 排在后面会被本轮检索的五条挤掉，等于没接。
     * 不占满五页的理由在 `SEEDS_PER_ROUND` 自己那条注释里。
     *
     * 已经抓过的种子不再排队（`ledger.snapshot`），所以第二波拿到的是下三条，不是同三条。
     */
    const seedsNow = (opts.seeds ?? []).filter((x) => !ledger.snapshot(x.url)).slice(0, SEEDS_PER_ROUND);
    /*
     * **2026-09-04：并进来之后排一次序，再切前几页。** 上一版是「种子在前、检索按返回顺序」，
     * ISS-227 那轮 560 条命中里抓到的是设计站、图表页和论坛帖，16 次抽取入账 1 条。排序的
     * 三条启发式和理由写在 `research/rank.ts` 头部；这里只保证种子仍然进得来（它们仍在
     * `hits` 里、仍在白名单里），只是不再无条件排最前。
     */
    const seedUrls = new Set(seedsNow.map((x) => x.url));
    // 种子若也被本轮搜到，只留种子那一条：同一地址出现两次会占掉两个抓取名额。
    const hits = rankHits([...seedsNow, ...found.filter((x) => !seedUrls.has(x.url))], opts.subject ?? "", seedUrls);

    /*
     * 白名单：只有本轮检索真的返回过的地址、以及 N2′ 交回来的那几条才允许抓
     * （防注入，见 `fetch.ts` 头部）。
     *
     * 种子进这个集合是**有意把这道闸放宽了一格**，理由和边界写在 `research/qwen-research.ts`
     * 文件头第三节：只收通义那个检索工具吐出来的 `webSites`，不收它写报告时挑的
     * `references`，并且每条都过一遍 `keepUrl`。也就是说进来的仍然是「某个检索器返回过的
     * 地址」，不是「某一页正文里写着的地址」—— 那条纪律没有破。
     */
    const allowed = new Set(hits.map((x) => x.url));
    /*
     * **保留位作用在去重之后的候选上，不在整份 `hits` 上。**
     *
     * 2026-09-07 加（ISS-238）。年报被八个转载页挤出一波 8 个抓取位那件事，排序解决不了 ——
     * 转载页标题里都写着主体名（+3 分），分数比一份 PDF 年报（披露 +2、PDF −1）还高，
     * 于是它年年排在第十几位。理由整段在 `research/slots.ts` 文件头。
     *
     * 顺序不能反：先 `reserveSlots` 再去重的话，保下来的那两个披露位很可能是**上一波已经
     * 抓过的同一份年报**（巨潮同一份公告有好几个镜像页，`ledger.snapshot` 认的是 url），
     * 保留位就白留了。所以先滤掉抓过的，再在剩下的里面留位子。
     *
     * `allowed` 仍然罩着**全部** `hits`：防注入那条纪律（`fetch.ts` 头部）管的是「抓取目标
     * 只能由检索返回决定」，和这一波挑了哪几页无关，重排一次不该动它。
     */
    const candidates = hits.filter((x) => !ledger.snapshot(x.url));
    const pageLimit = Math.max(1, Math.min(PAGES_PER_ROUND, budget.maxPages ?? PAGES_PER_ROUND));
    const fresh = reserveSlots(candidates, {
      disclosureDomains: opts.disclosureDomains,
      subject: opts.subject,
      total: pageLimit,
    }).slice(0, pageLimit);

    // ---- 抓取 -------------------------------------------------------------
    lane.substep(`第 ${no} 轮抓正文（${fresh.length} 页）`);
    const got = await fetchPages(
      fresh.map((x) => x.url),
      allowed,
      // 主体自己的官网也按一手披露放宽超时与 PDF 体积（2026-09-07）。
      opts.disclosureDomains ?? []
    );
    ledger.archive(got.pages);
    pages.push(...got.pages);
    if (got.failures.length) {
      // 标签带链路名：三条链路同时在抓，不署名的话 trace 上三组「抓取未成功」谁的是谁的
      // 分不出来 —— 而「这条链路一页都没抓到」正是三份报告不一致最常见的原因。
      h.note(`${lane.label} · 抓取未成功`, { 条数: got.failures.length, 明细: got.failures }, "local");
    }

    // ---- 抽取入账 ---------------------------------------------------------
    lane.substep(`第 ${no} 轮抽取（${got.pages.length} 页）`);
    const drafted = await mapPool(got.pages, EXTRACT_CONCURRENCY, (page) =>
      extract(h, lane, withHint(page, hits), todo)
    );
    let recorded = 0;
    let rejected = 0;
    // 按页序入账（`mapPool` 保序），编号才和「第几页」对得上，见文件头。
    for (const drafts of drafted) {
      for (const d of drafts) {
        if (ledger.record(d)) recorded += 1;
        else rejected += 1;
      }
    }

    // ---- 折叠与判定 -------------------------------------------------------
    // 每一轮都对**全部**快照重折一次，不是只折新来的：新抓的一页可能是已收某页的
    // 转载，只折增量就会让它自成一组，把循环引用算成交叉验证。
    const groups = new Map(
      assign(pages.map((p) => ({ url: p.url, sourceDomain: domainOf(p.url), text: p.text }))).map((g) => [
        g.url,
        g.group,
      ])
    );
    ledger.fold(groups);
    tallies = tally(
      ledger.entries.map((e) => ({
        propositionId: e.propositionId,
        group: e.independenceGroup,
        sourceDomain: e.sourceDomain,
      }))
    );
    const byProp = new Map(tallies.map((t) => [t.propositionId, t]));
    verdicts = props.map((p) =>
      judge(
        p,
        byProp.get(p.id) ?? { propositionId: p.id, groups: 0, citableGroups: 0, ugcOnly: false },
        ledger.forProposition(p.id),
        counterSent.get(p.id) ?? 0,
        roundsUsed.get(p.id) ?? 0
      )
    );

    rounds.push({
      no,
      propositionIds: todo.map((p) => p.id),
      queries: queries.length,
      counterQueries,
      hits: found.length,
      hitsByProvider: perProvider,
      fetched: got.pages.length,
      fetchFailed: got.failures.length,
      recorded,
      rejected,
      searchErrors: errors,
      // 数的是**真抓下来**的那几页，不是排上队的：种子抓不动和种子没排上是两件事。
      seeded: got.pages.filter((p) => seedsNow.some((x) => x.url === p.url)).length,
    });
    h.note(`${lane.label} · 第 ${no} 轮取证`, { ...rounds[rounds.length - 1] }, "local");
  }

  return { ledger, rounds, verdicts, tallies, pages };
}

const domainOf = (url: string): string => (url.includes("://") ? url.split("/")[2] ?? "" : "");

/** 给快照贴一个人话站名，只为了让 trace 的标签好读。 */
function withHint(page: Snapshot, hits: SearchHit[]): Snapshot & { sourceDomainHint?: string } {
  const hit = hits.find((x) => x.url === page.url);
  return { ...page, sourceDomainHint: hit?.siteName || domainOf(page.url) };
}
