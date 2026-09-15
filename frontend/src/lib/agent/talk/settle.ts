/**
 * 轮外结算：让步日志、独立复核。
 *
 * 职责收成两件（裁定一，撤回裁定三之后）：
 * 1. **如实记账**：让步日志从本轮真实文本里机械地取，每轮一条，不许编。
 * 2. **必要时复核**：收敛触发条件命中时换一个模型独立复核候选判断。
 *
 * 判断状态的迁移已经由轮内那条链在做（模型调 `propose_point_update` 工具），
 * **轮外不写候选** —— 打回一律只留痕，不动候选。它要的那点强制力靠上屏拿：
 * 人看得见「这条候选机检没过」，而确认权本来就在他手上。
 *
 * 复核**过了**的那一轮轮外要写一次，写的是**板与图，不是候选**：候选原样抬到判断板的
 * 上半层、在研究链路上留一条待确认项（`api.landTalkCandidate`）。那一步一条重开条件都
 * 不布控 —— 布控只发生在他按下确认那一下（`confirmCandidate`）。
 */

import { AgentRunFailed, type Harness } from "@/lib/agent/harness";
import { citeText, citedIds, firstCiteAt } from "./cite";
import type { TalkPoint, DeliberationEntry } from "./point";
import { isTrigger } from "./point";
import { findDesync, reviewCandidate } from "./verifier";
import { templateSmells } from "./system";
import type { Evidence } from "@/lib/research/ledger";

/**
 * 让步日志的触发物截断长度。这份日志是给人读的，不能是全文。80 字大约两行，够说清
 * 是哪句话，也不会让一条日志占半页。**今天屏幕上还没有这一栏**，截断先按上屏的宽度留。
 */
const TRIGGER_MAX_CHARS = 80;

/**
 * 模块级 Map，保证同一轮只落一条，并让 Task 12 的回放有汇合点。
 *
 * 键是 `${issueId}:${轮号}`，值是正在跑或已经跑完的 Promise。**不对称处理**：
 * - 成功的保留（第二次进来 await 到同一个已完成的 Promise，不重跑）
 * - 失败的删掉（下一次可以重试）
 *
 * 上限 200 个键，超了按插入顺序淘汰最老的**已完成**键。H3：只淘汰已经跑完的，
 * 因为真有 >200 个并发结算在飞的时刻，被淘汰的那把可能仍在 doSettle 里 await，
 * 此后同 issueId:轮号 再进来一次就重跑 doSettle → 一轮两条日志。
 * 200 把全都在飞时不淘汰，让它暂时超过上限 —— 宁可多占一点内存，也不能重跑出第二条日志。
 *
 * Task 12 的回放会在 `recordAdvisorReply` 之后再 await 一次 `settleTalkTurn`，
 * 那个 await 等到的是同一个 Promise，无论那时它跑完没跑完 —— 这是汇合点。
 */
const settling = new Map<string, Promise<void>>();
const settlingCompleted = new Set<string>();
const SETTLING_MAX = 200;

/**
 * 日志末尾连续 `hold` 的条数。
 *
 * 用于两处：trigger（「连着第几轮没改」）、收敛触发（「含本轮在内连着 ≥3 条 hold」）。
 * 简报「静默 3 轮」那一档指的是这个数。
 */
function countConsecutiveHolds(log: readonly DeliberationEntry[], includingThisTurn: boolean): number {
  let count = includingThisTurn ? 1 : 0;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].kind === "hold") count++;
    else break;
  }
  return count;
}

/**
 * 结算一轮对话：如实记账（让步日志）、必要时复核。
 *
 * **同一轮只落一条** —— 靠模块级 Map 去重。调用方不必判重，这个函数自己保证。
 * 成功的留下，失败的删掉。
 */
export async function settleTalkTurn(
  h: Harness,
  issueId: string,
  opts: {
    /** 本议题的 API 门面，从 store 取。不写候选，写的只有让步日志与落地那一步。 */
    api: {
      getTalkPoint: (id: string) => Promise<TalkPoint>;
      recordDeliberationEntry: (id: string, entry: unknown) => Promise<unknown>;
      listDeliberationLog: (id: string) => Promise<DeliberationEntry[]>;
      /**
       * 把「这一轮结算落定时判断是什么样子」记到判断状态上（`TalkPoint.settledJudgement`，
       * 那一栏的理由写在 `point.ts`）。
       *
       * **必填，不是可选。** 这一格漏接的后果不是少一栏数据，是下一轮会把这一轮没记成账的
       * 改判安到别人头上 —— 而那正是这一栏存在的全部理由。写成可选的话，漏接是一次静默的
       * 退化；写成必填，漏接是一次编译错误。
       */
      markTalkSettled: (id: string, judgement: string) => Promise<void>;
      /**
       * 复核过了之后把候选落到判断板与研究链路上。**可选**：回放夹具那一侧根本不递这一格
       * （回放要的是让步日志与复核结论，不是往板上堆东西），所以这一路上落不落地是分开的。
       *
       * 为什么是注入而不是在这里 import `store.ts`：`store.ts` 已经 import 了本文件，
       * 反向 import 会成一条循环边。生产上注入它的只有 `store.ts` 的 `settleTurn` 一处。
       *
       * **返回值不许再是 `unknown`。** 落地那一步有一档是「一个字都没落上去」（板上已经
       * 有一句开头相同、结尾不同的判断），那一档库里干干净净、也不抛 —— 回执是唯一说得出
       * 「刚才什么都没发生」的东西。把它丢掉，撞车就成了一件彻底无声的事：台账记 `ok`，
       * 板、图、时间线、控制台全无痕迹。
       *
       * 收的是**结构上的最小形状**，不是 `store.ts` 的 `Landing` 整个 —— 那要反向 import。
       * 这三栏够回答「撞没撞、撞上那句话是什么、落没落图」，`Landing` 结构上满足它。
       */
      landTalkCandidate?: (issueId: string) => Promise<{
        nodeId: string | null;
        why: string;
        collided?: boolean;
      }>;
    };
    /** 从 store.researchDocs[issueId] 取。兜底要回来：`doc.ledger ?? doc.blocks?.evidence`。 */
    ledger?: Evidence[];
    /** 这一轮的轮号，来自 `agentRounds(issueId)`。 */
    nowTurn: number;
    /** 本轮对话原文。让步日志的真实性全靠这两个参数。 */
    agentText: string;
    ceoText: string;
    /**
     * 记账端口（可选）。H2：记账的单位是「真的跑了一次结算」，判重命中那一次没跑，不该在台账上出现。
     * 把记账挪到判重之后，由 doSettle 在真的开始干活时调 open、在收尾（含异常路径）调 settle。
     * store 内部函数不出模块，在 store.ts 里定义两个闭包传进来。
     *
     * **台账上那一栏的措辞归调用方，不归这里**（J3）：这个函数手上只有 `issueId`，编出来的
     * 是 `bd7f…` 这种不透明串，而运营台账是给人读的 —— 议题标题只有 store 那边取得到。
     * 所以下面每一处 `h.finish` 都不传 `input`，由 `settle` 那个闭包补上。
     */
    accounting?: {
      open: () => string;
      settle: (runId: string, rec: ReturnType<Harness["finish"]>) => void;
    };
  },
): Promise<void> {
  const key = `${issueId}:${opts.nowTurn}`;

  // 第二次进来时直接返回同一个 Promise
  if (settling.has(key)) {
    return settling.get(key)!;
  }

  // 开跑，把 Promise 存起来
  const work = doSettle(h, issueId, opts);
  settling.set(key, work);

  // H3：检查上限，超了淘汰最老的**已完成**键
  if (settling.size > SETTLING_MAX) {
    // 找到第一个已完成的键（按插入顺序）
    for (const k of settling.keys()) {
      if (settlingCompleted.has(k)) {
        settling.delete(k);
        settlingCompleted.delete(k);
        break;
      }
    }
    // 如果 200 把全都在飞，不淘汰 —— 宁可暂时超过上限，也不能淘汰还在跑的
  }

  try {
    await work;
    // 成功的保留 —— 不 delete，第二次进来不重跑，并标记为已完成
    settlingCompleted.add(key);
  } catch (e) {
    // 失败的删掉，下一次可以重试
    settling.delete(key);
    settlingCompleted.delete(key);
    throw e;
  }
}

async function doSettle(
  h: Harness,
  issueId: string,
  opts: Parameters<typeof settleTalkTurn>[2],
): Promise<void> {
  const { api, ledger, nowTurn, agentText, ceoText, accounting } = opts;

  // H2：记账在判重之后 —— 记账的单位是「真的跑了一次结算」
  // 这里真的开始干活了，调用 open 拿到 runId
  const runId = accounting?.open();

  try {
    /*
     * 套话探测（规格 §9）。**摆在最前面，在任何一条提前返回之前** —— 这一段是「这一轮
     * 的回应长什么样」的度量，与这一轮落不落得成让步日志无关；摆在下面任何一处，判断
     * 两边都空串的那些轮就整轮量不到，而那恰恰是最容易说套话的几轮。
     *
     * 只在命中时记，不命中不记：每轮都记一条「这轮没套话」会把台账刷成一片噪声，而这条
     * 留痕唯一的读者是回头翻账的人 —— 他要找的是命中的那几轮。
     *
     * **只记数，不判定。** 规格那道合格线是「连续 20 轮里 ≤2 次」，要跨轮攒计数；结算这
     * 一层手上只有本轮，判不了。判定那一档还欠着（`system.ts` 上写着）。也不因此打回、
     * 不动候选：套话是自然感的问题，不是反谄媚那本账的问题，两件事不许混在一个出口上。
     */
    const smells = templateSmells(agentText);
    if (smells.length > 0) {
      h.note("这一轮回应里有套话", { issueId, turn: nowTurn, hit: smells });
    }

    // 读取当前判断状态和让步日志
    const point = await api.getTalkPoint(issueId);
    const log = await api.listDeliberationLog(issueId);

    /*
     * before: 进这一轮之前判断是什么样子（`point.settledJudgement`，理由写在 `point.ts`）。
     *
     * 取不到那一栏才退回旧口径（日志最后一条的 `after`，没有日志就用初始 `thesis`）——
     * 那是这一栏出现之前存下来的判断状态。**两者只在「某一轮改判没能落成日志」之后才不
     * 一样**，而那正是这一栏要堵的那条通路：旧口径下，那次没记成账的改判会一直挂着，直到
     * 随便哪一轮的回应里出现一个真编号，就被落成那一轮的一次「有依据的改判」。
     */
    const lastEntry = log[log.length - 1];
    const before = point.settledJudgement ?? (lastEntry ? lastEntry.after : (point.thesis || ""));

    // after: 当前的判断状态（候选优先，否则 thesis）
    const after = point.candidate?.statement ?? point.thesis;


    // 两边都空串时不落日志 —— 没有判断可言，谈不上坚持或让步
    if (!before && !after) {
      /*
       * 这一支也不记「进下一轮之前是什么样子」：还没有判断可记。记了的话，下一轮第一次
       * 长出一句判断会被读成一次「从无到有的改判」，于是它得为自己指出一条证据编号 ——
       * 而第一次表态不是让步。这一支不写，下一轮照旧退回 `thesis` 那条旧口径。
       */
      h.note("两边判断都是空串，本轮不落日志", { issueId, turn: nowTurn });
      if (runId) accounting?.settle(runId, h.finish({ status: "ok" }));
      return;
    }

    /*
     * 这一轮的结算从这里开始就算数了 —— 无论下面落不落得成日志，「进下一轮之前判断是
     * 这个样子」都已经确定。摆在这里而不是各条 return 之前：下面还有一条提前返回的路
     * （未触发收敛检查）和一条抛出的路，逐条补一次写，迟早漏一条。
     *
     * **落不成日志的那一轮照样写，这是有意的**：写了，这一轮的缺席就以「日志前后接不上」
     * 的样子留在账上（下一条真的落成的日志会和前一条接不上，`findDesync` 判据 2 报它）；
     * 不写，它会在下一轮被一个随口补上的真编号洗成那一轮的一次「有依据的改判」。
     */
    await api.markTalkSettled(issueId, after);

    const changed = before !== after;

    // 追一条让步日志（每一轮都追，一轮一条，不多不少）
    // kind: before === after 时用 hold，否则用 concede（这里不区分 partial）
    const kind: DeliberationEntry["kind"] = changed ? "concede" : "hold";

    // trigger 从真实文本里取，两条路分开（F2）
    let trigger: string | null = null;
    let rationale: string | null = null;
    let forcedDesync: ReturnType<typeof findDesync>[number] | null = null;

    /*
     * 本轮回应里真引到的证据编号。两处都要用它：构造 trigger、以及 H5 那次退让
     * （撞上黑名单时退成只留编号）。抠两遍的话，两处的正则改一处就会对不上。
     *
     * 抠的口径在 `cite.ts` 一处（`[E1]` / `[E1, E2]` / `[E1][E2]` 三种都认）。这里从前
     * 自带一份只认单编号的正则，后果是**真的引了 `[E1, E2]` 的诚实改判被判成「指不出
     * 任何证据编号」** —— 机检打回，那一轮的让步日志整条缺席。
     */
    const evidenceIdsCited = citedIds(agentText);

    if (changed) {
      if (evidenceIdsCited.length > 0) {
        // 找到编号，取回应里引到这些编号的那一段（截断）
        const matchIndex = firstCiteAt(agentText);
        const contextStart = Math.max(0, matchIndex - 20);
        const contextEnd = Math.min(agentText.length, matchIndex + 60);
        const context = agentText.slice(contextStart, contextEnd);
        trigger = `${citeText(evidenceIdsCited)} — ${context.slice(0, TRIGGER_MAX_CHARS)}`;
        // rationale 也从真实文本 derive（G4）
        rationale = `根据 ${citeText(evidenceIdsCited)} 调整判断`;
      } else {
        // 抠不到编号 —— settle 自己决定不落这一条（H1）
        // 但不 return：构造一条 desync 强制进复核，机检会打回（modelSlot === null）。
        // 这是反谄媚闭环真正生效的路径：**判据 1（编号是编的）与 settle 自己构造的这一条**。
        // 判据 2/3 对 settle 自己写的条目恒不开火，因为 before 按构造等于前一条的 after。
        forcedDesync = {
          turn: nowTurn,
          before,
          after,
          why: "这一轮判断动了，回应里指不出任何证据编号，所以这一轮没有让步日志",
        };
        h.note("判断变了但回应里指不出证据编号，不落日志但强制进复核", {
          issueId,
          turn: nowTurn,
          before,
          after,
          note: "settle 自己构造 desync 强制进复核，机检会打回",
        });
        console.warn(`[tkos:talk] ${issueId} 第 ${nowTurn} 轮判断变了但指不出证据编号，不落日志但强制进复核`);
        // 不 return，继续走强制复核那条路
      }
    } else {
      // 判断没动：取 ceoText 的截断原文，前面缀连着第几轮没改
      const holdCount = countConsecutiveHolds(log, true);
      const ceoSnippet = ceoText.slice(0, TRIGGER_MAX_CHARS);
      trigger = `连着第 ${holdCount} 轮没改 —— 他说：${ceoSnippet}`;
      // rationale 也从真实文本 derive（G4）：说清是他哪句话没能构成依据
      rationale = `他说「${ceoSnippet}」没能构成改判依据`;
    }

    // 如果有 trigger，尝试记录日志
    if (trigger && rationale) {
      // H5：trigger 里塞了 ±80 字原文，可能撞上 NOT_A_TRIGGER 黑名单。
      // 自查一遍，过不了就退成只留编号（concede 那一支）、不带原文再落 ——
      // 丢掉一句引文比丢掉整条日志便宜。
      if (!isTrigger(trigger) && kind === "concede" && evidenceIdsCited.length > 0) {
        // 先存一份原值再替换：台账上那条「原值」记的必须是被替换掉的那一句（J5）。
        const droppedTrigger = trigger;
        trigger = citeText(evidenceIdsCited);
        h.note("trigger 撞上黑名单，退成只留编号", { issueId, turn: nowTurn, original: droppedTrigger });
      }

      const entry: DeliberationEntry = {
        turn: nowTurn,
        trigger,
        before,
        after,
        kind,
        rationale,
      };

      try {
        await api.recordDeliberationEntry(issueId, entry);
      } catch (e) {
        // checkEntry 拒了 → 构造一条 desync 强制进复核（H1）
        // 生产路径上活着的是判据 1（编号是编的）与 settle 自己构造的这一条。
        forcedDesync = {
          turn: nowTurn,
          before,
          after,
          why: `让步日志被拒：${e instanceof Error ? e.message : String(e)}`,
        };
        h.note("让步日志被拒，构造 desync 强制进复核", {
          issueId,
          turn: nowTurn,
          trigger: entry.trigger,
          why: forcedDesync.why,
          note: "settle 自己构造 desync 强制进复核，机检会打回",
        });
        console.warn(`[tkos:talk] ${issueId} 第 ${nowTurn} 轮让步日志被拒，强制进复核：`, forcedDesync.why);
        // 不 return，继续走强制复核那条路
      }
    }

    // 判断是否需要收敛检查（F5）
    // 三条触发条件：
    // 1. 判断这一轮动了
    // 2. 含本轮在内恰好连着 3 条 hold（简报「静默 3 轮」那一档）
    //    用恰好而非 >=，因为静默拖长了不意味着要反复付一次模型的钱
    // 3. forcedDesync 不为 null（改判但指不出编号、或 checkEntry 拒了）
    const consecutiveHolds = countConsecutiveHolds(log, kind === "hold");
    const needsReview = changed || consecutiveHolds === 3 || forcedDesync !== null;

    if (!needsReview) {
      h.note("本轮未触发收敛检查", { issueId, turn: nowTurn, changed, consecutiveHolds });
      if (runId) accounting?.settle(runId, h.finish({ status: "ok" }));
      return;
    }

    // 简报 Step 5 还列了「他要判断」与「点确认且状态有变」两档。
    // 前者是语义判断，后者是人按下确认那一下（归 `confirmCandidate`），都不在这里。

    // 重新读取日志（包含刚记录的这一条，如果落了的话）
    const updatedLog = await api.listDeliberationLog(issueId);

    // 算 evidenceIds（G1：机检只留 reviewCandidate 里那一处，这里只准备入参）
    const evidenceIds = (ledger ?? []).map((e) => e.id);

    /*
     * desync 有两个来源，**它们不互斥**（J4）：一轮既可能日志被拒（`forcedDesync`），
     * 也可能历史上某一条引了台账里没有的编号（`findDesync` 判据 1）。写成三目的话，
     * 只要 `forcedDesync` 落定，判据 1 那一整类就在这条路上被丢掉。
     *
     * `forcedDesync` 排在最前面是有意义的：`reviewCandidate` 的机检第一道取
     * `desync[0].before` 当 `rollbackTo`，而这一轮那条才是要退回去的那一句。
     */
    const desync = [
      ...(forcedDesync ? [forcedDesync] : []),
      ...findDesync(updatedLog, { evidenceIds, nowTurn, nowJudgement: after }),
    ];

    // 运行独立复核（机检在它里面）
    const review = await reviewCandidate(h, {
      point,
      ledger: ledger ?? [],
      log: updatedLog,
      desync,
    });

    // 记录复核结果
    h.note("候选判断复核", {
      issueId,
      turn: nowTurn,
      pass: review.pass,
      modelSlot: review.modelSlot,
      why: review.why,
      ...(review.rollbackTo ? { rollbackTo: review.rollbackTo } : {}),
    });

    // 打回分两档处置（撤回裁定三之后：都只留痕，不动候选）
    if (!review.pass) {
      if (review.modelSlot === null) {
        // 机检打回（账对不上或独立源不足）：这两件事都是机械确定的。
        // 撤回裁定三之后只留痕，不摘候选 —— 它要的那点强制力靠上屏拿。
        console.warn(`[tkos:talk] ${issueId} 第 ${nowTurn} 轮机检打回，只留痕不动候选：`, review.why.join("；"));
      } else {
        // 模型打回：这一档要读懂论证，它错判的代价是删掉一句对的判断。只留痕，不动候选。
        console.warn(`[tkos:talk] ${issueId} 第 ${nowTurn} 轮模型打回，只留痕不动候选：`, review.why.join("；"));
      }
    } else {
      console.log(`[tkos:talk] ${issueId} 第 ${nowTurn} 轮候选判断通过复核`);
      /*
       * 过了才落 —— 复核没过的候选上了板，那块板就开始收集参谋的猜测。
       *
       * 两道前提：候选真的在（`reviewCandidate` 对 `candidate === null` 那一档不做机检，
       * 模型是可以回 `pass: true` 的，而那时候没有东西可落），以及门面上真的注入了这一格。
       *
       * `extraArms` 不传，而且不会有人从这里传：那个口子原本留给
       * `DecisionMemory.overturnConditions`，而记忆是他按下确认那一下才写的、比落地晚
       * 一步 —— 落地这一刻还没有记忆可读（那一段写在 `land.ts` 的 `armsOf` 上）。
       */
      if (point.candidate && api.landTalkCandidate) {
        const landing = await api.landTalkCandidate(issueId);
        /*
         * **回执要有人收。**
         *
         * 落地那一步有一档是「一个字都没落上去」：板上已经有一句开头 30 字相同、结尾
         * 不同的判断（生产上一次正常的并发就撞得出来 —— A6 萃取那条写板路与这一条在同
         * 一次 `settleTurn` 里写同一张板）。那一档库里干干净净、也不抛，所以**除了这条
         * 留痕，全链路没有第二个地方说得出「刚才什么都没发生」**：板上没有这一句、图上
         * 没有待确认项、时间线上没有痕迹、这一轮的台账记录照旧是 `ok`。
         *
         * 上一版这里是 `await api.landTalkCandidate(issueId);`，回执整个丢掉。那比原来
         * 那个 `throw` 更糟的地方不在于少一条记录，而在于它是**静的** —— 抛异常至少让人
         * 知道出过事（只是把性质记错了），丢掉回执之后连出过事都看不出来。
         *
         * 每一路都记，不只撞车那一路：这一步在一件议题上通常只发生一两次，不构成噪声，
         * 而「落成了、落在 D2、等他确认」同样是这条链上最贵的一次写，值得在台账上留一行。
         * `collided` 那一栏单独带上，读账的人不必去解析 `why` 的措辞。
         */
        h.note("候选落地回执", {
          issueId,
          turn: nowTurn,
          nodeId: landing.nodeId,
          ...(landing.collided ? { collided: true } : {}),
          why: landing.why,
        });
      }
    }

    if (runId) accounting?.settle(runId, h.finish({ status: "ok" }));
  } catch (err) {
    /*
     * 失败也要在台账上落定。`AgentRunFailed` 身上已经挂着一条 harness 自己拼好的记录
     * （带这一次真实的 token 与 trace），用它比用 `h.finish` 现拼一条更全 —— 仓库里
     * 六处都是这个姿态。裸 Error 手上没有记录，只能现拼。
     */
    if (runId) {
      accounting?.settle(
        runId,
        err instanceof AgentRunFailed
          ? err.run
          : h.finish({ status: "failed", error: err instanceof Error ? err.message : String(err) })
      );
    }
    throw err;
  }
}
