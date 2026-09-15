/**
 * 深研 v2 的编排：**七个节点串成一条链**，一条链路，按维度分工而不是按模型分工。
 *
 * N0 锚定主体 → N1 凭知识写先验草稿 → N2 抽命题排检索计划 → N3 分维度取证 →
 * N4 证据与草稿对账 → N5 分层成稿 → N6 出口机检。每个节点的产物是下一个节点的输入，
 * 每个节点自己那条「不过时怎么办」都在下面各自的注释里。
 *
 * 链上还挂着一件**不占位置的事**：N0 一交出主体卡就发一次通义深研（`seed.ts` 的
 * `runSeed`），只要它踩过的那一面 url，不要它写的报告。它跑在 N1 和 N2 底下，N3 开跑时
 * 收，交回来的地址当各链第一批抓取目标。屏幕上那七步不变 —— 它不是一步，是一次顺路。
 * 没配 key、挂了、超时了都只让 N3 回到「自己搜」，链的形状一格不动。
 *
 * ## 这一条是默认那一支了
 *
 * `runDeepResearch` 第一句就按 `v2On()` 转到这里，**默认转**（要走四链路那一支得显式写
 * `TKOS_DR_V2=0`）。签名和返回与它一字不差，所以转发是入口处一行，别处一行都不用改。
 *
 * 四链路那一支还活着，但用处只剩一个：**拿同一个议题两边各跑一遍作对比**。它不是回滚开关
 * —— 回滚要连着 `dims.ts` / `draft.ts` / `audit.ts` 那一整套一起回，而那几样的产物（八维覆盖
 * 表、四态标签、七项出口机检）在旧路上没有对应的位置。两支并存期里唯一不许发生的事是
 * 「同一轮里一半走新的一半走旧的」，所以开关在入口读一次。
 *
 * 两支逐字相同的那三段小逻辑（装配清单的底、检索家命中汇总、台账外的编号）住在 `shared.ts`
 * ——同一句屏幕文字摆两处，改了一处另一处照旧说老话，而两支本来就是拿来互相对比的。
 *
 * ## `evidencing.lanes` 这一版装的不是模型，是四条维度链
 *
 * `A4Evidencing` 的注释目前写的是「除 `hitsByProvider` 和 `lanes`，其余每个数说的都是主源
 * 那一条链路」—— 那句话是四链路那一版的事实。这一版**没有主源顺位这件事**：只有一份报告，
 * 判断板和四节都从它压出来。所以 `lanes` 填的是 `sweep.ts` 的 `CHAINS`（`LaneAccount.label`
 * 写链名：「需求与供给」「技术与上游」这几个），`primary` 恒为第一条 —— 那一位在这一版里
 * 只剩「排第一栏」的意思，不再是「判断板从这一条压出来」。顶层那几个数（`propositions`、
 * `recorded`、`rounds`）说的是**整条链合起来**的账，因为这一版只有一份台账。
 *
 * 事件明细和运营台读这几个数的地方一行不用改：它们问的一直是「这一轮取到了几条证据」，
 * 而这一版对这个问题的答案比上一版更直接。
 *
 * ## 离线跑得通，而且不许靠罐头跑通
 *
 * `TKOS_MODEL_MOCK=1` 时每个节点的模型调用都落到 `models/mock.ts` 的罐头上，检索落到
 * `MockSearch`。罐头**只保证跑得快**，不保证跑得过：任何一个节点交回来读不出的东西，都
 * 折成一条缺口记进 trace 然后往下走（HP-5：查不到是合法结果），这一轮照旧 `status: "ok"`。
 *
 * 「读不出」和「压根没跑成」是两件事，而**两件都不许让这一轮就地失败**：`callMessages` 在
 * 追完 trace 之后是会重抛的（`harness.ts:411`），所以每一次调用都各自套着 try/catch —— 一次
 * 429 落在 N4 上，代价该是这一份带着「对账那一次没跑成」出稿，而不是整轮取证白跑、抛一个
 * 光秃秃的 `Error` 上去（那条路上连 `agentRunPut(e.run)` 都记不下东西）。这个文件里 N0 /
 * N1 / N2 / N4 各自套着，N3 那一批在 `sweep.ts` / `evidence.ts` 里套着，N5 那三次（大纲、
 * 分节、收口）和返修那一次在 `stage-write.ts` 里套着，N6 的锚点检查在下面 `gateHooks` 里
 * 逐条套着 —— **这条链上没有一次模型调用是裸着发的**。
 *
 * 唯一会让这一轮就地失败的是 `openContext` 那一句（图服务连不上），它抛的 `AgentRunFailed`
 * 原样往上走 —— 接住它继续跑就是 `harness.ts` 反复在防的那件事。
 */

import { parseJson, type Msg } from "@/lib/agent/json";
import { Harness } from "@/lib/agent/harness";
import { cognitiveFor } from "@/lib/agent/prompts";
import { blocking, fmt, type Violation } from "@/lib/agent/rules";
import type { ManifestItem, ResearchDoc, Statement } from "@/lib/data/types";
import { Ledger } from "@/lib/research/ledger";
import { describe, providerCode, providerLabel, providers } from "@/lib/research/search";

import { ANCHOR_SYSTEM, buildAnchorUser, cardGaps, compileCard, type SubjectCard } from "./anchor";
import {
  ANCHOR_GATE_BATCH_SYSTEM,
  buildAnchorGateBatchUser,
  hooksOf,
  readAnchorBatchVerdicts,
  stripHooks,
} from "./anchor-gate";
import { auditExit, backTo, MAX_AUDIT_ROUNDS, NODE_OF_RULE } from "./audit";
import type { Block, ReportBlocks } from "./blocks/schema";
import {
  COST,
  deadlineMs,
  room,
  shedNote,
  WRITE_PASS_MS,
  WRITE_RESERVE_MS,
} from "./deadline";
import { DIM_IDS, type DimCoverage, type DimId } from "./dims";
import { buildDraftUser, DRAFT_SYSTEM, draftGaps, parseDraft, type Draft, type Tag } from "./draft";
import { cardPropositions } from "./card-props";
import { bindCitations, evidenceManifest } from "./gate";
import { foldSynonymousClaims } from "./blocks/report";
import { verificationTally } from "./blocks/registry";
import { noExternalEvidence } from "./no-evidence";
import {
  buildPlanUser,
  compilePlan,
  fillQuestionGaps,
  maxPerDimFor,
  parsePlanLines,
  planGaps,
  planSystemFor,
  taskScopeFor,
  type PlannedProposition,
} from "./plan";
import { buildEvidencePack, buildUnresolved, type A4Input, type A4ReportInput } from "./prompt";
import {
  buildReconcileUser,
  candidatesFromPlaybook,
  CONTRADICTION_ABORT,
  parseMerged,
  RECONCILE_SYSTEM,
  reconcileGaps,
  type ChangeState,
  type Merged,
} from "./reconcile";
import { baseManifest, DEFAULT_AGENT_LABEL, draftSlot, planSlot, reconcileSlot, retrievalItem, rollUp } from "./shared";
import { mergedFor, pushbackNote, writeStaged, type StageWritten } from "./stage-write";
import { emptySeedTable, runSeed } from "./seed";
import { CHAINS, scopeTrace, sweep, type SweepResult } from "./sweep";
import { wordingViolations } from "./validate";
import type { A4Evidencing, A4Result, LaneAccount } from "./run";

/**
 * 这一版走不走。**默认走** —— 写死 `!== "0"` 而不是 `=== "1"`：默认值属于这一行，不属于
 * 每一台机器的 `.env`。要跑四链路那一支得显式写 `TKOS_DR_V2=0`，而那一支现在只用来拿同一个
 * 议题两边各跑一遍作对比。
 */
export const v2On = (): boolean => process.env.TKOS_DR_V2 !== "0";

/**
 * 屏幕上那七步的原话。**这里是它们唯一的出处** —— 视图层不许自己编一套（同 `run.ts`
 * 的 `STEPS`）。用词照抄文件头那一行：步骤名和代码里的分段必须是同一套词，否则改了
 * 节点顺序却没改屏幕上的话，一号位读到的是一份过期的流程图，而没有任何一处会报错。
 */
const STEPS = {
  anchor: "锚定主体",
  draft: "先写先验草稿",
  plan: "抽命题、排检索计划",
  sweep: "分维度取证",
  reconcile: "证据与草稿对账",
  layer: "分层成稿",
  audit: "出口对账",
} as const;
const STEP_TOTAL = 7;

/**
 * 这一份报告在屏幕上的名字。**一处出处** —— 落库那一份（`ResearchDoc.sourceLabel`）、报告
 * 头上那行标记（`laneMark`）、还有中途落盘的那几份（`keep`）说的必须是同一个名字，否则同一
 * 轮研究在屏幕上会以两个名字出现，而没有任何一处会报错。
 */
const SOURCE_LABEL = "深研 v2";

/** 主体卡那一次交的是一行 JSON，额度按 `run.ts` 的 `JSON_MAX_TOKENS` 那一档（推理和正文抢同一份）。 */
const ANCHOR_MAX_TOKENS = 8000;
/** 草稿那一次要一口气写八维，额度按分节出稿那一档 —— 它是整条链的内容主体。 */
/*
 * 8000，2026-08-27 从 16000 压下来的。
 *
 * 依据是一轮真运行的账（`RUN-A4-mtb3k2bt-2`）：这一次花了 381 秒、写了 20,584 个输出
 * token，而**那两万字一个都没进最终报告** —— 正文到 N5 会照着证据重写一遍。同一轮里取证
 * 那一段拿到的时间是 0。
 *
 * 光压这个数不够，模型照样想写那么多、然后靠续写补回来，所以篇幅纪律同时写进了
 * `DRAFT_SYSTEM`（每维 body ≤200 字，但断言不许跟着缩）。
 *
 * **续写那一次留着**：去掉它的话，一次截断就是「这一轮没有先验骨架」，而后面每一步都靠它。
 */
/*
 * 2026-09-05：8000 → 12000。ISS-208 那一轮草稿在 8000 上「额度用完在思考上了」，222 秒一个字没回，
 * 再花 224 秒补正 —— 和分节那一步同一种病（`stage-write.ts` 的 `SECTION_OUT_TOKENS`），同一种修法。
 */
const DRAFT_MAX_TOKENS = 12000;
/**
 * N2 检索计划。**16000，2026-08-31 从 8000 抬上来的 —— 这是整条链最贵的一次省钱。**
 *
 * 依据是三轮真运行：`pro` 是推理模型，思考和正文分同一份 `max_tokens`，而计划这一步
 * 的思考稳定吃到 5000–8000。8000 的上限下，`RUN-A4-mth5jkf0-6`（ISS-118）两次全挂
 * —— 第一次「思考花了 8000、正文 0」，第二次「一行都没写完」；`RUN-A4-mtb3k2bt-2`
 * （ISS-112）同样两次全挂；`RUN-A4-mtceqa3p-2`（ISS-114）两次里活了一次。命中率 1/3。
 *
 * 挂掉的代价不是「计划差一点」，是**这一轮一条外部证据都没有**：N2 交零条命题 → N3
 * 整段跳过 → 证据包空 → N5 的大纲折成一节 → 交出去一份四个块的报告，而运行记录写着 ok。
 * 8000 省下的那点钱，换来的是一份没有调研的调研。
 *
 * 逐行 JSONL 续写（`parsePlanLines`）救的是「截了最后一条」，救不了「正文 0 字」——
 * 那一种只有把额度抬到思考吃不满才有解。
 */
const PLAN_MAX_TOKENS = 16000;
const RECONCILE_MAX_TOKENS = 16000;
/* 2026-09-04：锚点检查已合成一次调用（见 `gateHooks`），并发数那一档随之删掉。 */


/**
 * N2 之后**必须**留出来的时间：至少一波取证，加上出稿那一整段。
 *
 * 前三节（N0/N1/N2）的补正都拿它当「后面要留的位置」——一份补得更好的主体卡换不来一份
 * 报告。N4 退回 N0 那一支也用它，那时候后面其实没有 N3 了，所以那一支比实际需要保守一点：
 * 保守的方向是少补一次，反过来是收口发不出去。
 */
const KEEP_AFTER_PLAN = COST.wave + WRITE_RESERVE_MS;

const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 草稿 → 一段纯文本。
 *
 * `buildReconcileUser` 的 `draft` 那一栏收的是字符串，不是 `Draft` —— 对账那一次读的是
 * 「草稿说了什么」，不是草稿的数据结构。这里的排法照 `DRAFT_SYSTEM` 交上来的形状写，
 * 每条断言带着它的四态标签：**标签不递过去，对账那一次就无从判断该把哪一条降级**。
 */
function draftText(draft: Draft): string {
  return [
    `总判断：${draft.thesis || "（草稿没给总判断）"}`,
    ...draft.sections.map((s) =>
      [
        `\n## ${s.dim}`,
        `论点：${s.thesis}`,
        `机制：${s.body}`,
        ...s.assertions.map(
          (a) =>
            `　断言［${a.tag}／${a.confidence}${a.timeSensitive ? "／时效敏感" : ""}${a.loadBearing ? "／承重" : ""}］${a.text}`
        ),
      ].join("\n")
    ),
    draft.unknowns.length ? `\n## 我知道我不知道的\n${draft.unknowns.map((x) => `· ${x}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 打算下强判断的那几维。
 *
 * 取的是草稿里「有一条承重且高置信断言」的维度 —— 那正是 §N3「强判断要两组独立来源」
 * 里「强判断」的定义。不由代码另立一套标准：标准立在 `draft.ts` 的 `loadBearing` 上，
 * 这里只是把它读出来。
 */
function strongDimsOf(draft: Draft): DimId[] {
  return draft.sections
    .filter((s) => s.assertions.some((a) => a.loadBearing && a.confidence === "高"))
    .map((s) => s.dim);
}

/**
 * 草稿 → 一份「什么都没验过」的合并稿。
 *
 * 对账那一次没跑成、或者交回来的行一条都读不出时用它。**不能退回一份空的合并稿**：N5 写的
 * 是「已经对完账的那份稿子」，合并稿空了等于 N1 那一整份先验草稿在这一轮里凭空消失，屏幕上
 * 只剩一份靠检索片段拼出来的东西 —— 那正是这一版存在的理由要反过来的事。
 *
 * 标签一律按未验证给：承重的降 `P!`（内容留着，标成未核并进待核清单），非承重留 `P`。
 * 草稿自己写的 `E*` 在这里一律不认 —— **没有对过账就没有「已证实」这一档**。
 *
 * `only` 给的时候只折那几维（`backfillMerged` 补维度时用）。
 */
export function mergedFromDraft(draft: Draft, only?: ReadonlySet<DimId>): Merged {
  const to = (loadBearing: boolean): Tag => (loadBearing ? "P!" : "P");
  const secs = only ? draft.sections.filter((s) => only.has(s.dim)) : draft.sections;
  return {
    thesis: draft.thesis,
    sections: secs.map((s) => ({
      dim: s.dim,
      thesis: s.thesis,
      body: s.body,
      tags: s.assertions.map((a) => to(a.loadBearing)),
    })),
    changes: secs.flatMap((s) =>
      s.assertions.map((a) => ({
        assertion: a.text,
        from: a.tag,
        to: to(a.loadBearing),
        state: "未验证" as ChangeState,
        evidenceIds: [],
      }))
    ),
    bad: [],
  };
}

/**
 * 合并稿缺的那几维，从草稿补回来。
 *
 * **按「空的」判，不按「抛了」判。** `parseMerged`（`reconcile.ts:49`）从不抛：交回来的东西
 * 乱了、被截了、裹在围栏里，读出来是一份 `sections` 空着的合并稿加一串坏行。而这条路和
 * 「那一次调用挂了」的下游代价一模一样 —— `mergedFor` 每一维都返回空串，`carry()`
 * （`stage-write.ts:253`）于是把合并稿那一整段连「标签怎么用」一起丢掉，N5 又回到「凭证据包
 * ＋ 待核清单 ＋ 公司背景写报告」，正是这一版要倒过来的那个顺序。一次 16k 的 JSONL 回复被
 * 截断是常事，抛异常才是稀有事，所以只守稀有那条等于没守。
 *
 * **读出来一部分也补。** 读出三维就出三维的稿，等于另外五维的先验内容在这一轮里静静消失，
 * 而那和「一维都没读出来」是同一件事的轻症。补的粒度是维度：读出来的那几维原样留着（它们
 * 是真的对过账的），缺的那几维按「未验证」从草稿补（口径见 `mergedFromDraft`）。
 *
 * 总判断以读出来的那一版为准（那是对完账的），空着才退回草稿的。变更日志按断言原文去重 ——
 * 已经判过态的那几条不许被补进来的「未验证」盖掉。
 */
export function backfillMerged(merged: Merged, draft: Draft): { merged: Merged; filled: DimId[] } {
  const have = new Set(merged.sections.map((s) => s.dim));
  const order = [...new Set(draft.sections.map((s) => s.dim))];
  const filled = order.filter((d) => !have.has(d));
  if (!filled.length) return { merged, filled };

  const fb = mergedFromDraft(draft, new Set(filled));
  const seen = new Set(merged.changes.map((c) => c.assertion));
  return {
    merged: {
      thesis: merged.thesis || fb.thesis,
      // 按草稿的维度顺序排，补进来的那几维回到它们本来的位置（一维要么在 `have` 里、要么在
      // `filled` 里，所以下面两个 filter 只有一个出东西）。草稿里没有的维度 —— 模型自己多
      // 交了一维 —— 挂在后面，不丢。
      sections: [
        ...order.flatMap((d) => [
          ...merged.sections.filter((s) => s.dim === d),
          ...fb.sections.filter((s) => s.dim === d),
        ]),
        ...merged.sections.filter((s) => !order.includes(s.dim)),
      ],
      changes: [...merged.changes, ...fb.changes.filter((c) => !seen.has(c.assertion))],
      bad: merged.bad,
    },
    filled,
  };
}

const st = (text: string): Statement => ({ text, traces: [] });

/**
 * 一份区块报告 → 判断板那四节。
 *
 * **这一版四节不再由模型压一遍。** 旧路那一支多发一次 `a4.digest`，代价是两面结论会对
 * 不上（同一轮里报告说「当前更支持」、四节说「不足以判断」是真发生过的事）。这一版报告
 * 本身已经是结构化的块，四节按块的类型直接折：`verdict_banner` + `judgment` 是判断，
 * 证据清单是关键证据，`falsify_card` 是反面，`unverified_panel` 是未知。
 *
 * `[E#]` 原样留着 —— 下一句 `bindCitations` 要靠它把编号换成能点开的溯源。
 */
function foldSections(report: ReportBlocks, ledger: Ledger): Pick<ResearchDoc, "judgment" | "keyEvidence" | "counters" | "unknowns" | "routeSuggestion"> {
  const banner = report.blocks.find((b): b is Extract<Block, { type: "verdict_banner" }> => b.type === "verdict_banner");
  const judgments = report.blocks.filter((b): b is Extract<Block, { type: "judgment" }> => b.type === "judgment");
  const lists = report.blocks.filter((b): b is Extract<Block, { type: "evidence_list" }> => b.type === "evidence_list");
  const panels = report.blocks.filter((b): b is Extract<Block, { type: "unverified_panel" }> => b.type === "unverified_panel");
  const falsify = report.blocks.filter((b): b is Extract<Block, { type: "falsify_card" }> => b.type === "falsify_card");

  const cited = lists.flatMap((b) =>
    b.items.map((i) => st(`${i.claim}${i.id ? `[${i.id}]` : ""}`))
  );
  /*
   * 证据清单那一块没交出来时回落到台账：关键证据这一栏空着的话，判断板上那条判断就成了
   * 一句没有出处的话 —— 而这一轮手上明明有台账。回落条数留三条，和清单块的常见长度一档。
   */
  const fallback = ledger.entries.slice(0, 3).map((e) => st(`${e.claim}[${e.id}]`));

  return {
    /*
     * 判断这一栏**先去同义**（2026-09-07，ISS-239）。那一轮的判断板上第 1 条和第 3 条基本是
     * 同一句话，读的人以为是两条互相印证的判断。
     *
     * 折的是**说法**，不是边界：`foldSynonymousClaims` 拿边界当护栏，一正一反的两条即使字面
     * 很像也不合（实测那两对的字面相似度只差 0.007，靠阈值分不开）。不新增模型调用。
     */
    judgment: foldSynonymousClaims([
      ...(banner
        ? [{ text: banner.boundary ? `${banner.text}（${banner.boundary}）` : banner.text, boundary: banner.boundary }]
        : []),
      ...judgments.map((b) => ({
        text: b.claim,
        ...(b.falsifyCondition ? { boundary: b.falsifyCondition } : {}),
        evidenceRefs: b.evidenceRefs,
      })),
    ]).kept.map((c) => st(c.text)),
    keyEvidence: cited.length ? cited : fallback,
    counters: falsify.flatMap((b) => b.conditions.map((c) => st(`会推翻这条判断的：${c}`))),
    unknowns: panels.flatMap((b) =>
      b.items.map((i) => st(`${i.statement}——${i.whatWouldSettle}`))
    ),
    routeSuggestion: judgments.length
      ? `这一轮机检${banner ? `落在「${banner.confidence}」这一档` : "没有拿到核心判断横幅"}，报告原文在原件页签里。`
      : "这一轮没有折出可上板的判断，先读报告原文。",
  };
}

/**
 * 「跑一次 → 算缺口 → 补正一次 → 缺口没变多才采用」。
 *
 * N0 / N1 / N2 三处的这一段本来是三份几乎一样的代码。合成一处的理由不是短：是**那条纪律
 * 只该有一个出处**。「补正回来的那一版只在缺口不更多时采用」是一条会被后来的人改掉的规矩
 * （它读起来像多余的谨慎），三份各自复制时改掉其中一处，另两处照旧是对的，而没有任何一处
 * 会报错 —— 屏幕上的表现是「有时补正会把一份能用的产物换成更差的」。
 *
 * `usable` 是那一处的额外否决权（N2：一条命题都没抽出来的那一版一律不采用，空计划让 N3
 * 整段空转）。`first` 是第一次就要带的附加消息（N4 退回 N0 时那句诊断）。
 */
async function refineOnce<T>(o: {
  h: Harness;
  /** 屏幕上那句「XX 有 N 条缺口，补正一次」里的 XX。 */
  label: string;
  produce: (extra: Msg[], repairOf?: string) => Promise<T>;
  gapsOf: (v: T) => string[];
  /** 缺口清单 + 上一版 → 补正那一次往后接的消息。 */
  again: (miss: string[], previous: T) => Msg[];
  usable?: (v: T) => boolean;
  /**
   * 哪些缺口值得为它再发一次调用。不给就是「有缺口就补」。2026-09-04 加：N1 草稿的补正一次
   * 137 秒（ISS-227），而触发它的多半是「未知项只有 4 条不足 5 条」这类账面缺口 —— 补回来的
   * 东西不进报告。真正值得补的是整维空掉、总判断缺失那几种。
   */
  worth?: (miss: string[]) => boolean;
  first?: Msg[];
  /** 补正那一次大概要多久，以及后面必须做的事要留多久。见 `deadline.ts`。 */
  cost: number;
  keep: number;
}): Promise<{ value: T; miss: string[] }> {
  let value = await o.produce(o.first ?? []);
  let miss = o.gapsOf(value);
  if (!miss.length) return { value, miss };
  if (o.worth && !o.worth(miss)) {
    o.h.note(`${o.label}有 ${miss.length} 条缺口，都不值得再花一次调用去补`, { 缺口: miss }, "local");
    return { value, miss };
  }

  /*
   * 补正是**多花一次调用换一份更完整的产物**，所以它是这条链上最先该让位的东西：让位的
   * 代价是这一节的缺口留着（照实印在报告文首），不让位的代价是后面取证或者出稿发不出去。
   * 少补一次也要记一句 —— 缺口清单上「N0 主体卡少了业务构成」和「本来能补但没补」是两件事。
   */
  if (!room(o.h.msLeft, o.cost, o.keep)) {
    return { value, miss: [...miss, shedNote(`有 ${miss.length} 条缺口，这一次没补正`, o.h.msLeft)] };
  }

  o.h.substep(`${o.label}有 ${miss.length} 条缺口，补正一次`);
  const again = await o.produce(o.again(miss, value), miss.join("；"));
  const againMiss = o.gapsOf(again);
  /*
   * 只在缺口不更多时采用。**两次的缺口都要各自算一遍**再比：`draftGaps` 的标注率是记在
   * 那个对象上的（`draft.ts` 里那张 WeakMap），拿第一次的数组去衡量第二次的产物会错。
   */
  if ((o.usable ? o.usable(again) : true) && againMiss.length <= miss.length) {
    value = again;
    miss = againMiss;
  }
  return { value, miss };
}

export async function runDeepResearchV2(
  input: A4Input,
  /** `progress` —— 往任务表报进度。见 `HarnessInit.progress`，不给就不报。 */
  opts?: { agentLabel?: string; progress?: { kind: string; id: string } }
): Promise<A4Result> {
  /*
   * 检索家在最前面选出来。选不出来**不抛异常**（同 `run.ts`）：`providers()` 返回一支带
   * `reason` 的空检索器，原话由 `describe()` 带进 trace。
   */
  const { list: search, skipped } = providers();
  const retrieving = search.some((p) => p.name !== "none");

  const h = new Harness({
    agent: "A4",
    slot: "pro",
    /*
     * 这一轮的墙上时间上限（默认 30 分钟，见 `deadline.ts`）。给了 harness 之后，每次调用
     * 的等待上限跟着余量压；该少跑哪一步由下面各处按 `h.msLeft` 自己判，每一处少跑都往
     * `gaps` 里记一句。
     */
    deadlineMs: deadlineMs(),
    ...(opts?.progress ? { progress: { ...opts.progress, total: STEP_TOTAL } } : {}),
  });
  h.note("检索配置", describe(search, skipped), "local");

  /** 这一轮攒下来的缺口。每一条都是某个节点「不过但往下走了」的原话，最后进 `doc.sourceText` 文首。 */
  const gaps: string[] = [];

  /**
   * 把此刻手上这一份**还没走到落库**的稿子摆到任务表上（`Harness.reports`）。数据层挂在那条
   * 线上，一变就抄进库（`store.ts` 的 `keepFinishedReport`），所以进程没了它还在。
   *
   * ## 这一支为什么非要有这一句
   *
   * 这一版从头到尾只产**一份**报告，而它要到 N6 之后才落库。在那之前进程一没（`next dev`
   * 改一个服务端文件就重编译一次），十几分钟、真花过钱的东西一个字都不剩。
   *
   * 那道防线本来是有的：ISS-110 丢掉一份 1.6 万字报告之后建的，挂在 `onTaskReports` 上，而
   * 唯一的来源是四链路那一支的 `report()`（`run.ts:697`）。2026-08-26 默认转到这一支之后，
   * **它跟着旧路一起停了** —— 这一支七个 `h.step()` 一个 `h.reports()` 都没有，于是
   * `UnfinishedResearchRound.reports` 在这条路上恒为空数组。2026-08-31 的 ISS-208 是第一件
   * 有账可查的：那一轮活了不到 16 分钟，被热重载掐断，库里留下 0 份原件，而「留下几份」这个
   * 数同时是屏幕上「有没有报告可读」的唯一依据 —— 于是它连「这一轮到底剩没剩下东西」都答不出。
   *
   * ## 连带：这几份跑的时候也上屏
   *
   * 任务表上那几栏正是报告页在还没落库时读的东西（`store.listReports`），所以这一句同时
   * 把这一支从「跑二十分钟、报告栏一直空着」改成「每走完一步，那一栏就换成手上最新的那一
   * 份」。四链路那一支一直是这样的，这一支之前没有 —— 那段空白不是有意留的，是这条线断了
   * 的副作用。
   *
   * ## 页签 key 必须是 `agent`
   *
   * 那是这一份落库之后的 key（`store.listReports` 主源那一栏）。对不上的后果不是多一栏：他
   * 正读着这一栏，报告落库那一瞬 key 变了，屏幕把他弹回主源（见 `DraftReport.key`）。这一版
   * 只有一份报告，所以这个 key 从第一次上报起就是终值，没有主源顺位那种重排。
   *
   * ## 为什么这里不照搬「正文在出口对账之后才上报」
   *
   * 四链路那一支有这条纪律（`run.ts:697`），理由是没过对账的稿子引用可能绑不上来源，而几十
   * 秒后它会被重写稿悄悄换掉。**这一支照搬就等于这句话白写**：出口对账就是最后一步，等它过
   * 了再报，被掐断的那一轮永远救不到。
   *
   * 所以改成报、但一眼看得出手上是什么：正文顶一行说明它出自哪个节点、还差哪几步。一份 N1
   * 草稿（零证据的模型先验）和一份出稿在屏幕上长得一模一样，而两者的份量差得远 —— 屏幕上那
   * 句「这一份出自一轮没跑完的深研」（`ReportSource.unfinished`）说不了这件事，它答的是
   * 「哪一轮」，不是「哪一步」。
   */
  const keep = (node: string, what: string, text: string, blocks?: ReportBlocks): void => {
    if (!text.trim()) return;
    h.reports([
      {
        key: "agent",
        label: SOURCE_LABEL,
        modelAlias: "v2",
        byAgentLabel: opts?.agentLabel ?? DEFAULT_AGENT_LABEL,
        kind: "writer",
        text: [
          `> 【这不是一份跑完的报告】以下是 ${node} 交出来的${what}。`,
          "> 它还没有过出口对账（N6 那七项机检），句末溯源和四节都还没有 ——" +
            "这一轮要么还在往下跑，要么就停在这一步了。",
          "",
          text,
        ].join("\n"),
        ...(blocks ? { blocks } : {}),
      },
    ]);
  };

  // ---- N0 锚定主体 --------------------------------------------------------
  h.step(STEPS.anchor);
  /*
   * `openContext` 抛出来的 `AgentRunFailed` **原样往上走**：它身上挂着一条
   * `status:"failed"` 的 Run 记录，调用方 `agentRunPut(e.run)` 之后再抛。在这里接住它
   * 当纯外部继续跑，等于图服务一停机所有运行都自动降级，还照样产出一份格式完整的报告。
   *
   * 锚点走判断号这条路，同 A3 预研：图谱里没有前端这些议题对象，按 `input.title` 检索
   * `ISS-*` 一次都命中不了，深研整条只能靠语义检索碰运气（实测 ISS-225 那一轮候选池
   * 拉不开，闸落下转纯外部）；而这些判断号在图里是真实存在的。为空照旧走检索。
   */
  await h.openContext("S03", input.title, { judgmentCodes: input.judgments.map((j) => j.id) });
  const companyContext = h.contextBlock;

  /*
   * 装配清单的底。和四链路那一支**逐字相同**，所以两支共用 `shared.ts` 那一份 —— 里面那两句
   * 「没有公司上下文」的屏幕文字抄成两份的代价写在那个文件头部（同一个议题两边各跑一遍作
   * 对比时，清单上的差异只该来自各自取回来的东西）。
   */
  const base = baseManifest(h, input);

  /*
   * **2026-09-04：v2 默认不再注入 `a4.research.md` 那段认知指令。**
   *
   * 那份落法是给 8/21 那版（纯文本报告 + 四节压缩）写的：它说「全文 1800–3500 字」「只有
   * `## ` 可用」「先报告后压四节」「routeSuggestion 必填」——而 v2 的 system 说一节 3000 字、
   * 一个记号都不许写、JSONL 块、没有四节。同一次分节调用里模型读到两套互相矛盾的篇幅与
   * 格式指令，外加 S03 技能全文 11k 字（ISS-223/226 每节输入 20k–47k token，这一段占了
   * 相当一部分）。v2 的 system（`REPORT_SHAPE` / `VOICE` / `hardRules` / `WITH(OUT)_EVIDENCE`）
   * 已经覆盖了技能里的失败模式，所以先停掉；要拿同题对比，`TKOS_A4_COGNITIVE=1` 拧回去。
   * 给 v2 写一份新的落法是方法部门的事，不在这里补。
   */
  const cog =
    (process.env.TKOS_A4_COGNITIVE ?? "").trim() === "1"
      ? await cognitiveFor("a4.research", h.cognitive["a4.research"])
      : { text: "", source: "empty" as const };
  if (!cog.text) h.note("认知段", { 注入: "否", why: "v2 默认不注入 a4.research.md；TKOS_A4_COGNITIVE=1 打开" }, "local");

  /**
   * 抽一次主体卡。`extra` 是补正那一次往后接的两句（上一稿 + 缺口清单）。
   *
   * 读不出 JSON 时**不抛**：`compileCard({})` 交一张空卡，`cardGaps` 会把每一栏的缺口
   * 逐条报出来 —— 那比一句「模型没有返回 JSON」指得清多了，而且这一轮还能往下走。
   */
  const anchorOnce = async (extra: Msg[] = [], repairOf?: string): Promise<SubjectCard> => {
    let text = "";
    try {
      text = (
        await h.callMessages(
          `模型调用 · a4.anchor${repairOf ? " 补正" : ""}`,
          [
            { role: "system", content: ANCHOR_SYSTEM },
            { role: "user", content: buildAnchorUser(input) },
            ...extra,
          ],
          { slot: "pro", maxTokens: ANCHOR_MAX_TOKENS },
          { promptKey: "a4.anchor", ...(repairOf ? { repairOf } : {}) },
          "a4.anchor"
        )
      ).text;
    } catch (e) {
      /*
       * 调用本身没成（限流、超时、额度）。`callMessages` 追完 trace 会重抛，所以这里必须
       * 接住：一张空卡走下去，`cardGaps` 会把每一栏的缺口逐条报出来，这一轮照旧出得来。
       */
      gaps.push(`N0 主体卡那一次调用没跑成，拿一张空卡往下走：${why(e)}`);
      return compileCard({});
    }
    try {
      return compileCard(parseJson<unknown>(text));
    } catch (e) {
      gaps.push(`主体卡那一次交回来的东西读不出：${why(e)}`);
      return compileCard({});
    }
  };

  /**
   * 跑 N0，缺口非空时补正一次。
   *
   * 仍不过就带缺口往下走（HP-5）：一张行业定义偏泛的卡跑出来的报告仍然有内容，而卡在
   * 这里等于这一轮什么都不产出。缺口进 trace，也进最后那份缺陷清单。
   */
  const nodeAnchor = async (diagnosis = ""): Promise<SubjectCard> => {
    const { value: card, miss } = await refineOnce({
      h,
      label: "主体卡",
      first: diagnosis ? [{ role: "user", content: diagnosis }] : [],
      produce: anchorOnce,
      gapsOf: cardGaps,
      again: (m, previous) => [
        { role: "assistant", content: JSON.stringify(previous) },
        {
          role: "user",
          content: `上面那张卡有这几处不合要求，按同样的形状重交一行 JSON：\n${m.map((x) => `· ${x}`).join("\n")}`,
        },
      ],
      cost: COST.anchor,
      keep: COST.draft + COST.plan + KEEP_AFTER_PLAN,
    });
    if (miss.length) gaps.push(...miss.map((x) => `N0 主体卡：${x}`));
    h.note(
      "主体卡",
      {
        主体: card.subject || "（没识别出主体）",
        行业定义: card.industry || "（空）",
        业务构成: card.segments.map((s) => `${s.name}（${s.weight}，${s.lifecycle}）`),
        战略项目: card.projects.map((p) => `${p.name}${p.heavy ? "（权重过线）" : ""}`),
        时间窗: card.window,
        缺口: miss,
      },
      "local"
    );
    return card;
  };

  let card = await nodeAnchor();

  // ---- N2′ 通义深研取一面 url（跑在 N1/N2 底下）---------------------------
  /*
   * **这一句故意不 await。** 它去发一次通义深研，只要那一面 url（`seed.ts`）。一次要几
   * 分钟，而这一轮的余量只有一百多秒 —— 排在链上等于装不下，跑在 N1 草稿（265 秒）和 N2
   * 检索计划（200 秒）底下就几乎不花墙上时间。
   *
   * 挂了也不抛：`runSeed` 自己把每一种失败折成一张空表加一句原话（HP-5）。这一点是必须的
   * —— 一个没人 await 的 Promise 漏出拒绝，在 Node 上是一次 unhandledRejection。
   *
   * 主体卡在 N4 那一支可能被重划（下面 `nodeAnchor` 会再跑一次），**这一份不跟着重发**：
   * 它带回来的是一批地址，边界重划不会让一个地址变得不该抓，而重发要再花一次几分钟。
   */
  /*
   * 问的是自己家里的事（`card.inward`）时不发：通义拿回来的是外部地址，而这道题没有外部主体
   * 可查。ISS-208 那一轮它交回 60 条地址、四条链 685 条命中、入账 0。
   */
  const seeding = card.inward
    ? Promise.resolve(emptySeedTable("这道题问的是本公司自己的事，外部没有可查的主体，种子不发"))
    : runSeed(card);

  // ---- N1 先写先验草稿 ----------------------------------------------------
  h.step(STEPS.draft);
  /**
   * 写一份草稿。**这一次不检索**（`draft.ts` 头部）：骨架来自模型先验，检索只在后面更新它。
   *
   * `json:false` + `jsonlContinue:1`：交的是一行一节的 JSONL，套 `json_object` 会让它把
   * 整份塞进一个字符串字段（理由同 `run.ts` 出稿那一段）；一行截断了接着写一次。
   */
  const draftOnce = async (c: SubjectCard, extra: Msg[] = [], repairOf?: string): Promise<Draft> => {
    let text = "";
    try {
      text = (
        await h.callMessages(
          `模型调用 · a4.draft${repairOf ? " 补正" : ""}`,
          [
            { role: "system", content: DRAFT_SYSTEM },
            {
              role: "user",
              // 在版判断在这里第一次出现。原来它要到 N5 才进材料，于是「公司已经押了哪些注、
              // 哪几条正在动摇」对**这一轮去查什么**零影响 —— 命题是从这份草稿里抽的。
              /*
               * 公司上下文也在这里第一次出现（2026-09-07，ISS-239）。同一条理由：它原来要到 N5
               * 才进材料，于是「我方已经实现了什么、什么还只是规划」对**这一轮去查什么**零影响 ——
               * 而 239 那一轮的失败正是这一条：报告推荐了一条产线验收的入口，却没有一步核过
               * TKOS 现在做不做得了工艺侧的事。
               */
              content: buildDraftUser({
                title: input.title,
                card: c,
                judgments: input.judgments,
                companyContext,
                userPremises: input.userPremises ?? [],
              }),
            },
            ...extra,
          ],
          { slot: draftSlot(), maxTokens: DRAFT_MAX_TOKENS, json: false, jsonlContinue: 1 },
          { promptKey: "a4.draft", ...(repairOf ? { repairOf } : {}) },
          "a4.draft"
        )
      ).text;
    } catch (e) {
      // 草稿这一次没成，后面每一步都少了它的骨架 —— 但那是一份缺口，不是这一轮的死因。
      gaps.push(`N1 草稿那一次调用没跑成，这一轮没有先验骨架：${why(e)}`);
    }
    const { draft, bad } = parseDraft(text);
    if (bad.length) gaps.push(`N1 草稿有 ${bad.length} 行读不出：${bad.map((b) => `第 ${b.line} 行 ${b.why}`).join("；")}`);
    return draft;
  };

  const nodeDraft = async (c: SubjectCard): Promise<Draft> => {
    const { value: draft, miss } = await refineOnce({
      h,
      label: "草稿",
      produce: (extra, repairOf) => draftOnce(c, extra, repairOf),
      /*
       * `corpus` 是这一轮**真实输入的原文**。给了它才查得动「前提里引的那句原话是不是编的」；
       * 不给就不报那一项 —— 不假装查过。
       */
      gapsOf: (d) => draftGaps(d, { decision: c.decision, corpus: [input.title, companyContext].join("\n") }),
      /*
       * 只在**至少两维整个空掉**或**没有总判断**时补；决策题上骨架一段都没交也补（那是这份稿子
       * 的主体，R-11）。ISS-228：5 行 JSON 读不出触发了一次补正，
       * 390 秒，换回来的草稿和第一稿差别在两三条断言上 —— 而草稿只是骨架，不进报告。一维空掉
       * 由后面的对账和分节按「分不出维度」兜住；「读不出」不再算。
       */
      worth: (m) =>
        m.some((x) => /没有总判断/.test(x)) ||
        m.some((x) => /决策骨架.*只有 0 段/.test(x)) ||
        m.filter((x) => /这一维没有内容/.test(x)).length >= 2,
      again: (m) => [
        {
          role: "user",
          content: `上一稿有这几处不合要求，按同样的形状重交一遍 JSONL：\n${m.map((x) => `· ${x}`).join("\n")}`,
        },
      ],
      cost: COST.draft,
      keep: COST.plan + KEEP_AFTER_PLAN,
    });
    if (miss.length) gaps.push(...miss.map((x) => `N1 草稿：${x}`));
    h.note(
      "先验草稿",
      {
        总判断: draft.thesis || "（空）",
        各维: draft.sections.map((s) => `${s.dim} ${s.thesis}（${s.assertions.length} 条断言）`),
        决策骨架: draft.playbook.map((p) => p.heading),
        我知道我不知道的: draft.unknowns.length,
        缺口: miss,
      },
      "local"
    );
    return draft;
  };

  let draft = await nodeDraft(card);
  // 从这一刻起这一轮手上有东西了。往后每落一个节点就换一次（`keep` 上面那段）。
  keep("N1 先写先验草稿", "先验草稿", mergedFor(mergedFromDraft(draft), DIM_IDS));

  // ---- N2 抽命题、排检索计划 ----------------------------------------------
  h.step(STEPS.plan);
  /*
   * 草稿是空的（N1 那一次没跑成，或交回来的东西一行都读不出）就不排计划：命题从草稿里抽，空草稿
   * 抽出来的是模型自己编的题。ISS-234（网宿 403）：空草稿抽出 19 条，搜回 AI 芯片、EDA 的十一条证据，
   * 全程和这道题无关。这一轮从这儿起就不可能出报告，剩下的时间不该花在搜无关的东西上。
   */
  const draftEmpty = !draft.thesis && !draft.sections.length;
  if (draftEmpty) gaps.push("N1 草稿是空的，检索计划与取证不跑 —— 命题只能从草稿里抽，空草稿抽出来的是编的题");

  /*
   * 主体卡的事实排在计划命题前面（`card-props.ts`）：在建项目、业务构成、客户结构是这一轮的
   * 边界本身，取证第一波先核它们。确定性生成，同题重跑这几条不变；计划抽出来的那些照旧跟在后面。
   *
   * **它挪到 N2 之前是有原因的**（2026-09-07，ISS-239）：这几条走确定性生成、不经 `compilePlan`，
   * 但它们的维度必须并进这一轮的任务范围 —— 不并的话，它们取回来的证据在覆盖表上没有行可落。
   */
  const cardProps = draftEmpty ? [] : cardPropositions(card);

  /*
   * ---- 这一轮的任务范围（ISS-239）------------------------------------------
   *
   * 计划、编译、覆盖、补正、输出检查**读同一个对象**。上一版是各处分别猜哪几维适用：草稿在
   * 决策题上只写三维，而计划那一侧照旧按八维校验（每维至少 2 条、单维查询不超 30%），于是
   * `RUN-A4-mtqpegne-4` 白白补正一次、扩查了一圈和这道题无关的维度。
   *
   * **只改「聚焦关键问题」那句提示词是没用的** —— 闸不改，模型交上来照样被打回。
   *
   * 行业题拿到的是 `INDUSTRY_SCOPE`（八维、每维 2 条、0.3 占比），和改动之前逐条一样。
   */
  const scope = taskScopeFor({
    decision: card.decision,
    draft,
    extraDims: cardProps.map((p) => p.dimension),
  });
  const maxPerDim = maxPerDimFor(scope, h.budget.maxProps);
  const planOnce = async (d: Draft, extra: Msg[] = [], repairOf?: string): Promise<PlannedProposition[]> => {
    let text = "";
    try {
      text = (
        await h.callMessages(
          `模型调用 · a4.plan${repairOf ? " 补正" : ""}`,
          [
            { role: "system", content: planSystemFor(scope) },
            // `maxPerDim` 递进去而不是只在 `compilePlan` 里截：见 `buildPlanUser` 上那段。
            { role: "user", content: buildPlanUser(d, maxPerDim, scope) },
            ...extra,
          ],
          /*
           * **一行一条 JSONL，截断了接着写一次** —— 和 N1 草稿同一个形状，理由是同一个。
           *
           * 上一版是 `json: true` 的一个整对象、不许续写。而这几个模型的**思考也算在
           * `max_tokens` 里**，计划这一步的思考能吃掉九成额度（实测两次 `out=8001`、
           * 其中思考 7194 和 5416）—— 整对象截一刀就全读不出，命题归零，N3 分维度取证
           * 整段跳过，而这一轮照旧出稿、照旧报 ok。换成按行之后，截断的代价从「整轮取证
           * 没了」降到「最后一条没了」。
           */
          { slot: planSlot(), maxTokens: PLAN_MAX_TOKENS, json: false, jsonlContinue: 1 },
          { promptKey: "a4.plan", ...(repairOf ? { repairOf } : {}) },
          "a4.plan"
        )
      ).text;
    } catch (e) {
      // 计划没抽出来 = N3 整段空转（下面那一支会把它记成「一条命题都没抽出来」）。
      gaps.push(`N2 检索计划那一次调用没跑成：${why(e)}`);
      return [];
    }
    const { propositions, bad } = parsePlanLines(text);
    /*
     * 坏行要报出来。**一条都读不出和「读出来八条、丢了第九条」是两件事**：前者说明这一步
     * 整个白跑（多半是额度被思考吃光），后者只是最后一条被截掉，而那正是按行读要换来的东西。
     */
    if (bad.length) {
      gaps.push(
        `N2 检索计划有 ${bad.length} 行读不出：` +
          bad.map((b) => `第 ${b.line} 行 ${b.why}`).join("；")
      );
    }
    try {
      return compilePlan({ propositions }, maxPerDim, scope);
    } catch (e) {
      gaps.push(`N2 检索计划那一次交回来的东西读不出：${why(e)}`);
      return [];
    }
  };

  /*
   * 问的是自己家里的事时不排检索计划：命题是拿去外部核的，而这道题外部没有可核的主体。
   * 少这一步是 156 秒（ISS-208 实测），后面取证那一段跟着整段不跑（下面 `emptySweep` 那一支）。
   */
  const planned: { value: PlannedProposition[]; miss: string[] } = card.inward || draftEmpty
    ? { value: [], miss: [] }
    : await refineOnce({
    h,
    label: "检索计划",
    produce: (extra, repairOf) => planOnce(draft, extra, repairOf),
    gapsOf: (pp) => planGaps(pp, scope),
    /*
     * 计划只在**命题不够用**时补：少于八条，或一条反向问法都没有。「某一维只有一条」「某条只覆盖一类
     * 来源」这类缺口不值一次三分钟的调用 —— ISS-235 为八条这样的缺口补正了 2 分 59 秒，换回来的计划
     * 每维条数一模一样。
     */
    /*
     * 决策题上**值得**花那一次补正调用的是「关键问题没有命题」，不是「某一维只有 1 条」——
     * 后者在三维的题上是常态（ISS-239 就为这类缺口补正过一次，换回来的计划每维条数一模一样）。
     */
    worth: (m) =>
      m.some((x) => /一条反向问法都没有/.test(x)) ||
      m.some((x) => x.startsWith("关键问题")) ||
      m.filter((x) => /只有 0 条命题/.test(x)).length >= 2,
    again: (m) => [
      {
        role: "user",
        content: `上一版计划有这几处不合要求，按同样的形状重交一遍：\n${m.map((x) => `· ${x}`).join("\n")}`,
      },
    ],
    // **一条命题都没抽出来的那一版一律不采用**：空计划让 N3 整段空转，那比一份缺口清单
    // 长的计划坏得多。
    usable: (v) => v.length > 0,
    cost: COST.plan,
    keep: KEEP_AFTER_PLAN,
  });
  /*
   * 会改变选择、又没有任何命题接着的那几条关键问题，在这里**确定性补一条**
   * （`fillQuestionGaps`，2026-09-07 ISS-240）。提示词已经写到位、补正也跑过一次，
   * 那一轮仍有五条没人接 —— 该由代码保证的东西不要交给提示词，同主体卡命题那一条。
   */
  const filled = fillQuestionGaps(scope, planned.value, card.subject);
  const props = [...cardProps, ...planned.value, ...filled];
  const planMiss = planned.miss;
  if (planMiss.length) gaps.push(...planMiss.map((x) => `N2 检索计划：${x}`));
  h.note(
    "检索计划",
    {
      条数: props.length,
      主体卡命题: cardProps.map((p) => `${p.id} ${p.statement}`),
      ...(filled.length
        ? { 关键问题补的: filled.map((p) => `${p.id}（${p.questionId ?? ""}）${p.statement}`) }
        : {}),
      每维: scope.dims.map((d) => `${d} ${props.filter((p) => p.dimension === d).length} 条`),
      检索式: props.reduce((n, p) => n + p.queries.length + p.counterQueries.length, 0),
      缺口: planMiss,
    },
    "local"
  );

  const strongDims = strongDimsOf(draft);

  // ---- N3 分维度取证 ------------------------------------------------------
  h.step(STEPS.sweep);
  /*
   * 收 N2′。到这儿它已经在 N1+N2 底下跑了四百多秒，正常情况下这一句立刻返回。
   *
   * 还没跑完的话就在这儿等 —— 但等不过它自己那个 4 分钟的上限（`qwen-research.ts` 的
   * `DEFAULT_TIMEOUT_MS`），到点它会拿手上已收的那几条自己收口。所以这里不另设超时：
   * 两处各设一个，短的那个生效而长的那个永远不触发，读代码的人会以为生效的是另一个。
   */
  const seeds = await seeding;
  h.note(
    "N2′ 深研种子",
    {
      地址: seeds.hits.length,
      扫到: seeds.account.seen,
      走过的阶段: seeds.account.phases,
      耗时秒: Math.round((seeds.account.ms.clarify + seeds.account.ms.research) / 1000),
      缺口: seeds.reason || "无",
    },
    "local"
  );
  /*
   * **没跑成要上报告文首那份清单，不是只上 trace。**
   *
   * 这一句和 `sweep` 那几条「少发了一波」是同一条纪律（`sweep.ts` 文件头最后一节）：一份
   * 「种子那一步挂了、全靠自己搜」的报告和一份「种子给了六十条」的报告，屏幕上长得一模一样。
   *
   * 唯独「这台机器没配」那一类不进 —— 那是常态配置，不是这一轮出的事，天天挂在报告文首会把
   * 真正的缺口淹掉。它在上面那条 note 里，查得到。
   */
  if (seeds.reason && !seeds.reason.includes("这台机器没配") && !seeds.reason.includes("TKOS_DR_SEED")) {
    gaps.push(`N2′ ${seeds.reason}`);
  }
  /**
   * 空的那一份账。没联网、或者一条命题都没抽出来时用它 —— 下游每一处都读
   * `SweepResult`，给它一份空的比到处判 null 少一类分支。
   */
  const emptySweep = (): SweepResult => {
    /*
     * 这一轮没取证，但**预研那一轮的证据照样垫进来**。
     *
     * 这一支正是它最值钱的时候：没配检索 key、或者一条命题都没抽出来，本轮拿不到任何
     * 外部材料 —— 而预研那一轮可能已经查到了东西。不垫的话，一份「其实有证据」的报告
     * 会按「本轮未联网」那一支去写。
     *
     * **覆盖表照旧全零，不拿这几条去凑。** 覆盖判定问的是「这一维有没有两组独立来源」，
     * 而这一支连命题都可能没有，没有命题就无从谈起某一维闭没闭合。把预研那几条算进
     * 覆盖表等于用上一轮的账去开这一轮的门。
     */
    const ledger = new Ledger();
    if (input.preEvidence?.length) ledger.adopt(input.preEvidence);
    return {
      ledger,
      rounds: [],
      verdicts: [],
      // 覆盖表只出这一轮**范围里**的维度（ISS-239）：范围外的维度报缺失是假账 ——
      // 那几维这道题压根不需要，报出来只会去争 N6 那一轮重写的预算。
      coverage: scope.dims.map((dim): DimCoverage => ({ dim, independentGroups: 0, notFound: { tried: [] } })),
      gate: { ok: false, missing: scope.dims.map((d) => `${d} 这一维一组独立来源都没有`) },
      rewrites: [],
      capped: [],
      // 这一支的语义正好是「一条都没搜过」—— 关键问题的状态因此全是「未搜」，
      // 而不是「已搜未得」。两者在报告里说的不是一句话。
      questions: scopeTrace(scope, { props: [], entries: [], tried: new Map() }),
    };
  };

  let swept: SweepResult;
  /*
   * 没配检索但 N2′ 拿回了地址时**照跑**：种子是一批可以直接抓的 url，走的是 `fetchPages`
   * 那条路，不经过任何一家检索。这一轮的检索式会全部发空、`hits` 恒为零，而那几条种子照样
   * 抓得下来、抽得出证据。
   *
   * 一条命题都没有的那一支不在此列：那时候抽取无从对照，抓回来也没有人读。
   */
  const bySeedOnly = !retrieving && seeds.hits.length > 0;
  if (card.inward || (!retrieving && !bySeedOnly) || !props.length) {
    swept = emptySweep();
    const reason = card.inward
      ? "这道题问的是本公司自己的事，答案在内部数据里，外部没有可查的主体"
      : retrieving
        ? "一条命题都没抽出来"
        : "这台机器没配检索";
    /*
     * 「本轮没取证」和「手上一条证据都没有」是两件事，报告文首那份清单要分得开：
     * 垫了预研证据的那一次，正文里的引用是有出处的，只是出处来自上一轮。
     */
    const seeded = swept.ledger.entries.length;
    gaps.push(
      seeded
        ? `N3 取证整段没跑：${reason}。正文里的证据全部来自这个议题的预研那一轮（${seeded} 条），本轮未新增。`
        : `N3 取证整段没跑：${reason}`
    );
    h.note("分维度取证 · 跳过", { 原因: reason, 命题: props.length, 垫入预研证据: seeded }, "local");
  } else {
    swept = await sweep(h, search, props, {
      /*
       * 抽取那一步走 `flash`：一波检索抓下来十几页，每页各抽一次，这一步是整条链里调用
       * 次数最多的一段，而它做的是「把这一页里的数字和引句摘出来」——便宜跑量正是它。
       *
       * 2026-08-27 之前这里是 `seed`（方舟上的豆包），撤掉了：一轮真运行里它 8 次调用整整
       * 卡满 180 秒、输入输出都是 0，一个字没抽出来却占了那一轮 32.3 分钟墙钟。
       * 换成同家族的 `flash` 是有意的，理由写在 `models/slots.ts` 文件头那一节。
       */
      slot: "flash",
      strongDims,
      // 主体名给排序用：提到「维信诺」的页排前面（2026-09-04，`research/rank.ts`）。
      subject: card.subject,
      /*
       * 官网域名给抓取位保留用（2026-09-07，ISS-238，`research/slots.ts`）：重大公告和 IR
       * 材料挂在自己站上，那和巨潮一样是一手的。没识别出官网就是空表 —— 那时只剩交易所与
       * 巨潮那几家，少一格，不影响其余。
       */
      disclosureDomains: card.website ? [card.website] : [],
      decision: card.decision,
      // 这一轮的任务范围（ISS-239）：覆盖表按它出行，关键问题的补搜按它排优先级。
      scope,
      substep: (suffix) => h.substep(suffix),
      prior: input.preEvidence,
      seeds: seeds.hits,
    });
    /*
     * 只靠种子跑完的那一轮**必须说出来**：它的每一条证据都来自同一次深研踩过的地址，
     * 而独立性折叠只看域名和正文，看不出「这批页是同一个检索器一次给的」。不说的话，
     * 一份来源面其实很窄的报告和一份三家检索交叉搜出来的报告在屏幕上一模一样。
     */
    if (bySeedOnly) {
      gaps.push(
        `N3 这一轮没有走任何检索家（这台机器没配检索），全部 ${seeds.hits.length} 条抓取目标` +
          "都来自 N2′ 那一次深研交回来的地址"
      );
    }
    /*
     * 覆盖门没开**不重跑**（§N3）：同一批命题对着同一批检索家再跑一遍，回来的是同一批页。
     * 缺口进 `A4Evidencing` 和 N6 的 A4-N02 —— 那条规则打回的是 N3，而 N6 那边也不会真的
     * 再跑一次取证，它把这条挂在缺陷清单上出稿。
     */
    if (!swept.gate.ok) gaps.push(...swept.gate.missing.map((x) => `N3 覆盖：${x}`));
    /*
     * 少发的那几波**上报告文首**，不是只上 trace。这两句话在屏幕上必须分得开：
     * 「这一维搜过没找到」（覆盖表那几条）和「这一维压根没搜」（这几条）——后者是我们自己
     * 为了赶上时间上限压掉的，而读报告的人凭正文分不出来。
     */
    if (swept.capped.length) gaps.push(...swept.capped.map((x) => `N3 取证：${x}`));
  }

  // ---- N4 证据与草稿对账 --------------------------------------------------
  h.step(STEPS.reconcile);
  const evidencePack = buildEvidencePack(swept.ledger.entries);
  /**
   * 逐条对账。四态里每条断言落在哪一态由这一次定（证实 / 修正 / 矛盾 / 未验证）。
   *
   * `parseMerged` 读不出的行自己记账、不抛，所以**读不出**和**没跑成**在这里是两条路：
   * 前者回来是一份缺维（可能一维都不剩）的合并稿，走 `backfillMerged` 按维度补；后者进
   * 下面那个 catch，整份退回 `mergedFromDraft`。两条路都往 `gaps` 记一句 —— 补过的那一份
   * 和真对过账的那一份在屏幕上长得一样，不记的话读它的人以为这几维验过了。
   */
  const reconcileOnce = async (d: Draft, extra: Msg[] = [], repairOf?: string): Promise<Merged> => {
    try {
      const r = await h.callMessages(
        `模型调用 · a4.reconcile${repairOf ? " 重跑" : ""}`,
        [
          { role: "system", content: RECONCILE_SYSTEM },
                      {
              role: "user",
              /*
               * 候选路线一起递进去（2026-09-07，ISS-239）。**这是这一批的主修点**：
               * 上一版 N4 只对外部事实，行动骨架整段绕过对账直接进 N5 —— 于是
               * `RUN-A4-mtqpegne-4` 那一轮里，对账已经把「采购只为当期成本 KPI 买单」
               * 改成了「未获证实」，最终报告的强命令一条没动。
               *
               * 不递这一句，决策题一律落「策略复核未完成」：报告仍可读、可讨论，但不含
               * 可下达的行动建议。那是有意的降级，不是它的正常形态。
               */
              content: buildReconcileUser({
                draft: draftText(d),
                evidencePack,
                ...candidatesFromPlaybook(d.playbook),
              }),
            },
          ...extra,
        ],
        /*
         * 对账走 `synth` 而不是 `alt`。**草稿是 `alt` 写的**（N1），让它自己回来逐条判自己
         * 那几句话站不站得住，正是 `models/slots.ts` 那条不变量说的「自己判自己会通过自己的
         * 失败模式」—— 它会稳定放过自己那一类错，而屏幕上写着「已对账」。
         *
         * 2026-08-26 到 08-27 之间这里是 `alt`：N1 草稿、N4 对账、N5 全部成稿都压在同一个模型
         * 上，整条链没有一步是别人核的（`synth` 只剩 N6 那几次 500 token 的锚点检查）。
         *
         * 挑 `synth` 而不是 `pro`：它本来就是判断板的主源，而且这一版里它几乎没活干。代价是
         * Bedrock 那一侧不自动命中缓存（方舟侧会），这一次的输入要按全价算。
         */
        { slot: reconcileSlot(), maxTokens: RECONCILE_MAX_TOKENS, json: false, jsonlContinue: 1 },
        { promptKey: "a4.reconcile", ...(repairOf ? { repairOf } : {}) },
        "a4.reconcile"
      );
      const read = parseMerged(r.text);
      const fixed = backfillMerged(read, d);
      if (fixed.filled.length) {
        gaps.push(
          read.sections.length
            ? `N4 对账只读出 ${read.sections.length} 维，${fixed.filled.join("、")} 按草稿原样补进合并稿（这几维一条都没验过）`
            : `N4 对账交回来的合并稿一维都读不出（坏行 ${read.bad.length} 行），这一份按草稿原样出稿（一条都没验过）`
        );
      }
      return fixed.merged;
    } catch (e) {
      /*
       * 这一次挂掉的代价最大：它是整条链上最贵的一次调用（16k），而且它一挂，前面 N1 的
       * 草稿和 N3 的证据就都没有汇合点了。所以**不往上抛**：退一份「什么都没验过」的合并稿
       * （见 `mergedFromDraft`），这一份带着「对账那一次没跑成」出稿。往上抛的那一版等于
       * 一次 429 让这一轮取回来的证据全部作废，而调用方拿到的是一个光秃秃的 `Error`。
       */
      gaps.push(`N4 对账那一次调用没跑成，这一份按草稿原样出稿（一条都没验过）：${why(e)}`);
      return mergedFromDraft(d);
    }
  };

  /** 矛盾态占几成。分母是这一次真的判了的条数 —— 一条都没判时不算这个比例。 */
  const contradictionRate = (m: Merged): number =>
    m.changes.length ? m.changes.filter((c) => c.state === "矛盾").length / m.changes.length : 0;

  const noteMerged = (m: Merged, label: string): void => {
    h.note(
      label,
      {
        总判断: m.thesis || "（空）",
        各维: m.sections.map((s) => `${s.dim} ${s.thesis}`),
        四态: ["证实", "修正", "矛盾", "未验证"].map(
          (state) => `${state} ${m.changes.filter((c) => c.state === state).length} 条`
        ),
        矛盾占比: `${Math.round(contradictionRate(m) * 100)}%`,
        读不出的行: m.bad.length,
      },
      "local"
    );
  };

  let merged = await reconcileOnce(draft);
  noteMerged(merged, "证据与草稿对账");

  if (contradictionRate(merged) > CONTRADICTION_ABORT) {
    /*
     * 矛盾态过三成 = 先验和证据在**大面上**对不上，而那通常不是某一条断言错了，是行业
     * 边界划错了 —— 于是草稿整篇在讲另一个行业的事。所以退回 N0 重划边界，**只退一次**。
     *
     * 退回 N0 之后草稿也要重写：N4 读的是草稿，卡换了而草稿没换，这一次对账拿到的还是
     * 同一份东西。**不退回 N2/N3**：那两步的产物是这一轮取回来的证据，证据不会因为边界
     * 重划就变了，重跑只是把同一批页再抓一遍（同 §N3 那条「不重跑」）。
     */
    const diagnosis = `上一轮对账里有 ${Math.round(contradictionRate(merged) * 100)}% 的断言和证据矛盾，多半是行业边界划偏了。这几条是矛盾的：\n${merged.changes
      .filter((c) => c.state === "矛盾")
      .slice(0, 8)
      .map((c) => `· ${c.assertion}`)
      .join("\n")}\n重划一次边界再交那一行 JSON。`;
    /*
     * 退这一次要三笔调用（重划边界、重写草稿、重对一遍账），是这条链上第二贵的一段。
     * 凑不出这三笔加出稿那一整段就不退：带着 30% 矛盾出稿仍然是一份能读的报告（矛盾占比
     * 印在缺口清单上），而退了却没时间出稿是一份没有报告。
     */
    if (!room(h.msLeft, COST.anchor + COST.draft + COST.reconcile, WRITE_RESERVE_MS)) {
      gaps.push(
        shedNote(
          `N4 对账：矛盾态占 ${Math.round(contradictionRate(merged) * 100)}%，` +
            "本该退回 N0 重划一次行业边界，这一次没退",
          h.msLeft
        )
      );
    } else {
      h.substep("矛盾态过三成，退回 N0 重跑一次");
      card = await nodeAnchor(diagnosis);
      draft = await nodeDraft(card);
      merged = await reconcileOnce(draft, [], "矛盾态过三成");
      noteMerged(merged, "证据与草稿对账 · 退回 N0 之后");
      if (contradictionRate(merged) > CONTRADICTION_ABORT) {
        gaps.push(
          `N4 对账：退回 N0 重跑之后矛盾态仍占 ${Math.round(contradictionRate(merged) * 100)}%，这一份带诊断出稿`
        );
      }
    }
  }
  if (merged.bad.length) gaps.push(`N4 对账有 ${merged.bad.length} 行读不出`);
  /*
   * `reconcileGaps` 是 N4 自己那三条检查：漏对账的断言、正文里留着的 X 标、矛盾占比。
   * 矛盾那一条上面已经处置过（退回 N0），这里把三条一并记进缺口就收 —— **不为它重跑**：
   * 同一份草稿对同一批证据再对一遍，回来的是同一份合并稿（同 §N3 那条「不重跑」）。
   * 漏掉这一句的话，「草稿里有断言压根没被对账过」这件事到 N5 就再也查不出来了。
   */
  const mergedMiss = reconcileGaps(draft, merged);
  if (mergedMiss.length) {
    h.note("对账缺口", { 三条检查: mergedMiss }, "local");
    gaps.push(...mergedMiss.map((x) => `N4 对账：${x}`));
  }

  // ---- N5 分层成稿 --------------------------------------------------------
  const material: A4ReportInput = {
    ...input,
    companyContext,
    cognitive: cog.text,
    evidencePack,
    unresolved: buildUnresolved(props, swept.verdicts),
  };
  const laneMark = (t0: number): ReportBlocks["lane"] => ({
    model: "v2",
    short: SOURCE_LABEL,
    durationS: Math.round((Date.now() - t0) / 1000),
  });

  /**
   * 锚点相关性检查。`judgment` 块里那几条「什么内部数据能裁决它」，每条各发一次。
   *
   * 走 `synth` —— 评审者换一个模型系：判「这条内部锚点和这次研究有没有交集」的那一位
   * 不该是刚刚写完这份报告的那一位，不然它只会确认自己写的东西。
   *
   * 一次挂了只算那一条没过（不进 `gatedHooks`），下一句 `stripHooks` 把它从正文摘掉 ——
   * 摘掉比留着强：留着的话 A4-N06 会判一条 p0，而那条 p0 打回的是同一次调用。
   *
   * **它写在 N5 前面、并且作为回调递进成稿那一步**，不是编排顺序上的随意选择：`blocksToText`
   * 会把「什么内部数据能裁决它」渲染进正文（`report.ts:276`），所以摘必须发生在冻文字之前。
   * 摘在后面的话，同一份报告在两个视图里各说一套 —— 原件页签留着的正是这一步已经判掉的那
   * 几条锚点，而落库的块里它们已经没了；`lintAssembled` 和 `gateReport` 报的也是摘之前那一
   * 份的账。加这道检查就是为了拦上下文污染，摘晚一步等于它在两个视图里的一个仍然污染着。
   */
  const gateHooks = async (report: ReportBlocks): Promise<{ gated: string[]; removed: string[] }> => {
    const hooks = hooksOf(report.blocks);
    /*
     * **2026-09-04：合成一次调用。** 上一版每条各发一次、12 并发：ISS-223 送检 22 条一次都没
     * 发出去（剩 0 秒），ISS-226 送检 26 条花 73 秒。几条之间没有依赖这一点没变 —— 模型一行
     * 答一条 —— 变的只是等待次数。额度按条数给：每行十来个 token，另留 200 兜底。
     * 一次挂了就是全部没过（下一句把它们全部摘掉），和上一版「上游超时则全部未发」的结局
     * 一样，但只付一次等待；缺口清单上也只记一句。
     */
    let verdicts: boolean[] = hooks.map(() => false);
    if (hooks.length) {
      try {
        const r = await h.callMessages(
          `模型调用 · a4.anchor-gate（合批 ${hooks.length} 条）`,
          [
            { role: "system", content: ANCHOR_GATE_BATCH_SYSTEM },
            {
              role: "user",
              content: buildAnchorGateBatchUser({
                industry: card.industry,
                anchors: hooks,
                propositions: props.map((p) => `${p.id} ${p.statement}`),
              }),
            },
          ],
          // 额度按条数给，且要宽：`synth` 是推理模型，思考 token 计入 max_tokens，截断后后半锚点全判「不能」。
          { slot: "synth", maxTokens: Math.max(2000, 80 * hooks.length + 500), json: false },
          { promptKey: "a4.anchor-gate", hooks: hooks.length },
          "a4.anchor-gate"
        );
        verdicts = readAnchorBatchVerdicts(r.text, hooks.length).map((v) => v.pass);
        if (r.stopReason === "length") {
          gaps.push(`N6 锚点相关性检查那一次回答被截断（${hooks.length} 条），后半几条按未过摘掉`);
        }
      } catch (e) {
        gaps.push(`N6 锚点相关性检查（合批 ${hooks.length} 条）那一次没跑成，这几条全部按未过摘掉：${why(e)}`);
      }
    }
    const gated = hooks.filter((_, i) => verdicts[i]);
    const stripped = stripHooks(report.blocks, gated);
    report.blocks = stripped.blocks;
    h.note(
      "锚点相关性检查",
      { 送检: hooks.length, 过了: gated, 摘掉: stripped.removed },
      "local"
    );
    return { gated, removed: stripped.removed };
  };

  /**
   * 最近一遍锚点检查的结果。`auditExit` 的 A4-N06 读 `gated` 那一栏 —— 它问的是「这一份还剩
   * 几条过了检查的内部锚点」，所以它必须是**这一稿**的账：打回重写之后跟着换，不然第二稿的
   * 判断块对着第一稿的锚点结论过闸。
   */
  let gated: { gated: string[]; removed: string[] } = { gated: [], removed: [] };
  /**
   * 那一遍到底跑过没有。**`gated` 答不出这件事**：`stripHooks` 会把没过的锚点从块里摘掉，所以
   * 到出口对账的时候「送检了、一条都没过」和「压根没送检」在数据上长得一模一样（都是空账 +
   * 报告里剩下的锚点全在 `gated` 里 —— 后者那种情况下报告里那些锚点谁都没看过）。A4-N06 读
   * 这一栏才分得开。
   */
  let anchorGateRan = false;

  /**
   * 跑一遍成稿。这一段的正文在 `stage-write.ts`（为什么单独一个文件，写在那个文件头部）。
   *
   * 这里只做编排该做的三件事：把 N0 的主体卡和 N4 的合并稿递进去、把锚点检查作为「冻文字
   * 之前摘一遍」的回调递进去、把它记的账折进这一轮的缺陷清单。
   *
   * **合并稿必须递**：`A4ReportInput` 上没有草稿这一栏（那是四链路那一版的形状，那一版没有
   * 草稿）。不递的话这一版最贵的那条规矩就废了 —— N1 写的先验内容和 N4 判的四态标签算完就
   * 丢，报告又成了从「证据包 + 待核清单 + 公司背景」写出来的东西，正是这一版要倒过来的那个
   * 顺序；而「缺证据只降标签、永不删内容」在 `reconcile.ts` 里守住了，却在写之前被丢掉。
   *
   * `pushback` 是上一轮出口对账没过的那几条。**打回不带原因，等于让模型重写一份它不知道
   * 哪里错了的报告**（同 `run.ts:1035` 那条注释：回来的是一份全新的报告，不是改好的那一
   * 份）。区块级的那几条（`lint`）不从这里走：它们指得到具体块，由 `stage-write.ts` 里那一次
   * `spliceRepair` 只重发被指名的块，别的一个字不动。
   */
  const layerOnce = async (pushback: readonly Violation[] = []): Promise<StageWritten> => {
    const t0 = Date.now();
    const w = await writeStaged({
      h,
      material,
      card,
      merged,
      /*
       * **这一栏现在是候选，不是建议**（2026-09-07，ISS-239）。`writeStaged` 进门第一件事是
       * 拿它和 `merged` 过一遍 `reviewPlaybook`，之后每一次出稿调用看到的只有复核过的那一份。
       * 上一版这里递进去的是 N1 的原骨架、一路直达 N5 —— 于是对账把「采购只为当期成本 KPI
       * 买单」改成「未获证实」之后，最终报告的强命令一条没动。
       */
      playbook: draft.playbook,
      props,
      ledger: swept.ledger,
      verdicts: swept.verdicts,
      // 关键问题的账给出口那三条用（A4-G07/G08/G09）。行业题恒为空表。
      questions: swept.questions ?? [],
      dims: DIM_IDS,
      lane: () => laneMark(t0),
      ...(pushback.length ? { pushback } : {}),
      stripAnchors: async (report) => {
        anchorGateRan = true;
        gated = await gateHooks(report);
        return gated;
      },
    });
    if (w.notes.length) gaps.push(...w.notes.map((x) => `N5 成稿：${x}`));
    return w;
  };

  /*
   * 摆在这里而不是紧跟每一次 `reconcileOnce`：N4 里合并稿可能被重跑换掉一次（矛盾态过三成
   * 退回 N0 那一支），而要留下来的一直是最新那一份。进 N5 之前只有一个位置，赋值有几处都盖得住。
   */
  keep("N4 证据与草稿对账", "合并稿", mergedFor(merged, DIM_IDS));

  h.step(STEPS.layer);
  let written = await layerOnce();
  keep("N5 分层成稿", "报告正文", written.text, written.report);

  // ---- N6 出口对账 --------------------------------------------------------
  /*
   * 这一步的第一件事（锚点相关性检查）已经在上一步里跑完了 —— 见 `gateHooks` 上面那段：它
   * 必须在冻文字之前摘。所以进度条上它记在「分层成稿」那一格，账在这里用。
   */
  h.step(STEPS.audit);

  /** 落回主体那一节和战略项目有没有交集，A4-N05 查的是这个。取的是这一份自己的判断句。 */
  const subjectVariablesOf = (report: ReportBlocks): string[] => [
    ...report.blocks
      .filter((b): b is Extract<Block, { type: "verdict_banner" }> => b.type === "verdict_banner")
      .map((b) => b.text),
    ...report.blocks
      .filter((b): b is Extract<Block, { type: "judgment" }> => b.type === "judgment")
      .map((b) => b.claim),
  ];

  const runAudit = (): Violation[] =>
    auditExit({
      report: written.report,
      card,
      coverage: swept.coverage,
      strongDims,
      /*
       * 这两栏都只由 `layerOnce` 递进去的那个 `stripAnchors` 回调填。那个回调不是可选优化：
       * 摘不摘决定报告里留着什么，送不送检决定这道闸看见什么。
       *
       * `gatedHooks` 一栏答不出「跑过没有」——「一条过检的锚点都没有」和「压根没送检」在它
       * 里面长得一样，而后者那种情况下报告里那几条锚点谁都没看过。所以 `anchorGateRan` 单
       * 独递一栏：谁把回调去掉，A4-N06 报的是这一条，而不是安静地过。
       */
      gatedHooks: gated.gated,
      anchorGateRan,
      /*
       * 取证跑没跑过。**读 `rounds` 而不是覆盖表**：跳过那一支（`emptySweep`）返回的覆盖表
       * 和「跑了一波、每一维都空手」的覆盖表一模一样（全零），只有轮次数分得开这两种。
       */
      retrievalRan: swept.rounds.length > 0,
      inward: card.inward,
      subjectVariables: subjectVariablesOf(written.report),
      calculations: written.gate.calculations,
      /*
       * ---- 批 V：决断包与新鲜度（2026-09-07）--------------------------------
       *
       * `commandBriefAsked` 递的是**收口那一次到底要没要**，不是「这道题该不该有」。
       * 两者在决策题上同真，但写成 `card.decision` 之外的第二个判断就会漂：哪天收口
       * 提示词换了条件，这道闸会安静地对着一份根本没被要求交的报告报 p0。所以两处读
       * 同一个 `card.decision` —— 它就是 `a4ClosingSystem(…, decision)` 那一栏。
       *
       * `entries` 给 A4-N09：判「台账里有没有最近一期披露」。`now` 不给就整条不判，
       * 所以这里必须给。
       */
      commandBriefAsked: card.decision,
      /*
       * 这一轮的任务范围（2026-09-07，ISS-239）。A4-N02 / N03 按它出缺失 —— 不递的话，
       * 决策题上那几个压根不需要的维度会被逐条报成「一组独立来源都没有」，而那些缺失
       * 一条都改不动，只会去争 N6 那一轮重写的预算。
       */
      scope,
      entries: swept.ledger.entries,
      now: new Date(),
      // 主体自己的官网也算一手披露（`anchor.ts` 的 `website`，识别不出就是空表）。
      disclosureDomains: card.website ? [card.website] : [],
    });

  let audit = runAudit();
  let auditRound = 1;
  const firstRoundViolations = [...written.lint, ...written.gate.violations, ...audit].map(fmt);

  while (blocking(audit).length && auditRound < MAX_AUDIT_ROUNDS) {
    const nodes = backTo(blocking(audit));
    h.substep(`打回第 ${auditRound} 轮 · ${nodes.join("、") || "无可打回的节点"}`);
    h.note(
      `出口对账 · 第 ${auditRound} 轮`,
      { 打回: nodes, 违规: blocking(audit).map(fmt) },
      "local"
    );
    if (!nodes.length) break;
    /*
     * **只打回 N3 的那一种：这一轮就在这里收口。**
     *
     * N3 不重跑（§N3，同一批命题对同一批检索家只会取回同一批页），而这一轮 N6 报的是覆盖表上
     * 的缺口 —— 那张表由取证决定，再写一遍报告改不动它一个格。所以往下走的话是：整份报告重写
     * 一遍（一次成稿调用，那是这条链最贵的一次），然后第二遍出口对账**一字不差地**再报同一
     * 条，最后照样带着缺陷清单出稿。中间那一遍除了钱和时间什么都没换来。
     *
     * 打回的节点里只要还有别的（N0/N5、N4、N5），照旧重来 —— 那几步重跑真的会换掉下一稿。
     */
    const rerunnable = nodes.filter((n) => n !== "N3");
    if (!rerunnable.length) {
      gaps.push(
        "N6 打回 N3，但取证这一步不重跑，成稿也改不了覆盖表（同一批命题对同一批检索家只会取回同一批页）—— 这一轮不再重写报告"
      );
      break;
    }
    /*
     * **重写一稿是又一整遍 N5**（排结构 + 每一节 + 收口），不是一次小修 —— 加上打回 N0/N4
     * 那两步的话是这条链上最贵的一段。时间凑不出这一整段就停在这里：手上这一稿已经是完整
     * 的报告，只是带着没过的那几条；发一半的重写换来的是一份写到一半的报告。
     *
     * 打回原因照旧写进缺口清单 —— 下面循环出来那一段（`blocking(audit)` 还在）会把没过的
     * 条目原话记上，这里只补一句「本该重写而没重写」，否则读报告的人会以为这几条是重写过
     * 之后仍然不过的。
     */
    const needRewrite =
      (nodes.includes("N0/N5") ? COST.anchor : 0) +
      (nodes.includes("N4") ? COST.reconcile : 0) +
      WRITE_PASS_MS;
    if (!room(h.msLeft, needRewrite)) {
      gaps.push(
        shedNote(
          `N6 出口对账第 ${auditRound} 轮有 ${blocking(audit).length} 条没过（该打回 ${nodes.join("、")}），本该重写一稿`,
          h.msLeft
        )
      );
      break;
    }
    /*
     * 打回的原因**跟着下一稿一起递下去**。这一份要在 `written` 被换掉之前算出来：算晚一步
     * 递过去的就是新那一稿自己的账，而那时下一稿还不知道上一稿哪里没过。
     *
     * 递三栏，各自的理由不一样：
     *
     * - `audit`：出口对账那七项。它们是这一轮打回的**触发者**。
     * - `written.gate.violations`：文字面那几条（裸链接、占位符、跨口径算数）。指不到具体的
     *   块，只能作为一段话讲清楚。
     * - `written.unsentLint`：区块校验里**一次模型都没送到**的那几条 p0（报告级的，比如「引了
     *   台账里没有的编号」）。`stage-write.ts` 那边指不到块就不发返修（没有可改的对象），于是
     *   这几条本来只会把这一轮标成 degraded，谁都不知道它们存在。
     *
     * 区块结构里**指得到块**的那几条（`written.lint` 剩下的部分）不从这里走：它们带着块下标，
     * 由 `stage-write.ts` 里那一次 `spliceRepair` 只重发被指名的块，别的一个字不动。所以这一栏
     * 是「诊断」不是「触发」—— 它不会自己多要一轮，只在已经要重来的那一轮里搭上车。
     */
    const pushback = [...audit, ...written.gate.violations, ...written.unsentLint];
    /*
     * 打回哪一步就重跑哪一步，**顺着链的方向**（N0 → N4 → N5），因为后面那一步读的是
     * 前面那一步的产物。N3 例外：`backTo` 会把 A4-N02 报到它头上，但取证不重跑（§N3），
     * 那条缺口跟着缺陷清单出稿。
     */
    if (nodes.includes("N0/N5")) {
      card = await nodeAnchor(
        `上一稿的落回主体那一节和战略项目没有交集。重划一次行业边界，把权重过线的在建项目写进 industry。`
      );
    }
    if (nodes.includes("N3")) gaps.push("N6 打回 N3，但取证这一步不重跑（同一批命题对同一批检索家只会取回同一批页）");
    if (nodes.includes("N4")) {
      /*
       * 打回的理由要跟进去。`reconcileOnce` 的提示词只由草稿和证据包拼成 —— 两者这一轮都没
       * 变过，所以不递理由的话，重跑那一次发出去的是**和上一次一模一样的字节**，回来的也是
       * 同一份合并稿（模型这边只剩温度上的随机差异）。那次调用是这条链上最贵的一次。
       *
       * 只递路由到 N4 的那几条：N5 的那几条由 `layerOnce(pushback)` 单独讲，把它们也塞进对账
       * 会让 N4 去改自己改不了的东西（版式、附录分层），而它能改的是口径和锚点。
       */
      const toN4 = blocking(audit).filter((v) => NODE_OF_RULE[v.rule] === "N4");
      const note = pushbackNote(toN4);
      merged = await reconcileOnce(draft, note ? [{ role: "user", content: note }] : [], "出口对账打回");
    }
    // 锚点检查跟在 `layerOnce` 里面跑（`gated` 由它换掉），所以这里没有第二句。
    written = await layerOnce(pushback);
    /*
     * 重写这一稿也要换掉留下来的那一份：这一段是这条链上最贵的一遍（整遍 N5），断在它中间
     * 的话，留着上一稿等于把已经花掉的这一遍白扔。
     */
    keep(`N5 分层成稿 · 出口对账打回第 ${auditRound} 轮重写`, "报告正文", written.text, written.report);
    auditRound += 1;
    audit = runAudit();
  }

  /*
   * 措辞那一小组（回避式措辞、空词、`member:` 死链、感叹号、无依据的绝对化）。
   *
   * 它和上面三层门管的是不同的东西：那三层问「结构对不对、引用绑没绑上、研究链断没断」，
   * 一条都不看词面。所以在这一句之前，一份通篇「机会与挑战并存」、把 `member:xxx` 直接写进
   * 正文的报告，在默认这条链上是全绿的 —— 而同一份东西走 `TKOS_DR_V2=0` 那条对照链会被记
   * 五条。同一条规则在两支上一条记一条不记，两边就没法对比了。
   *
   * **放在打回循环外面、而且只出 p1**：措辞改不动一次按块的返修（返修只重发被指名的那几块，
   * 而这几条指不到块），拿它去多要一轮出稿是拿最贵的一次调用换一批改不到点子上的字。
   * 它进的是账，不是闸 —— `degraded` 只看 p0，所以这一句不改变任何一份报告的过与不过。
   */
  const wording = wordingViolations(written.text);
  const violations = [...written.lint, ...written.gate.violations, ...audit, ...wording];
  if (blocking(audit).length) {
    gaps.push(...blocking(audit).map((v) => `N6 出口对账（第 ${auditRound} 轮仍不过）：${fmt(v)}`));
  }
  h.note(
    "出口对账 · 收口",
    {
      跑了几轮: auditRound,
      七项: audit.length ? audit.map(fmt) : "都过",
      区块结构: written.lint.length ? written.lint.map(fmt) : "都过",
      文本面: written.gate.violations.length ? written.gate.violations.map(fmt) : "都过",
      措辞: wording.length ? wording.map(fmt) : "都过",
    },
    "local"
  );

  /*
   * 缺陷清单写进 `doc.sourceText` **文首**（§N6）：第二轮仍不过的那一份照旧上屏，但读它的
   * 人第一眼就该看到这一份哪里没过 —— 藏在末尾等于让他读完整篇之后才发现前面那些话打过折。
   */
  const sourceText = gaps.length
    ? [
        "> 【本轮机检未过的部分】",
        ...gaps.map((g) => `> · ${g}`),
        "> 以下正文照实呈现，上面这几条是它已知的缺口。",
        "",
        written.text,
      ].join("\n")
    : written.text;

  const assembled: ManifestItem[] = [...base];
  if (retrieving) {
    assembled.push(retrievalItem(providerLabel(search), swept.rounds.length, swept.ledger.entries.length));
  }
  assembled.push(...evidenceManifest(swept.ledger));
  /*
   * 核验到底核到哪一档（2026-09-07，ISS-239）。
   *
   * 那一轮的机检写着「31 条已核验」，而逐条查过之后：31 条**原文片段匹配**得上，
   * **0 条**有独立交叉验证。「这段话确实印在那一页上」和「这件事是真的」「这条支持我们的
   * 建议」是三件事，一个 `verified=true` 把三件事说成一件。四挡各说一句，不合成三个字。
   */
  if (written.report.evidence.length) {
    assembled.push({
      label: verificationTally(written.report.evidence, {
        disclosureDomains: card.website ? [card.website] : [],
      }).label,
      kind: "agent" as const,
    });
  }

  const doc: ResearchDoc = {
    issueId: input.issueId,
    ...foldSections(written.report, swept.ledger),
    byAgentLabel: opts?.agentLabel ?? DEFAULT_AGENT_LABEL,
    sourceText,
    sourceLabel: SOURCE_LABEL,
    sourceTabOrder: 0,
    blocks: written.report,
    ledger: swept.ledger.entries,
    assembledFrom: assembled,
  };
  const citationsBound = bindCitations(doc, swept.ledger);

  const degraded = blocking(violations).length > 0;
  const noEvidence = noExternalEvidence({
    providerLabel: providerLabel(search),
    propositions: props.length,
    recorded: swept.ledger.entries.length,
    rounds: swept.rounds,
  });
  if (noEvidence) doc.noExternalEvidence = noEvidence;

  /*
   * 一条维度链一栏。这一版的 `LaneAccount` 说的是「这条链取到了什么」，不是「哪个模型写的」
   * —— 见文件头。`recorded` 按链上那几条命题的入账数分摊；`attempts` 写的是成稿跑了几遍
   * （四条共用同一份报告，所以四栏是同一个数）。
   *
   * 认的是 `propositionId`，和 `sweep.ts` 那张覆盖表**同一套认法**：抽取那一步交回来的
   * 编号不在这一轮的计划里（模型自己编了一个），这条证据就既不进任何一条链的账，也不算进
   * 任何一维的独立组数，但仍然计在顶层的 `recorded` 里。四栏加起来小于顶层，说的就是这件事
   * —— 两处不一致会更难查，所以宁可让这个差额显在账面上。
   */
  const lanes: LaneAccount[] = CHAINS.map((chain, i) => {
    const mine = props.filter((p) => (chain.dims as readonly string[]).includes(p.dimension));
    const ids = new Set(mine.map((p) => p.id));
    return {
      label: chain.label,
      modelAlias: "v2",
      // 这一版没有主源顺位：只有一份报告，`primary` 只剩「排第一栏」的意思。
      primary: i === 0,
      propositions: mine.length,
      rounds: swept.rounds.filter((r) => r.propositionIds.some((id) => ids.has(id))).length,
      recorded: swept.ledger.entries.filter((e) => ids.has(e.propositionId)).length,
      // 拒绝数按同一套 `propositionIds` 认法分摊到这一条：写死 0 会把「这条搜回来一堆、
      // 三道闸全拒了」和「这条压根没搜到东西」印成同一句话。
      rejected: swept.rounds
        .filter((r) => r.propositionIds.some((id) => ids.has(id)))
        .reduce((n, r) => n + r.rejected, 0),
      unresolved: swept.verdicts.filter((v) => !v.ok && ids.has(v.propositionId)).map((v) => v.propositionId),
      attempts: auditRound,
      blocked: i === 0 ? blocking(violations).length : 0,
    };
  });

  const evidencing: A4Evidencing = {
    provider: providerCode(search),
    providerLabel: providerLabel(search),
    hitsByProvider: rollUp(swept.rounds),
    propositions: props.length,
    rounds: swept.rounds,
    recorded: swept.ledger.entries.length,
    rejected: swept.rounds.reduce((n, r) => n + r.rejected, 0),
    unresolved: swept.verdicts.filter((v) => !v.ok).map((v) => v.propositionId),
    calculations: written.gate.calculations,
    citationsBound,
    reportAttempts: auditRound,
    lanes,
    // 这一版的 `lanes` 装的是取证方向，报告只有一份 —— 少了这一栏，调用方那句话会说成
    // 「四条各跑了一整套深研、各自写报告、各自过出口对账」，那是上一版的事。
    lanesAreDimensions: true,
  };

  return {
    doc,
    violations,
    attempts: auditRound,
    degraded,
    /*
     * 这一版**没有反证复核那一遍**：`falsify_card`（什么会推翻这条判断）和
     * `unverified_panel`（查不到的那几条）已经是每一份报告的必交块，另发一次调用去问
     * 「有什么反证」只会拿到同一批话的另一种说法。所以这两个数照实是 0 和 false ——
     * 写成 true 会让运营台以为这一轮做过那一遍。
     */
    challengeCount: 0,
    challenged: false,
    evidencing,
    run: h.finish({
      status: "ok",
      input: input.title,
      output: doc as unknown as Record<string, unknown>,
      violations: violations.map(fmt),
      ...(auditRound > 1 ? { firstRoundViolations } : {}),
      degraded,
      ...(noEvidence ? { noExternalEvidence: noEvidence.headline } : {}),
    }),
  };
}
