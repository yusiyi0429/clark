/**
 * N5 分层成稿：**大纲一次 → 每节各一次 → 收口一次 → 按位置纪律重排 → 装配**。
 *
 * ## 为什么它不在 `layer.ts` 里，也不在 `pipeline.ts` 里
 *
 * `layer.ts` 是**纯规则**：什么进正文、什么进附录（`partition`）、四条位置禁令
 * （`layerGaps`）。它不知道模型、不知道台账、不认识 `Harness`，所以它的单测是「给一批块，
 * 问它切在哪儿」。把三次模型调用搬进去，那份纯度就没了 —— 从此测位置纪律都得先造一个假
 * 模型。
 *
 * `pipeline.ts` 那边的职责是**编排**：N0→N6 的顺序、进度上报、`A4Result` 的兼容。成稿这
 * 一步自己有 165 行、三次调用、一次返修拼接和一次重排，摞在编排函数里的直接后果是它只能
 * 被整条链带着跑 —— 于是「三段全读不出会怎样」这种事只能作为整轮跑的副作用被观察到，而
 * 那正是这一段最需要单独按住的地方。
 *
 * 所以这一段单独一个文件：它是**要模型的节点工作**，介于纯规则和编排之间。
 *
 * ## 草稿和合并稿必须递进来
 *
 * 这一步不是「凭证据写报告」，是「把已经对完账的那份稿子落成块」。`A4ReportInput` 上没有
 * 草稿这一栏（它是四链路那一版的形状，那一版没有草稿），所以合并稿和主体卡按**附加消息**
 * 递（同返修那一次的做法）。不递的话这一版最贵的那条规矩就废了：
 * 「缺证据只降标签（`[P]` → `[P!]`），永不删内容」在 `reconcile.ts` 里守住了，却在写之前
 * 被丢掉 —— 一段没有外部证据的机制段于是只能靠「命题恰好没闭合」被 `buildUnresolved`
 * 捡成一行待核条目，而它本该是正文里带着 `[P!]` 的一整段。
 *
 * 分节那一次只递**这一节对着的那几维**（`assignDims`）：整份递过去等于每一节都看到全部
 * 八维，然后每一节都顺手把别的维度也写一遍。
 *
 * 这份分派**认不出来时往多递那一边错，不往漏一维那一边错**：一节分不出维度就拿还没派出去
 * 的全部（极端情形是大纲折成一节，那一节就拿到八维，正是上一段说要避开的「整份递过去」），
 * 一节写砸了它那几维顺给下一节。多递的代价是那一节可能顺手多写两段，漏一维的代价是 N1 的
 * 先验内容和 N4 判的标签在这一步蒸发 —— 后者违的是「缺证据只降标签，永不删内容」，而这一版
 * 存在的理由就是那一条。
 */

import { parseJson, type Msg } from "@/lib/agent/json";
import type { Harness } from "@/lib/agent/harness";
import { blocking, fmt, type Violation } from "@/lib/agent/rules";
import type { Ledger } from "@/lib/research/ledger";

import type { SubjectCard } from "./anchor";
import type { PlaybookEntry } from "./draft";
import { lintAssembled, mustRewrite, rejectedFrom } from "./blocks/lint";
import { parseBlocks } from "./blocks/parse";
import { assembleReport, blocksToText, spliceRepair, type Assembled } from "./blocks/report";
import { normalizeRef, type Block, type ReportBlocks } from "./blocks/schema";
import {
  assembleStaged,
  crossSectionRepeats,
  keyPointsOf,
  mergeUsage,
  readOutline,
  usageMaterial,
  type OutlineFallback,
  type OutlineSource,
} from "./blocks/stages";
import {
  callBudget,
  CLOSING_RESERVE_MS,
  COST,
  room,
  shedNote,
  type DecisionReadiness,
  type Delivery,
  type DeliveryState,
} from "./deadline";
import { dimName, type DimId, type ScopeQuestionTrace } from "./dims";
import { gateReport, gateScope } from "./gate";
import { layerGaps, LAYER_SYSTEM, partition } from "./layer";
import type { PlannedProposition } from "./plan";
import {
  a4ClosingSystem,
  a4OutlineSystem,
  a4ReportBlocksSystem,
  a4SectionSystem,
  buildA4BlockRepair,
  buildA4ClosingUser,
  buildA4OutlineUser,
  buildA4SectionUserParts,
  buildEvidencePack,
  type A4OutlineSection,
  type A4ReportInput,
} from "./prompt";
import { evidenceSwapGaps, reviewPlaybook, type Merged, type PlaybookReview } from "./reconcile";
import type { Verdict } from "./props";
import { outlineSlot, outsideLedgerIds, writerSlot } from "./shared";

/**
 * 分节出稿：一节一次，理由同 `run.ts` 的 `SECTION_MAX_TOKENS`。
 *
 * ## 这个数不是篇幅闸，别拿它当篇幅闸使
 *
 * 这几次都带着 `jsonlContinue: 1`（`agent/json.ts`）：写满了不抛异常，把已写的那段递回去
 * 接着写一次。所以它是**软的** —— 2026-09-03 那一轮分节实测输出到 20568 token，比这里的
 * 16000 高出四分之一，而没有任何一处报错。
 *
 * 把这个数往下压的效果是**反的**：压到写不完，就多一次续写的往返，墙上时间不降反升。
 * 篇幅要压得去提示词里压（`prompt.ts` 的 `SECTION_BUDGET` / `CLOSING_BUDGET`），
 * 这个数留在「一次写得完」的位置上。
 *
 * 同理，这几次调用上的 `effort` / `verbosity` **在现在这个 `alt` 上是发不出去的**：
 * `claude-opus-5` 的 `acceptsEffort` 和 `acceptsVerbosity` 都是 false（网宿那条口对不认的
 * 字段是 400，见 `registry.ts`），`complete.ts` 那两道闸会把它们滤掉 —— 运行记录里
 * `effortSent: null` 就是这件事。留着是因为换一个认它们的模型时该发，但**不要把它们读成
 * 「这里已经在控篇幅了」**。
 */
const SECTION_MAX_TOKENS = 16000;
const OUTLINE_MAX_TOKENS = SECTION_MAX_TOKENS;
/**
 * **分节那一次的输出额度，2026-09-04 从 16000 压到 8000，且不续写。**
 *
 * 提示词里写着「一节 1500 字上下」，ISS-227 那一轮六节仍各写了 7.5k–10.7k token（3000–4000 字）
 * —— 指令改了、闸没改。先压到 6000 + 一次续写，ISS-228 两头都出了问题：S1 在 6000 上
 * 「额度用完在思考上了」一个字没有，S5 靠续写写到 12000 才被截。所以现在是 8000、不续写：
 * 硬上限就是墙上时间的上限（50 tok/s 上 160 秒），截断按行收尾只丢最后半块；思考把额度吃光的
 * 那种失败交给补写那一波（双倍额度）。收口与返修不用这个数。
 */
/*
 * 2026-09-04 晚：8000 → 12000。ISS-229 第二轮 S1/S3 在 8000 上「额度用完在思考上了」——alt 的思考
 * 计入 max_tokens 且不受控，8000 可以被整个吃掉。12000 留给思考的余地够两轮实测的量，正文仍在
 * 截尾（`onLength: keep`）之下；墙上上限跟着到 240 秒。真要把这一步压回两分钟，换写手
 * （`TKOS_A4_WRITER_SLOT=synth`）比继续调这个数有效。
 */
const SECTION_OUT_TOKENS = 12000;
/**
 * 补写那一波给双倍：ISS-228 的 S1 在 6000 上「额度用完在思考上了」，正文一个字都没有，
 * 而补写按同一个额度再试只会再死一次。第二次要的是把这一节写出来，不是省钱。
 */
const SECTION_RETRY_OUT_TOKENS = SECTION_OUT_TOKENS * 2;
/** 节数上限。提示词说 3 到 5 节；证据入账不超过 2 条时最多 4 节（2026-09-04，原 6）。 */
const MAX_SECTIONS = 5;
const MAX_SECTIONS_THIN_EVIDENCE = 4;

/**
 * 几节同时发几个。**6 就是大纲允许的节数上限**（`prompt.ts` 那条「节数 3 到 6 节」），
 * 也就是「常态下一波发完，不分批」。
 *
 * 上一版是 4（照 `HOOK_CONCURRENCY` 取的）。那个数只在六节那一档上错，而错得很贵：六节
 * 要分两批，一批的墙上时间就是最慢那一节的时间 —— 2026-09-01 实测一节 423 秒，多一批就是
 * 多七分钟，正好是这一轮全部余量的量级。
 *
 * **上界该由「这一步最多能有几节」定，不由「我们敢挂几个」定。** 这几次是 16k 规模的生成，
 * 一口气全撒出去撞的是出口的并发限流，而限流回来的样子是几次调用一起失败 —— 比串行慢得多。
 * 所以这个数要有个理由，而 6 的理由是：大纲交不出第七节，这里也就不会有第七个长请求。同时
 * 挂着六个 400 秒级的请求是这条链上并发的最高水位（返修和收口都是一次一个），再往上就只能
 * 靠猜出口能扛多少了。
 *
 * 模型不守规矩多交了几节的话，下面 `wave` 那个分批循环照旧兜住：多出来的那一批还是一批
 * 一批走，只是那一轮会慢一节的时间。
 */
/* 2026-09-04：节数上限从 6 改成 `MAX_SECTIONS`（5），并发数跟着它走 —— 上面那段的理由不变。 */
const SECTION_CONCURRENCY = MAX_SECTIONS;

/**
 * 暖缓存那一次给多少输出额度。**要的是这一次的输入被服务端存下来，输出一个字都不要。**
 */
const WARM_MAX_TOKENS = 16;

/**
 * 暖缓存那一次，缓存断点**后面**那一段。
 *
 * 断点前面那一段一个字都不能动（缓存键是逐字节比的），后面这一段爱写什么都行 —— 唯一的
 * 要求是**别让这一次真的动笔**：额度只有 `WARM_MAX_TOKENS`，一开写就会被截断，而截断在
 * `callModelJson` 那边是抛异常。那时候缓存其实已经写进去了，却要在缺口清单里记一句
 * 「没暖成」—— 一句假话。给它一件一个字就做得完的事，这一次才会正常收笔。
 */
const WARM_TAIL = "上面那份材料先收着。**这一次不写任何报告内容**，只回一个字：好。";

const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 那一行 `report_meta`。重排时要把它放回第一行 —— `parseBlocks` 的 `sources` 里没有它。 */
export function metaLineOf(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    try {
      const o: unknown = JSON.parse(line);
      if (o && typeof o === "object" && (o as { type?: unknown }).type === "report_meta") return line;
    } catch {
      // 读不出的行归 `parseBlocks` 记账，这里只是在找元数据那一行。
    }
  }
  return "";
}

/**
 * 主体卡 → 一段话。写报告的那几次要它是因为**边界是这一份的前提**：行业定义划到哪儿、
 * 哪笔在建项目权重过线，决定「落回主体」那一节该讲什么。不递的话 A4-N05（落回主体那一节
 * 要和战略项目有交集）只能靠模型自己猜这家公司在建什么。
 */
export function cardBrief(card: SubjectCard): string {
  return [
    /*
     * **2026-09-04：第一行先说这张卡是什么。** 它是 N0 凭模型记忆、在检索之前写的，不是
     * 查回来的。ISS-223 / ISS-226 同一主体相隔 38 分钟写出了互相矛盾的公司事实（6 代模组线 vs
     * 8.6 代线；收入近 100% 单一品类 vs 70/20/10），而分节那几次把它当来源引（正文出现
     * 「[主体卡：维信诺业务构成与在建项目]」、「这一列来自本轮拿到的主体卡口径」）。
     * 卡的用途是划边界（落回主体那一节讲什么），不是供数；数要么有 `[E编号]`，要么写成方向。
     */
    `（这张卡是本轮开始时按模型既有认识写的，未经检索核验。它只用来划研究边界；卡上的构成、` +
      `占比、项目名称一律按「模型既有知识・未核验」对待 —— 不许当来源引用，正文要用就写成方向，` +
      `或标明未核验。）`,
    `主体：${card.subject || "（没识别出主体）"}`,
    `行业定义：${card.industry || "（空）"}`,
    card.segments.length
      ? `业务构成：${card.segments.map((s) => `${s.name}（${s.weight}，${s.lifecycle}）`).join("；")}`
      : "",
    card.projects.length
      ? `在建与战略项目：${card.projects.map((p) => `${p.name}${p.heavy ? "（权重过线）" : ""}`).join("；")}`
      : "",
    card.window ? `时间窗：${card.window}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 合并稿的某几维 → 一段话，**标签原样带着**。
 *
 * 标签是这一段的全部意义：`E*` 可以当实测数写，`P!` 必须显式标成未核，`X` 一个字都不许
 * 进正文。只递正文不递标签，写的人就分不出手上这句话是哪一档。
 */
export function mergedFor(merged: Merged, dims: readonly DimId[]): string {
  const want = new Set(dims);
  const secs = merged.sections.filter((s) => want.has(s.dim));
  if (!secs.length) return "";

  const byDim = new Map<DimId, string[]>();
  for (const c of merged.changes) {
    /*
     * **被推翻（X）和被修正的旧说法不递（2026-09-04）。** 合并稿的 body 已经是改过之后的
     * 版本；把「［X／矛盾］维信诺位列全球第四至第六」这一行再递给分节，模型拿到的就是一段
     * 现成的「我们之前以为……后来被推翻」——ISS-227 里 S2 整节写的就是这个，11%/第三在三节里
     * 各展开一遍。一号位不关心这轮草稿错过什么。只递仍然承重的两类：证实了的（`E*`，
     * 可以按实测数写）和未验证但承重的（`P!`，必须标未核）。
     */
    if (c.to === "X" || c.state === "修正") continue;
    // 变更日志上没有维度这一栏，只能按断言原文回挂到它出现的那一维。挂不上的那几条
    // （断言被改写过）不硬塞进某一维 —— 塞错维度比不递更坏。
    const hit = merged.sections.find((s) => s.body.includes(c.assertion) || s.thesis.includes(c.assertion));
    if (hit) byDim.set(hit.dim, [...(byDim.get(hit.dim) ?? []), `　［${c.to}／${c.state}］${c.assertion}`]);
  }

  return secs
    .map((s) =>
      [
        `## ${s.dim} ${dimName(s.dim)}`,
        `论点：${s.thesis}`,
        `机制：${s.body}`,
        s.tags.length ? `这一维的标签：${s.tags.join("、")}` : "",
        ...(byDim.get(s.dim) ?? []),
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");
}

/**
 * 复核完的候选路线 → 一段话。不是决策题（`status === "不适用"`）就是空串。
 *
 * ## 上一版递的是什么，为什么必须换掉
 *
 * 上一版这个函数收的是 `readonly PlaybookEntry[]` —— **N1 草稿凭模型既有知识写的那份行动
 * 骨架，原样递给出稿的每一次调用**，`StageWriteInput.playbook` 上的注释还专门写着「不经 N4
 * 对账」。ISS-239 那一轮的病灶就在这儿：N4 已经把「采购只为当期成本 KPI 买单」改成「采购
 * 动机未获证实」并补上「经营现金流已改善」，而正文里「首访只谈验收口径、不报价」「四步
 * 顺序不能换」一个字没动 —— 因为模型手上同时有一份语气笃定、写得完整的旧骨架，那是最省力
 * 的一条路。
 *
 * 所以这一版递出去的**只有 N4 更新过的建议**：
 *
 * · 有效建议区：一条一段，带处置、改后的建议、成立条件、对应的事实变化和证据编号；
 * · 历史区：**只有标题，没有正文**，并且明写「不是建议、不许写进行动部分」。
 *   标题还留着是因为不留会更坏 —— 模型会在下一节把同一条路当成没人提过的新点子重新捡起来；
 *   正文不留是因为 ISS-239 证明了只要那段完整的旧论证还在上下文里，它就会被照抄。
 * · 复核没做完时，多一句硬话：这一份不许交出可以直接下达的行动方案。
 */
export function playbookFor(review: PlaybookReview): string {
  if (review.status === "不适用") return "";

  const parts: string[] = [
    "## 行动建议（**已经过 N4 对账**，这一份是本轮唯一有效的建议来源）",
    "这道题要的是一个决策。成稿第一节写「要您定的事」（每件：要定什么、不定的代价、建议、拍错了怎么退），" +
      "行动建议放在正文末节；八个维度只作背景，不单独成节。" +
      "**每一条建议都要连着它的成立条件写** —— 条件不是脚注，是这句建议成立的范围；" +
      "去掉条件写成无条件命令，是这一版明确要修的那个病。",
  ];

  if (review.effective.length) {
    parts.push(
      ...review.effective.map((v) =>
        [
          `### ${v.strategy.id} ${v.advice}`,
          `N4 的处置：${v.update?.kind ?? "保留"}` +
            (v.update?.factChange ? ` —— ${v.update.factChange}` : "") +
            (v.update?.evidenceIds.length ? `（${v.update.evidenceIds.join("、")}）` : ""),
          v.conditions ? `成立条件：${v.conditions}` : "",
          v.update?.why ? `理由：${v.update.why}` : "",
          v.falsified.length
            ? `**已被推翻、不能再承重的前提**：${v.falsified.map((p) => p.premise.text).join("；")}`
            : "",
          v.unverified.length
            ? `**未获验证的承重前提（写成条件，不写成事实）**：${v.unverified
                .map((p) => p.premise.text)
                .join("；")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      )
    );
  } else {
    parts.push(
      "（这一轮没有任何一条候选路线拿到 N4 认可的建议。**不要自己补一个** —— " +
        "写成「还需要弄清什么才能选路」，以及在已有证据下可以低成本先做的澄清动作。）"
    );
  }

  if (review.historical.length) {
    parts.push(
      [
        "## 以下是历史草稿，**不是建议**",
        "N1 凭既有知识写的候选路线，这一轮没有成为有效建议。它们只用来避免重复提出，" +
          "**一律不许出现在行动建议、拟制命令或成功判据里**，正文也不要写「我们之前以为」。",
        ...review.historical.map((x) => `· ${x.id}「${x.claim}」：${x.why}`),
      ].join("\n")
    );
  }

  if (review.status !== "已复核") {
    parts.push(
      `**策略复核${review.status === "未复核" ? "未完成" : "只做了一部分"}。** ` +
        "这一份交的是可用证据与待验证判断，不是可以直接下达的行动方案：" +
        "不要给确定的日期、不要写成命令、不要承诺我方能力边界之外的事；" +
        "把「还需要谁确认什么」写清楚。"
    );
  }

  return parts.join("\n\n");
}

/**
 * 复核完的候选路线 → **毛坯大纲**：排结构那一次没成时拿它顶上（2026-09-07，ISS-240）。
 *
 * ## 为什么兜底要换成这一份
 *
 * `RUN-A4-mtqtenit-2` 那一轮 24 分 20 秒：轮到排结构时只剩 456 秒，把「一节 + 收口 + 两次
 * 锚点检查」的位置留出去之后这一次只分到 46 秒，网宿网关等到 45 秒超时。接着一路塌下去：
 * 大纲没有可用章节 → 折成一节 → 那一节也没时间写 → **正文 1 块、附录 5 块、0/1 节，取回来
 * 的 24 条证据用上 0 条、弃用 0 条、没交代 24 条**。
 *
 * 预算下限那一刀已经在 `deadline.ts` 落过（结构这一步现在有下限），但那**只是让饿死的概率
 * 变小**。这一处修的是兜底本身，理由是失败代价严重不对等：收口被压短只是话少一点，结构
 * 没出来就是一份没有正文的报告 —— **兜底也该按这个不对等来设计**。
 *
 * ## 为什么毛坯是现成的
 *
 * 决策骨架在 N1 就已经交出来了（`draft.playbook`：一条一个 `heading` + `body` + 断言），
 * 排结构这一步本质上是在**精修它**。精修失败就用毛坯 —— 一句判断本来就是一节的标题。
 *
 * ## 为什么用复核后的那一份，不用原始骨架
 *
 * 同 ISS-239 那条：原始骨架是 N1 凭既有知识写的，N4 可能已经把它的承重前提推翻了。递原文
 * 进去等于把这一版最贵的那条规矩（`playbookFor` 上面那段）在兜底这条路上开一个后门 ——
 * 而兜底这条路正是没人盯着的那条。所以这里只认 `review.effective`：拿到 N4 认可建议的那几条。
 *
 * ## 证据怎么分
 *
 * 按 N4 那条策略更新自己引的编号（`update.evidenceIds`）分 —— 那是这一轮里唯一一份「这条
 * 建议靠哪几条证据改过来」的真映射，不是猜的。分不到任何一节的那几条不在这里补：
 * `readOutline` 后面那段 `leftover` 对所有分支一视同仁地把它们补进最后一节并记一账
 * （**一条都不许静默消失**，那正是 ISS-240 里 24 条全部没交代的那一栏）。
 */
export function playbookOutline(o: {
  review: PlaybookReview;
  packIds: readonly string[];
}): OutlineFallback {
  const effective = o.review.effective;
  if (!effective.length) return { sections: [], note: "" };

  /*
   * `update.evidenceIds` 是模型写的那一栏，可能有本轮台账里根本没有的编号（同 `readOutline`
   * 里那条「大纲编不出证据来」）。在这里就滤掉，而不是等下游 —— 递一节它根本拿不到的编号
   * 出去，那一节写出来的是一句「据 E9」，而 E9 不存在。
   */
  const known = new Set(o.packIds);
  const sections: A4OutlineSection[] = effective.map((v, i) => ({
    // 候选路线的 ID 本来就是 `S1`/`S2` 那个形状（`candidatesFromPlaybook`），和大纲的节号同形。
    id: v.strategy.id || `S${i + 1}`,
    // 标题直接用 `heading`：它本来就是一句判断，而一节的小标题要的正是一句判断。
    title: v.strategy.claim,
    /*
     * 这一问由「标题 + 复核后的建议 + 成立条件」推出来。**不写成「介绍一下这条路线」** ——
     * 那是问材料不是问议题，`readOutline` 里折成一节那一支上面那段注释记的就是问错问题的下场。
     */
    question: [
      `「${v.strategy.claim}」这条判断在这一轮的证据下还站得住吗 —— 它靠什么成立、` +
        `什么会推翻它、据此该做的那件事是什么。`,
      `N4 对完账之后的建议：${v.advice ?? ""}`,
      v.conditions ? `成立条件：${v.conditions}（条件是这句建议成立的范围，不是脚注）` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    evidenceIds: [...new Set((v.update?.evidenceIds ?? []).map(normalizeRef).filter((id) => known.has(id)))],
    expectedBlocks: ["prose", "judgment"],
    // 决策题那一档（ISS-238）：一节一个块就答完了它那一问。`readOutline` 那边按 1 收。
    minBlocks: 1,
  }));

  return {
    sections,
    note:
      `排结构那一次没成，已按 N1 的决策骨架分成 ${sections.length} 节` +
      `（N4 复核后的有效建议，一条一节）—— 这一份的章节是骨架毛坯，不是模型排的结构。` +
      (o.review.status === "已复核"
        ? ""
        : `**策略复核${o.review.status === "未复核" ? "未完成" : "只做了一部分"}**：` +
          `这几节的题目来自还没复核完的候选路线，正文不得把它们写成可以直接下达的行动。`),
  };
}

/* -------------------------------------------------------------------------- */
/* 定稿闸（§3.E）                                                               */
/* -------------------------------------------------------------------------- */

export type SinkVerdict = "收下" | "这一节已经有了" | "已定稿，不收";

/**
 * 一节的正文收不收。**只有三种答案，判据全在这里一处。**
 *
 * §3.E 那条「晚到的响应不能覆盖已定稿状态」落在这个函数上。这条链上真正的中止发生在
 * `complete.ts` 的 `AbortSignal.timeout`（预算由 `deadline.ts` 的 `callBudget` 算，经
 * `harness.callMessages` 的 `wallMs` 递下去），所以常态下不会有「后台还在烧、回复晚到」
 * 那种东西 —— 但那是**下面一层的性质**，这一层不该假设它永远成立。装配之前多问一句的
 * 代价是一次 `Set.has`，不问的代价是一份已经排好序、算过 lint、送过锚点检查的报告被一段
 * 晚到的正文改写，而屏幕上看不出任何异常。
 *
 * 「这一节已经有了」是第二道：补写那一波只该补**没写成**的那几节，同一节收两份正文的话，
 * 装配那边会把它当成两节，节数和 `appendixFrom` 一起错位。
 */
export function sinkVerdict(o: { sealed: boolean; have: ReadonlySet<string>; id: string }): SinkVerdict {
  if (o.sealed) return "已定稿，不收";
  if (o.have.has(o.id)) return "这一节已经有了";
  return "收下";
}

/** 合并稿里所有 `P!`（未验证承重）那几条。收口那一次要它 —— 待核清单就是从这里来的。 */
export function loadBearingUnverified(merged: Merged): string[] {
  return merged.changes.filter((c) => c.to === "P!").map((c) => c.assertion);
}

/**
 * 每一节对着合并稿的哪几维。
 *
 * 认法：这一节分到的证据 → 它验的那条命题 → 那条命题的维度。分不出来的那几节（这一节
 * 一条证据都没分到，或者抽取那一步交回的命题号不在计划里）拿**还没派给任何一节**的维度，
 * 最后一节兜走剩下的全部 —— 八维的内容一条都不许在成稿这一步蒸发（§N4「永不删内容」）。
 */
export function assignDims(o: {
  sections: readonly A4OutlineSection[];
  entries: readonly { id: string; propositionId: string }[];
  props: readonly PlannedProposition[];
  dims: readonly DimId[];
}): Map<string, DimId[]> {
  const dimOfProp = new Map(o.props.map((p) => [p.id, p.dimension]));
  const dimOfEvidence = new Map(o.entries.map((e) => [e.id, dimOfProp.get(e.propositionId)]));
  const out = new Map<string, DimId[]>();
  const handed = new Set<DimId>();

  for (const s of o.sections) {
    const mine = new Set<DimId>();
    for (const id of s.evidenceIds) {
      const d = dimOfEvidence.get(id);
      if (d) mine.add(d);
    }
    if (!mine.size) for (const d of o.dims) if (!handed.has(d)) mine.add(d);
    for (const d of mine) handed.add(d);
    out.set(s.id, [...mine]);
  }

  const last = o.sections[o.sections.length - 1];
  if (last) {
    const left = o.dims.filter((d) => !handed.has(d));
    if (left.length) out.set(last.id, [...(out.get(last.id) ?? []), ...left]);
  }
  return out;
}

/**
 * 上一轮出口对账没过的那几条 → 递给下一稿的一段话。
 *
 * 打回不带原因就是让模型重写一份**它不知道哪里错了**的报告（同 `run.ts:1035` 那条注释：
 * 回来的是一份全新的报告，不是改好的那一份）。
 */
export function pushbackNote(violations: readonly Violation[]): string {
  // `blocking` 收的是可变数组（`rules.ts`），复制一份进去 —— 这一栏在调用方那边是只读的。
  const all = [...violations];
  const hard = blocking(all);
  const list = hard.length ? hard : all;
  if (!list.length) return "";
  return [
    "## 上一稿在出口对账上没过这几条",
    ...list.map((v) => `· ${fmt(v)}`),
    "这一稿要正面处理它们，不要换一个说法绕开。",
  ].join("\n");
}

export type StageWriteInput = {
  h: Harness;
  material: A4ReportInput;
  card: SubjectCard;
  merged: Merged;
  /**
   * 草稿里的决策骨架（`draft_playbook`，只有决策题有）。**这一栏是候选，不是建议。**
   *
   * 上一版这里写的是「不经 N4 对账：它写的是我们自己的动作，不是外部事实」。那句话的前半
   * 截是真的（骨架确实写的是我方动作），后半截推错了：我方动作**全部架在外部事实上**，事实
   * 变了动作就得跟着变。ISS-239（`RUN-A4-mtqpegne-4`）把这个推理链的后果摆得很清楚 ——
   * 对账已经把「采购只为当期成本 KPI 买单」改成「未获证实」，最终报告的强命令一条没动。
   *
   * 所以这一栏的语义变了，**类型没变**（`pipeline.ts` 的 `layerOnce` 里那句
   * `playbook: draft.playbook` 原样能用；不写行号是因为那个文件这几天一直在动）：
   * 递进来的是 N1 的候选路线，`writeStaged` 进门第一件事是拿它和 `merged` 过一遍
   * `reviewPlaybook`，之后每一次出稿调用看到的只有**复核过的那一份**。
   * N4 没给策略更新时这里不会退回原骨架 —— 那时递出去的是「策略复核未完成」加历史标题。
   */
  playbook?: readonly PlaybookEntry[];
  props: readonly PlannedProposition[];
  ledger: Ledger;
  verdicts: Verdict[];
  dims: readonly DimId[];
  lane: () => ReportBlocks["lane"];
  /**
   * 这一轮关键问题的账（`sweep.ts` 的 `scopeTrace`）。出口那三条（A4-G07/G08/G09）读它。
   *
   * 不递就是空表 —— 那三条整段不判。**「没递」和「一条问题都没有」在这里是同一件事**：
   * 行业题本来就没有关键问题，而没接线的决策题不该因为接线没做完就被报一堆缺口。
   */
  questions?: readonly ScopeQuestionTrace[];
  /** 上一轮出口对账没过的那几条。第一遍是空的。 */
  pushback?: readonly Violation[];
  /**
   * 摘掉没过相关性检查的内部锚点。**在冻文字之前调用** —— `blocksToText` 会把
   * 「什么内部数据能裁决它」渲染进正文，摘在后面的话原件页签留着的正是被判掉的那几条，
   * 而 `lintAssembled` / `gateReport` 报的也是摘之前那一份的账。
   *
   * 约定：它要把摘完的那一批块**写回 `report.blocks`**（`stripHooks` 保序保长度，所以
   * 块下标和 `sources` 仍然对齐），这一段随后拿它重算 lint / 原文 / gate 三样账。
   */
  stripAnchors?: (report: ReportBlocks) => Promise<{ removed: string[] }>;
};

export type StageWritten = {
  report: ReportBlocks;
  text: string;
  lint: Violation[];
  /**
   * `lint` 里**一次模型都没送到**的那几条 p0。
   *
   * 指得到块的那几条走返修（只重发被指名的块），指不到的（报告级：没有 verdict_banner、
   * 引了台账里没有的编号）没有可返修的对象，下面那一支只记一句就交稿。于是它们既没进过
   * 任何一次调用的上下文、也不在 `pipeline.ts` 递给下一稿的打回原因里 —— 只剩一个
   * `degraded: true`。这一栏就是为了把它们交回编排层，搭上下一轮打回的车。
   */
  unsentLint: Violation[];
  gate: ReturnType<typeof gateReport>;
  /** 这一遍里「不过但往下走了」的原话。调用方把它折进这一轮的缺陷清单。 */
  notes: string[];
  /** 这一遍发了几次出稿调用（返修算第二次）。 */
  attempts: number;
  /**
   * N1 候选路线经 N4 对账之后的那一份（§3.C）。
   *
   * 交回调用方是为了两件事：出口对账要知道「这一份的行动建议有没有经过复核」，以及页面上
   * 「策略复核未完成」这句话要有出处。**不交的话它只活在提示词里** —— 而提示词里的东西
   * 事后一栏都读不到。
   */
  strategyReview: PlaybookReview;
  /**
   * 这一份的章节是谁排的（`model` / `playbook` / `single`）。
   *
   * 交出来是因为「按骨架分的节」和「模型排的结构」在下游是两件事：出口对账要不要按这一份
   * 打回、页面上要不要提醒读的人。**只有 `notes` 里那句中文的话，每一个读它的人都得自己
   * 写一遍正则**（2026-09-07，ISS-240）。
   */
  outlineFrom: OutlineSource;
  /**
   * 交付完整性三态（§3.E）。**「调用结束」不等于「交付完整」，更不等于「可以下达」。**
   * 三栏各自的口径写在 `deadline.ts` 的 `Delivery` 上。
   */
  delivery: Delivery;
};

export async function writeStaged(input: StageWriteInput): Promise<StageWritten> {
  const { h, material, merged, card } = input;
  const notes: string[] = [];
  const entries = input.ledger.entries;
  const packIds = entries.map((e) => e.id);
  const hasEvidence = entries.length > 0;
  const pushback = pushbackNote(input.pushback ?? []);

  /*
   * ---- N4 策略对账（§3.C 的主修点）----
   *
   * **这一句就是「行动骨架必须经过对账」的实现位置。** 上一版这里是
   * `playbookFor(input.playbook ?? [])` —— N1 的草稿骨架直接折成一段话递给出稿的每一次调用。
   * 现在中间隔着 `reviewPlaybook`：候选路线要和 `merged` 里那份 `strategy_update` 对上，
   * 对不上的进历史区、不作有效建议。
   *
   * 放在这里而不是让 `pipeline.ts` 先算好再递进来，是为了**没有第二条路**：这一段是每一次
   * 出稿调用拼上下文的唯一入口（`carry`），复核放在入口里，谁也绕不过去。递一份算好的进来
   * 意味着多一个可以传空、传旧、传错的口子。
   */
  const strategyReview = reviewPlaybook({ playbook: input.playbook ?? [], merged });
  if (strategyReview.gaps.length) notes.push(...strategyReview.gaps.map((x) => `策略对账：${x}`));
  const playbookPart = playbookFor(strategyReview);
  /** 每一次出稿调用都带的那几段：主体卡、决策骨架（决策题才有）、合并稿（分节那次只给这一节的）、打回原因。 */
  const carry = (mergedPart: string): Msg[] => {
    const parts = [
      `## 这一轮锚定的主体（N0 的主体卡）\n\n${cardBrief(card)}`,
      playbookPart,
      mergedPart
        ? `## 已经和证据对完账的稿子（N4 的合并稿）\n\n${mergedPart}\n\n` +
          `标签的用法：\`E*\` 有外部证据、按实测数写；\`P\` 未验证非承重、照常写；` +
          `\`P!\` 未验证但结论依赖它 —— **内容留着，但必须显式标成未核并进待核清单**；` +
          `\`X\` 已被证据推翻，一个字都不许进正文。**缺证据不是删内容的理由，只是降标签的理由。**\n\n` +
          `**只写现在的判断，不写它是怎么改过来的。** 这份合并稿是对完账之后的版本；正文里不许出现` +
          `「我们之前以为」「草稿曾把它放在」「本轮推翻了我方前置认知」这类话 —— 那是研究过程，` +
          `一号位读到的只有结论。一条事实（比如一个排位）全文只在最需要它的那一节展开一次，别的节引一句。`
        : "",
      pushback,
    ].filter(Boolean);
    return parts.length ? [{ role: "user", content: parts.join("\n\n") }] : [];
  };

  /**
   * 这一次调用能等多久（§3.E）。`keep` 是**后面还必须做的那几步**要留的位置。
   *
   * 不限时的那一轮返回 `{}`，调用方整个不带这个键 —— 递一个 `Infinity` 下去读起来像
   * 「永不超时」，而那是错的（下面那一层有自己的天花板）。
   */
  const wallFor = (keep: number, want?: number, floor?: number): { wallMs?: number } => {
    const ms = callBudget(h.msLeft, keep, want, floor);
    return Number.isFinite(ms) ? { wallMs: ms } : {};
  };

  // ---- 大纲 ----
  h.substep("排结构");
  /*
   * 排结构塌了拿什么顶，**在发这一次之前就备好**（2026-09-07，ISS-240）。
   *
   * 它只认 `strategyReview` 和台账编号，跟这一次的成败无关，所以算在前面算在后面产物一样 ——
   * 备在前面是因为下面 catch 里那句话要按「手上有没有毛坯」来说：这一轮到底折成一节还是按
   * 骨架分节，缺陷清单上不能含糊。
   */
  const skeleton = playbookOutline({ review: strategyReview, packIds });
  let raw: unknown = null;
  try {
    raw = parseJson<unknown>(
      (
        await h.callMessages(
          "模型调用 · a4.layer.outline",
          [
            { role: "system", content: `${a4OutlineSystem(hasEvidence, card.inward, card.decision)}\n\n${LAYER_SYSTEM}` },
            { role: "user", content: buildA4OutlineUser(material) },
            ...carry(mergedFor(merged, input.dims)),
          ],
          {
            slot: outlineSlot(),
            maxTokens: OUTLINE_MAX_TOKENS,
            effort: "high",
            /*
             * 排结构之后还有：至少一节 + 收口 + 两次锚点检查。**但它有下限**（`callBudget`
             * 的 `floor`）：跑晚了的那一轮，把这一次压到几十秒的下场是整份报告没有正文
             * （ISS-240 实测 46 秒 → 网关超时 → 0/1 节 → 24 条证据全部作废）。收口缩得动，
             * 结构缩不动。
             */
            ...wallFor(COST.section + CLOSING_RESERVE_MS, undefined, COST.outline),
          },
          { promptKey: "a4.layer.outline" },
          "a4.layer.outline"
        )
      ).text
    );
  } catch (e) {
    notes.push(
      skeleton.sections.length
        ? `排结构那一次没成，按 N1 的决策骨架往下走：${why(e)}`
        : `排结构那一次没成，折成一节往下走：${why(e)}`
    );
  }
  // 决策题一节至少 1 个块（ISS-238）：提示词里那句话要生效，`clampMin` 那道闸得跟着松。
  // `fallback` 只在有毛坯时递（行业题恒为空）—— 递一份空的进去和不递是同一件事，但读的人
  // 会以为这条路上真的有兜底。
  const outlineRead = readOutline(raw, packIds, {
    ...(card.decision ? { minBlocksFloor: 1 } : {}),
    ...(skeleton.sections.length ? { fallback: skeleton } : {}),
  });
  const outline = outlineRead.outline;
  notes.push(...outlineRead.notes);
  /*
   * **节数封顶（2026-09-04）。** 大纲提示词说 3 到 5 节，但 227 那轮在 1 条证据上开了 6 节
   * —— 提示词不是闸。多出来的节并进最后一节保留的那节：它们分到的证据编号跟着并过去，
   * 不丢；标题与问题记进缺口清单，一号位看得到少了什么。证据薄（入账 ≤ 2 条）时上限再
   * 降一档：没有材料的节靠推理写，写四节推理和写六节推理的差别只是字数。
   */
  const cap = packIds.length <= 2 ? MAX_SECTIONS_THIN_EVIDENCE : MAX_SECTIONS;
  if (outline.sections.length > cap) {
    const dropped = outline.sections.slice(cap);
    const keep = outline.sections.slice(0, cap);
    const last = keep[keep.length - 1];
    last.evidenceIds = [...new Set([...last.evidenceIds, ...dropped.flatMap((s) => s.evidenceIds)])];
    // 问题也并过去：只并证据不并问题，那几条证据对最后一节的问题多半不相干，模型只会写弃用理由。
    last.question = [last.question, ...dropped.map((s) => s.question)].filter(Boolean).join("；另答：");
    last.minBlocks = Math.max(last.minBlocks, Math.min(12, Math.ceil(last.evidenceIds.length / 3)));
    outline.sections = keep;
    notes.push(
      `大纲开了 ${cap + dropped.length} 节，超过上限 ${cap}（证据 ${packIds.length} 条），` +
        `并掉了：${dropped.map((s) => `「${s.title}」`).join("、")}；它们的证据并进「${last.title}」`
    );
  }

  // ---- 逐节 ----
  const dimsOf = assignDims({ sections: outline.sections, entries, props: input.props, dims: input.dims });
  const sections: { id: string; text: string }[] = [];
  const parsed: { id: string; title: string; blocks: Block[] }[] = [];
  const declared: { id: string; reason: string }[] = [...outline.unassigned];
  const judgmentLines: string[] = [];
  /*
   * 这一节真的递进去了哪几维（`dimsOf` 那一份是**派**，这一份是**递**）。
   *
   * 差别在于砸掉的那一节：`assignDims` 已经把它那几维记成「派出去了」，所以后面那几节谁都
   * 不会再捡 —— 一次掐断的分节调用会把那几维的先验内容和标签一起吞掉，而 N4 那边刚刚才为
   * 「缺证据只降标签、永不删内容」把它们保下来。
   *
   * 上一版的补法是**顺给下一节**（那时几节是串行的，总有「下一节」）。这一版几节是并发的，
   * 没有下一节可顺 —— 改成**砸了的那一节重来一次**（下面那一波补写）。补法换得更好而不是
   * 更差：顺给下一节只是把那几维的材料多递一份、指望它顺手写两段，重来一次是那一节真的
   * 被写出来。
   */
  const dimsSent = new Map<string, DimId[]>();
  /*
   * **这一步发出去的那个缓存前缀，只在这里拼一次。**
   *
   * 前缀是两段：不随节变化的 system 段，和 `parts.stable`（议题、预研、在版判断、公司
   * 文档）。缓存键是逐字节比的，而它现在有三个调用方 —— 暖缓存那一次、并发那一波、补写
   * 那一波。三处各拼一遍的话，哪天有人往其中一处多加一行，缓存就永远命不中，而这件事
   * **不报错**，唯一看得出来的地方是账单。
   */
  const sectionSystem = `${a4SectionSystem({ hasEvidence, inward: card.inward, decision: card.decision })}\n\n${LAYER_SYSTEM}`;
  const sectionParts = (s: A4OutlineSection, written: string, plan: string) => {
    const ids = new Set(s.evidenceIds);
    return buildA4SectionUserParts({
      ...material,
      // 这一栏是这一次调用的边界：递进去的只有分给这一节的那几条证据。
      evidencePack: buildEvidencePack(entries.filter((e) => ids.has(e.id))),
      section: s,
      thesisDraft: outline.thesisDraft,
      written,
      plan,
    });
  };

  /** 写一节的那一次调用长什么样。 */
  const writeSection = async (s: A4OutlineSection, mine: DimId[], written: string, plan: string, budget = SECTION_OUT_TOKENS) => {
    const parts = sectionParts(s, written, plan);
    return (
      await h.callMessages(
        `模型调用 · a4.layer.section（${s.id}）`,
        [
          { role: "system", content: sectionSystem },
          {
            /*
             * 分两块发是为了**打一个缓存断点**。断点只能打在 `stable` 末尾：后面那一段带着
             * 按节切片的证据包和别的几节要回答什么，每节都不同。打错位置不会报错，只会变成
             * 每节写一份新缓存 —— 比不缓存还贵。
             *
             * 这几次都是**读**：写是上面暖缓存那一次做的（见 `warmUp` 那段注释）。
             */
            role: "user",
            content: [{ text: parts.stable, cache: true }, { text: parts.rest }],
          },
          ...carry(mergedFor(merged, mine)),
        ],
        {
          slot: writerSlot(),
          maxTokens: budget,
          json: false,
          effort: "medium",
          verbosity: "high",
          /*
           * 2026-09-04：分节不再续写。续写让额度变成软的（ISS-228 的 S5 写到 12000 才被截），
           * 而这一步要的正是硬的墙上时间：8000 token 在 50 tok/s 上是 160 秒。
           * **截断要留整行，不能抛**（`onLength: "keep"`）：ISS-229 四节全在 8000 上被截，而不续写
           * 时 `callModelJson` 默认把截断当异常，四节全丢、正文 0 块 —— 这一处是那一轮的直接死因。
           */
          jsonlContinue: 0,
          onLength: "keep",
          /*
           * **一节最多等到「剩余时间减去收口保留」为止**（§3.E）。
           *
           * 上一版这一次拿的是整轮剩下的全部时间（`harness` 递 `timeoutMs: this.msLeft`）——
           * 于是 ISS-239 那一轮 S1/S2 各等满 420 秒，等回来收口已经没有位置了，报告里那份
           * 「摘要」是收口在残余预算上补出来的东西，不是核心论证。
           *
           * **不拿 `COST.section` 去封顶**：那是一个估值（250 秒），拿估值掐一次真在写的
           * 生成，砍掉的是正文；而估值漂了的表现是「总在同一个地方收口」，不是报错。
           * 这里只守那条硬的：不许吃掉收口的位置。
           */
          ...wallFor(CLOSING_RESERVE_MS),
        },
        { promptKey: "a4.layer.section", section: s.id },
        "a4.layer.section"
      )
    ).text.trim();
  };

  /*
   * ---- 定稿闸（§3.E）----
   * 一旦置真，任何一节的正文都不再收 —— 判据和理由在 `sinkVerdict` 上面那段。
   */
  let sealed = false;
  const have = new Set<string>();

  /**
   * 一节写完之后要落的那几笔。**顺序无关** —— 并发那一波回来之后按大纲顺序补进去。
   *
   * 收不收先问 `sinkVerdict`。不收的那两种各记一句：不记的话「这一节没写成」和「这一节写了
   * 但到得太晚」在缺口清单里长得一模一样，而两者该查的东西完全不同。
   */
  const takeSection = (s: A4OutlineSection, body: string) => {
    const verdict = sinkVerdict({ sealed, have, id: s.id });
    if (verdict !== "收下") {
      notes.push(`${s.id}「${s.title}」那一节的正文${verdict}，这一稿不并它进去`);
      return null;
    }
    have.add(s.id);
    sections.push({ id: s.id, text: body });
    const p = parseBlocks(body, { complete: true });
    parsed.push({ id: s.id, title: s.title, blocks: p.blocks });
    p.blocks.forEach((b, at) => {
      if (b.type === "judgment") judgmentLines.push(p.sources[at]);
      if (b.type === "evidence_usage") declared.push(...b.discarded);
    });
    return p;
  };

  const dimsFor = (s: A4OutlineSection): DimId[] => {
    const mine = [...new Set(dimsOf.get(s.id) ?? [])];
    dimsSent.set(s.id, mine);
    return mine;
  };

  /*
   * 还写得下吗？留的是**收口那一次**（`COST.closing`）加两次锚点检查：核心判断横幅和最终
   * 判断都在收口手上，一份没有横幅的报告在出口对账上是 p0，屏幕上则是一份看着写完了、
   * 就是没有结论的报告。所以时间紧的时候少写一节、把收口留住，不是反过来。
   *
   * **要的是一节，不是几节**：一波里那几节是同时发出去的，墙上时间是最慢那一节的时间，
   * 不是它们的和。暖缓存那一次也不占这里的位置（它自己在 `warmUp` 里问一次），否则一次
   * 几秒钟的调用会被当成一整节来记 —— 那正好是「时间紧的时候把它砍掉」的反面：越紧越
   * 该暖，暖不上的那一波每一节都要全价重算一遍那八万 token 的材料。
   */
  const roomForSections = () => room(h.msLeft, COST.section, COST.closing + 2 * COST.anchorGate);

  /** 没写成的那几节记一句 —— §N4 的「缺证据只降标签、永不删内容」在这里只能靠这句话交代。 */
  const shed = (left: readonly A4OutlineSection[], why: string) => {
    if (!left.length) return;
    const lostDims = [...new Set(left.flatMap((x) => dimsOf.get(x.id) ?? []))];
    notes.push(
      shedNote(
        `还剩 ${left.length} 节没写（${left.map((x) => `${x.id}「${x.title}」`).join("、")}），` +
          `${lostDims.join("、") || "无"} 这几维这一遍没人接下，${why}`,
        h.msLeft
      )
    );
  };

  /*
   * **别的几节各自要回答什么。** 这一份取代了上一版那条「已写要点会一节一节往后滚」的链子。
   *
   * 上一版每一节都能读到前面几节真的写了什么，代价是几节只能串行 —— 而 2026-09-01 实测一节
   * 要 423 秒，四节串起来就是 28 分钟，比整轮的上限还长。这一份从大纲里来，**开跑之前就全
   * 知道**，所以并发写也拿得到：它答的是「哪些话轮不到我说」，而防重复要的正是这一句。
   *
   * 差别是有的：它说的是别人**打算**写什么，不是别人**已经**写了什么，所以拦不住两节在同
   * 一个数上撞车。那一头交给写完之后的 `crossSectionRepeats`（它按数字性事实逐节比对），
   * 报出来进缺口清单。
   */
  const planOf = (self: string): string =>
    outline.sections
      .filter((x) => x.id !== self)
      .map((x) => `· ${x.id}「${x.title}」要回答：${x.question}`)
      .join("\n");

  /*
   * ---- 暖缓存 ----
   *
   * 一次几秒钟的极小调用，只为把那段前缀写进服务端的提示缓存，然后**所有节一波并发**去读它。
   * 缓存和并发两样都拿到，而不是拿七分钟去换缓存。
   *
   * ## 上一版拿七分钟买的是一个不存在的东西
   *
   * 上一版是「第一节单独串行跑，把缓存写进去，其余几节并发读」。2026-09-01 那两轮真运行
   * （ISS-225）把它的两个前提一起否掉了：
   *
   * 1. **换网宿之后一个断点都没发过。**（三态实验在 `complete.ts` 那个 `takesCacheBreakpoints`
   *    上面：带断点第一次是写、第二次是读，不带断点恒为 0 —— 这条口没有自动前缀缓存。）
   *    也就是说那个缓存一直是空的，第一节串行跑的 423 秒是白付的。
   * 2. **就算断点补上，缓存只活五分钟，而一节要跑七分钟。**（实测 423.4 秒；`cache_control`
   *    里递 `ttl:"1h"` 不报错，但回来仍是 `ephemeral_5m_input_tokens`。）等第一节写完，它
   *    自己写进去的那份缓存已经过期了 —— **这个设计在网宿这一档时延下先天不成立**，不是
   *    调参能救的。
   *
   * ## 五分钟这个期限，谁在窗口里谁不在
   *
   * 暖缓存那一次发的必须是**同一段前缀**（同一个 `sectionSystem` + 同一份 `parts.stable`，
   * 逐字节相同，缓存键才对得上），额度给到最小，断点后面那一段只叫它回一个字。
   *
   * 各节**是同时发出去的**，暖完到发出之间只隔着本地几毫秒的拼装 —— 全部落在五分钟窗口内。
   * **补写那一波不在窗口内**：它要等前一波那 400 秒级的生成回来，多半已经过期，那几次按全价
   * 重算一遍。这是认了的：补写本来就是砸了才有的一波，为它再暖一次是拿一次调用去赌一次不一定
   * 发生的重试。
   *
   * 暖不成不是故障：这一步是优化不是必需，失败就退回「各节各自全价算一遍」照旧往下走，只在
   * 缺口清单里留一句 —— 不留的话，账单上多出来的那笔钱没有任何一处解释得了。
   */
  const warmUp = async (s: A4OutlineSection) => {
    /*
     * **开关（2026-09-07，§3.E）。** 这一步是优化不是必需，而「缓存预热不得成为主链的长时间
     * 阻塞项」这条要能被实测验证 —— 关掉它跑一轮、对着开着的那一轮比缓存命中、成本和耗时，
     * 才知道它到底省不省。**这里不宣称它一定省钱**：换出口之后它上一版的两个前提都塌过一次
     * （见上面那段），这一版同样只有实测说了算。
     *
     * 默认仍然是开的：关它的理由要来自那一轮对照，不是来自这一次改动。
     */
    if ((process.env.TKOS_A4_WARM_CACHE ?? "").trim() === "0") {
      notes.push("暖提示缓存那一次按开关关掉了（TKOS_A4_WARM_CACHE=0），各节按全价各算一遍那段材料");
      return;
    }
    /*
     * 它自己问一次时间：要的是自己那几秒，留的是**后面那一节加收口**。
     *
     * 少了这一问的后果不是超时，是**把一节挤掉**：紧到只够一节的时候先发这一次，那一节就
     * 可能发不出去了 —— 拿一节的正文去换一次它自己也来不及用上的缓存。
     */
    if (!room(h.msLeft, COST.warm, COST.section + CLOSING_RESERVE_MS)) {
      notes.push(shedNote("暖提示缓存那一次没发，各节这一遍按全价各算一遍那段材料", h.msLeft));
      return;
    }
    // 只取 `.stable`，所以 `written` / `plan` 这两栏递什么都不影响这一次发出去的前缀。
    const { stable } = sectionParts(s, "", "");
    try {
      await h.callMessages(
        "模型调用 · a4.layer.warm",
        [
          { role: "system", content: sectionSystem },
          { role: "user", content: [{ text: stable, cache: true }, { text: WARM_TAIL }] },
        ],
        {
          slot: writerSlot(),
          maxTokens: WARM_MAX_TOKENS,
          json: false,
          /*
           * **这一次必须封顶**（§3.E：预热不得成为主链的长时间阻塞项）。它和分节那几次
           * 相反：分节不封顶是因为掐掉的是正文，而这一次的产物只有一个「好」字 —— 等它超过
           * 自己那一档估值没有任何收益，只有把后面那一节等掉的风险。实测同一段前缀 5.5s /
           * 6.7s，`COST.warm` 是 20 秒（那是 `CALL_FLOOR_MS` 的下限，不是估高）。
           */
          ...wallFor(COST.section + CLOSING_RESERVE_MS, COST.warm),
        },
        { promptKey: "a4.layer.warm" },
        "a4.layer.warm"
      );
    } catch (e) {
      notes.push(
        `暖提示缓存那一次没发成，下面各节这一遍按全价各算一遍那段材料（只多花钱，不少写字）：${why(e)}`
      );
    }
  };

  let written = "";
  const failed: A4OutlineSection[] = [];

  /**
   * 一波并发：写这几节，回来的按「成了 / 砸了」分开。**一节砸了不牵连同波的别节。**
   *
   * `retryable` 是「砸了的这几节下面还会再试一次吗」—— 只影响那句话怎么说。没写成这件事
   * 记两遍和记一遍在缺口清单里读起来完全不同：一句「没写成」后面跟不跟「还会再试」，决定
   * 读的人要不要现在就去看这一维缺了什么。
   */
  const wave = async (batch: readonly A4OutlineSection[], label: string, retryable: boolean, budget = SECTION_OUT_TOKENS) => {
    for (let at = 0; at < batch.length; at += SECTION_CONCURRENCY) {
      const slice = batch.slice(at, at + SECTION_CONCURRENCY);
      if (!roomForSections()) {
        shed(batch.slice(at), "直接收口");
        return;
      }
      h.substep(`${label} ${slice.map((x) => x.title).join("、")}`);
      const done = await Promise.all(
        slice.map(async (s) => {
          try {
            return { s, body: await writeSection(s, dimsFor(s), written, planOf(s.id), budget) };
          } catch (e) {
            return { s, body: "", why: why(e) };
          }
        })
      );
      for (const r of done) {
        if (r.body) takeSection(r.s, r.body);
        else failed.push(r.s);
      }
      const bad = done.filter((r) => !r.body);
      const again = retryable ? "，下面补写那一波再试一次" : "";
      for (const r of bad) {
        notes.push(
          r.why
            ? `${r.s.id}「${r.s.title}」那一节没写成${again}：${r.why}`
            : `${r.s.id}「${r.s.title}」那一节回来是空的（额度可能全花在推理上了）${again}。`
        );
      }
    }
  };

  if (!roomForSections()) {
    shed(outline.sections, "直接收口");
  } else {
    // 前缀和节号无关，拿哪一节去暖都一样 —— 取第一节只是因为它一定在。
    const first = outline.sections[0];
    if (first) await warmUp(first);
    await wave(outline.sections, `并发写 ${outline.sections.length} 节 ·`, true);
  }

  /*
   * ---- 补写砸掉的那几节 ----
   *
   * 这一波是上一版「维度顺给下一节」的替代品，而且换得更结实：顺给下一节只是把那几维的
   * 材料多递一份、指望它顺手写两段，重来一次是那一节**真的被写出来**。
   *
   * 只补一次。同一节连着两次砸在同一处，第三次拿回来的多半还是同样的结果，而这一轮剩下的
   * 时间要留给收口 —— 一份少一节的报告读得下去，一份没有结论的报告读不下去。
   *
   * 这一波拿得到**上一波真写出来的要点**（上一波是同时发的，那时候谁都还没写完，`written`
   * 只能是空的）。补写的那一节因此比它的同伴多知道一件事：别人已经说过什么，不用再展开。
   */
  /** 计划几节、真写成几节。交付完整性那三态里的 ② 读的就是这两个数。 */
  const planned = outline.sections.length;
  /*
   * **补写只有这一波，没有第二波**（§3.E：失败后最多一次定点补写）。这一段没有循环 ——
   * `failed` 在进补写之前被清空、补写用的是 `retryable: false` 的那一支，所以补写里再砸掉的
   * 那几节只会走 `shed` 记一句，不会再排一波。改成循环的话，一节稳定砸在同一处就是无限
   * 重试，而这一轮的时间要留给收口。
   */
  if (failed.length) {
    const retry = [...failed];
    failed.length = 0;
    written = parsed.map((x) => keyPointsOf({ id: x.id, title: x.title }, x.blocks)).join("\n\n");
    if (roomForSections()) {
      await wave(retry, `补写没成的 ${retry.length} 节 ·`, false, SECTION_RETRY_OUT_TOKENS);
    } else {
      shed(retry, "时间只够收口了，不再补写");
    }
    if (failed.length) shed(failed, "补写那一次也没成");
  }

  /*
   * ---- 定稿 ----
   * 正文这一段到此为止。往后再有任何一节的回复到达，`takeSection` 都不收（`sinkVerdict`）：
   * 下面紧接着就是排序、收口、lint、返修和摘锚点，它们各自算的账都是**这一批节**的账，
   * 中途插进来一节等于那几本账全部作废，而屏幕上看不出来。
   */
  sealed = true;

  /*
   * **按大纲顺序排回去。** 两波回来的顺序是谁先写完谁在前，而报告的章节顺序是大纲定的 ——
   * 不排的话读者拿到的是一份按响应速度排序的报告，而那件事在屏幕上看不出是 bug。
   */
  const order = new Map(outline.sections.map((x, at) => [x.id, at]));
  const at = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  sections.sort((x, y) => at(x.id) - at(y.id));
  parsed.sort((x, y) => at(x.id) - at(y.id));
  // 收口读的是全部要点，所以这里按大纲顺序重算一遍（上面那一份是给补写那一波用的，排的是
  // 写完的先后）。
  written = parsed.map((x) => keyPointsOf({ id: x.id, title: x.title }, x.blocks)).join("\n\n");

  // ---- 收口 ----
  h.substep("收口");
  const account = mergeUsage({ packIds, blocks: parsed.flatMap((x) => x.blocks), declared });
  const unverified = loadBearingUnverified(merged);
  let closing = "";
  try {
    closing = (
      await h.callMessages(
        "模型调用 · a4.layer.closing",
        [
          { role: "system", content: `${a4ClosingSystem(hasEvidence, card.inward, card.decision)}\n\n${LAYER_SYSTEM}` },
          {
            role: "user",
            content: buildA4ClosingUser({
              ...material,
              thesisDraft: outline.thesisDraft,
              written,
              sectionJudgments: judgmentLines.join("\n"),
              usage: usageMaterial(account),
            }),
          },
          ...carry(
            [
              `总判断（对完账的那一版）：${merged.thesis || "（合并稿没给总判断）"}`,
              unverified.length
                ? `未验证但承重（\`P!\`），**待核清单必须逐条收下**：\n${unverified.map((x) => `· ${x}`).join("\n")}`
                : "",
            ]
              .filter(Boolean)
              .join("\n\n")
          ),
        ],
        /*
         * **2026-09-04：收口从 `alt` 换到 `synth`。**
         *
         * 收口是综合与校准，不是写正文：它读的是各节要点和判断块，交七个短块。ISS-223 那一轮
         * 收口在网宿 claude-opus-5 上失败 —— 这条出口首包实测约 80 秒
         * （`.workbuddy/memory/2026-09-01.md`），而走到收口时剩余时间已把超时压到 60 秒，
         * 于是整份报告没有标题、横幅和最终判断。gpt-5.6 在同一出口首包 1.8 秒，且 ISS-226
         * 那次收口 153 秒里正文只有 4.6k token。这一步要的是**一定发得出去**，不是文笔。
         * 换家族的副作用是正面的：定标题、判置信档的那一位不再是刚写完各节的那一位。
         */
        {
          slot: "synth",
          maxTokens: SECTION_MAX_TOKENS,
          json: false,
          effort: "high",
          verbosity: "high",
          jsonlContinue: 1,
          // 收口之后还有两次锚点检查。留的只有那两次 —— 这一次本身就是被别人让出来的那一段。
          ...wallFor(2 * COST.anchorGate),
        },
        { promptKey: "a4.layer.closing" },
        "a4.layer.closing"
      )
    ).text.trim();
  } catch (e) {
    notes.push(`收口那一次没跑成，这一份少了横幅和最终判断：${why(e)}`);
  }

  const asmStaged = assembleStaged({ outline, sections, closing, packIds });
  notes.push(...asmStaged.notes, ...crossSectionRepeats(parsed));

  /*
   * ---- 分层重排 ----
   * `partition` 按块的类型切正文和附录，**保序、返回同一批引用**，所以能拿它到原文行上去
   * 索引。重排完再走 `assembleReport`：`appendixFrom` 是一个下标，它必须对着落库那一份
   * `blocks` 数组算，而不是对着重排之前那一份。
   *
   * 返修那一轮也走这同一支（幂等：块的类型没变，重排就是原序），所以返修拼回来的那几行
   * 不会把正文和附录的边界搞错。
   */
  const assembleOrdered = (
    text: string
  ): { asm: Assembled; jsonl: string; bodyCount: number; appendixCount: number } => {
    const flat = parseBlocks(text, { complete: true });
    const { body, appendix } = partition(flat.blocks);
    const lineOf = (b: Block): string => flat.sources[flat.blocks.indexOf(b)] ?? "";
    /*
     * 决断包那一行要**显式带过来**（2026-09-07，ISS-238）。它不是块，所以不在 `flat.blocks`
     * 里，也就不会被下面这一串重排捡到 —— 不写这一句的话，决策题收口交的那一屏在重排这一步
     * 就没了，而 `assembleReport` 之后没有任何一处看得出少了它。位置跟 `report_meta` 一样在
     * 最前面：它是报告之上的一层，不占正文的位置。
     */
    const staged = [metaLineOf(text), flat.commandBriefLine, ...body.map(lineOf), ...appendix.map(lineOf)]
      .filter(Boolean)
      .join("\n");
    const asm = assembleReport({
      text: staged,
      entries,
      lane: input.lane(),
      complete: true,
      // 「材料截至」那一行由台账定，不由模型写（`disclosureCutoff`）。官网也算一手披露。
      disclosureDomains: card.website ? [card.website] : [],
    });
    // 附录从这里开始。`ReportBlocks.appendixFrom` 到这一版才有写的人 —— 缺这一栏时
    // `auditExit` 那条「校验机械铺在正文里」永远查不出东西（它循环到 0 就结束了）。
    asm.report.appendixFrom = body.length;
    // `jsonl` 是重排之后的那份原文。返修那一次要把它当上一稿递回去（同 `run.ts:1044`
    // 递的是 `text`）—— `Assembled` 上没有这一栏，它只留每个块各自那一行。
    return { asm, jsonl: staged, bodyCount: body.length, appendixCount: appendix.length };
  };

  let ordered = assembleOrdered(asmStaged.text);
  // 装配时折掉的重复数（同一个数既在卡上又在表里，ISS-238）。折了不说的话，一号位会问
  // 「我记得有一张 XX 卡」而没人答得出它去哪了。返修之后重算一遍，取最后那一稿的账。
  let dedup = ordered.asm.dedup;
  let lint = lintAssembled(ordered.asm);
  let attempts = 1;
  let unsentLint: Violation[] = [];

  /*
   * ---- 块级返修 ----
   * 照 `run.ts:1035-1045`：只重发**被指名的那几块**，别的一个字不动。整份重写的代价写在
   * 那边的注释里 —— 让模型对着一份说不清改哪里的要求重写，回来的是一份全新的报告。
   *
   * 一条 p0 都指不到具体块、也不是元数据缺失时**不发**（比如「引了台账里没有的编号」这类
   * 报告级的）：那一次返修没有可改的对象，模型只能凭那句原因重编一遍。
   */
  if (mustRewrite(lint)) {
    const { rejected, general, needsMeta } = rejectedFrom(lint, ordered.asm.blocks, ordered.asm.sources);
    if (!room(h.msLeft, COST.section, 2 * COST.anchorGate)) {
      // 返修是一次和分节同量级的调用。发不起就交这一稿，这几条进 `unsentLint`、落进缺陷清单
      // —— 和下面那条「指不到具体块」走同一个出口，理由也一样：只记一句没人会去改。
      unsentLint = blocking(lint);
      notes.push(
        shedNote(`出口校验有 ${unsentLint.length} 条 p0 该返修，这一次没发`, h.msLeft) +
          "，这几条进缺陷清单"
      );
    } else if (rejected.length || needsMeta) {
      h.substep(`按出口校验返修 ${rejected.length} 块`);
      try {
        const reply = (
          await h.callMessages(
            "模型调用 · a4.layer.repair",
            [
              { role: "system", content: `${a4ReportBlocksSystem(hasEvidence, card.inward)}\n\n${LAYER_SYSTEM}` },
              { role: "assistant", content: ordered.jsonl },
              { role: "user", content: buildA4BlockRepair(rejected, general || undefined, needsMeta) },
            ],
            {
              slot: writerSlot(),
              maxTokens: SECTION_MAX_TOKENS,
              json: false,
              jsonlContinue: 1,
              // 返修之后只剩两次锚点检查。
              ...wallFor(2 * COST.anchorGate),
            },
            { promptKey: "a4.layer.repair", repairOf: blocking(lint).map(fmt).join("；") },
            "a4.layer.repair"
          )
        ).text.trim();
        if (reply) {
          const spliced = spliceRepair({ previous: ordered.asm, rejected, needsMeta, reply });
          ordered = assembleOrdered(spliced.text);
          dedup = ordered.asm.dedup;
          lint = lintAssembled(ordered.asm);
          attempts = 2;
          if (spliced.notes.length) notes.push(...spliced.notes.map((x) => `返修对不上：${x}`));
        } else {
          notes.push("返修那一次回来是空的，留上一稿。");
        }
      } catch (e) {
        notes.push(`返修那一次没跑成，留上一稿：${why(e)}`);
      }
    } else {
      /*
       * 这一支上这几条 p0 **一次模型都没送到**。只记一句就交稿的话，它们的全部去处是把这一轮
       * 标成 degraded —— 谁也不会去改。所以交回调用方（`unsentLint`），由它并进下一轮打回的
       * 原因里：那是一段诊断，不是一次触发，所以不多要一轮，只在已经要重来的那一轮里搭车。
       */
      unsentLint = blocking(lint);
      notes.push(
        `出口校验有 ${unsentLint.length} 条 p0，但一条都指不到具体的块（${unsentLint
          .map((v) => v.rule)
          .join("、")}），没有可返修的对象，这一稿照原样交，这几条进缺陷清单。`
      );
    }
  }

  /*
   * ---- 摘锚点 ----
   * 排在冻文字之前。顺序是硬的：**先摘、再重算 lint、再转写、再算 gate**。
   *
   * 摘在后面的代价是同一份报告在两个视图里各说一套：`blocksToText` 会把「什么内部数据能
   * 裁决它」渲染进正文（`report.ts:276`），于是原件页签留着的正是 `synth` 已经判掉的那几条
   * 锚点，而落库的块里它们已经没了 —— 加锚点检查就是为了拦这种上下文污染，摘完不重算等于
   * 它在两个视图里的一个仍然污染着。lint 同理：`A4-B04`（内部文档只许出现在两处）算的是
   * 摘之前那一份的账。
   *
   * 重算只换 `blocks` 这一栏：`stripHooks` 保序保长度且只删不增，所以块下标和 `sources`
   * 仍然对齐，而 lint 只可能变少不可能变多（它删的是内容）。返修那一轮不受影响 —— 摘锚点
   * 在返修之后，摘完不再发第二次调用。
   */
  let removedHooks: string[] = [];
  if (input.stripAnchors) {
    removedHooks = (await input.stripAnchors(ordered.asm.report)).removed;
    ordered.asm.blocks = ordered.asm.report.blocks;
    lint = lintAssembled(ordered.asm);
    // 摘完还在的那几条才往下递。摘掉内容只可能让 lint 变少，被摘掉的那条要是已经不报了，
    // 拿它去当下一稿的打回原因就是让模型去改一个这一稿里已经没有的问题。
    unsentLint = unsentLint.filter((v) => lint.some((x) => x.rule === v.rule && x.message === v.message));
  }

  const text = blocksToText(ordered.asm.report);
  const gateOut = gateReport(text, input.ledger, input.verdicts, outsideLedgerIds(ordered.asm.report));
  /*
   * 关键问题那三条（A4-G07/G08/G09）并进同一份清单（2026-09-07，ISS-239）。
   *
   * **不并的话 A4-G07 那条 p0 不会触发重写** —— 它拦的正是「没搜过却写成外界没有」，而那句话
   * 一旦印出去，读的人没有任何办法看出它是编的。这一条和别的出口违规走同一条返修路，所以
   * 并在这里而不是另起一份账。
   */
  const gate = {
    ...gateOut,
    violations: [...gateOut.violations, ...gateScope(text, input.questions ?? [])],
  };
  const layerMiss = layerGaps(ordered.asm.report);

  /*
   * ---- 证据替换的闭环（§3.C 最后一条）----
   * 「E11 说被 E12 替代，而 E12 又在没交代那一列」这种自相矛盾的账本要能被检出来。
   * 摆在这里是因为 `account` 是返修之前算的那一份，而这一条问的是**账本自身一不一致**，
   * 跟返修改了哪几块无关。
   */
  const swapMiss = evidenceSwapGaps({
    discarded: account.block.discarded,
    used: account.block.used,
    uncovered: account.uncovered,
  });
  notes.push(...swapMiss);

  /*
   * ---- 交付完整性三态（§3.E）----
   *
   * **「调用结束」在这一行永远为真** —— 走到这里就说明这一遍的调用都跑完了（或者按预算
   * 停了）。它单独占一栏正是因为它**什么都不证明**：ISS-239 那份 `status=ok` 的报告，三节
   * 只成一节。
   *
   * 完整性只看两件事：**核心论证的节数**和**收口交没交**。不看字数、不看块数、不看置信度。
   * 收口补出来的那段摘要在这里不加分 —— 它记在 `closing` 那一栏，和 `coreSections` 分开摆。
   */
  const deliveryWhy: string[] = [];
  const wroteAll = planned > 0 && sections.length >= planned;
  let completeness: DeliveryState;
  if (!sections.length) {
    completeness = "失败";
    deliveryWhy.push("一节正文都没写成");
  } else if (wroteAll && closing) {
    completeness = "完整";
  } else {
    completeness = "部分";
    if (!wroteAll) {
      deliveryWhy.push(
        `核心论证 ${planned} 节只写成 ${sections.length} 节` +
          (closing ? "；收口补了摘要，那不等于缺的那几节的论证被补上了" : "")
      );
    }
    if (!closing) deliveryWhy.push("收口那一次没跑成：这一份没有核心判断横幅和最终判断");
  }

  /*
   * 「拿它能干什么」是另一根轴。**不由完整性直接推出来**：一份三节全写完的报告，只要行动
   * 建议没有过 N4 复核，它照样只是可供讨论的东西（§3.C）；反过来，一份缺一节的报告仍然
   * 读得下去、讨论得起来。
   */
  const blockingLint = unsentLint.length > 0;
  let readiness: DecisionReadiness;
  if (!ordered.asm.report.blocks.length) {
    readiness = "不足以讨论";
    deliveryWhy.push("落库的块是空的，没有可读的正文");
  } else if (completeness === "完整" && strategyReview.status !== "未复核" && !blockingLint) {
    readiness = strategyReview.status === "部分复核" ? "可供讨论" : "具备决策条件";
    if (readiness === "可供讨论") deliveryWhy.push("策略复核只做了一部分，行动建议还不能直接下达");
  } else {
    readiness = "可供讨论";
    if (strategyReview.status === "未复核") {
      deliveryWhy.push("候选路线一条都没经过 N4 复核，这一份不含可下达的行动建议");
    }
    if (blockingLint) deliveryWhy.push(`出口校验还有 ${unsentLint.length} 条 p0 没送到模型`);
  }

  const delivery: Delivery = {
    callsFinished: true,
    completeness,
    readiness,
    coreSections: { written: sections.length, planned },
    closing: Boolean(closing),
    why: deliveryWhy,
  };

  h.note(
    "分层成稿",
    {
      节数: `${sections.length}/${outline.sections.length}`,
      各节: parsed.map((x) => `${x.id} ${x.title}（${x.blocks.length} 块）· 对着 ${(dimsSent.get(x.id) ?? []).join("、") || "（分不出维度）"}`),
      正文与附录: `正文 ${ordered.bodyCount} 块 · 附录 ${ordered.appendixCount} 块（appendixFrom=${ordered.asm.report.appendixFrom}）`,
      证据利用率: `取回 ${packIds.length} 条 · 用上 ${account.block.used.length} 条 · 弃用 ${account.block.discarded.length} 条 · 没交代 ${account.uncovered.length} 条`,
      收口: closing ? "交了" : "没跑成",
      决断包: card.decision
        ? ordered.asm.report.commandBrief
          ? `交了 · 请决断 ${ordered.asm.report.commandBrief.decisionsRequired.length} 件 · 拟制命令 ${ordered.asm.report.commandBrief.proposedOrders.length} 条`
          : "这道题是决策题，但收口没交决断包"
        : "行业题，不交",
      折掉的重复数: dedup.length ? dedup : "一个都没有",
      对完账的稿子: `递进去 ${merged.sections.length} 维 · 承重未验证 ${unverified.length} 条`,
      出稿次数: attempts,
      摘掉的内部锚点: input.stripAnchors ? (removedHooks.length ? removedHooks : "一条都没摘") : "这一遍没送检",
      分层禁令: layerMiss.length ? layerMiss : "四条都过",
      策略复核: card.decision
        ? `${strategyReview.status} · 有效建议 ${strategyReview.effective.length} 条 · 只作历史 ${strategyReview.historical.length} 条`
        : "行业题，没有候选路线",
      交付: `调用结束 · ${completeness}（核心论证 ${sections.length}/${planned} 节，收口${closing ? "交了" : "没跑成"}） · ${readiness}`,
      对不上的: notes,
    },
    "local"
  );

  return {
    report: ordered.asm.report,
    text,
    lint,
    unsentLint,
    gate,
    notes,
    attempts,
    strategyReview,
    outlineFrom: outlineRead.from,
    delivery,
  };
}
