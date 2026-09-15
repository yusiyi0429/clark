/**
 * N6 出口对账。**十二项确定性检查，不问模型。**
 *
 * 每条违规带一个打回的节点号：改了正文的问题让 N5 重写，覆盖不够让 N3 再跑一波，口径与
 * 锚点的问题回 N4。节点号现在只进账不触发：**不再整段打回重写**（`MAX_AUDIT_ROUNDS = 1`，理由
 * 在它自己那条注释里），没过的带缺陷清单出稿并在文首声明。
 *
 * 这一层和 `gate.ts`（引用绑不绑得上、算术复不复算得通）、`blocks/lint.ts`（每个块的结构
 * 纪律）**三层并存，各管一段**：那两层问的是「这一份写得合不合规」，这一层问的是「这一轮
 * 的研究链有没有断」。混成一层的话，A4-N02 这种「某一维压根没进过检索」会被写成一条报告
 * 级违规，然后被送去让模型重写报告 —— 而它重写不出没检索过的东西。
 */

import type { Violation } from "@/lib/agent/rules";
import { sentences } from "@/lib/agent/rules";
import type { CommandBrief, ReportBlocks } from "./blocks/schema";
import { EVIDENCE_EFFECTS, isDueDay, normalizeRef } from "./blocks/schema";
import { blocksToText } from "./blocks/report";
import type { SubjectCard } from "./anchor";
import { shares } from "./anchor";
import { disclosureFreshness, FRESHNESS_MONTHS, type AuditEvidence } from "./disclosure";
import type { DimCoverage, DimId, TaskScope } from "./dims";
import { gateOpen } from "./dims";
import { HEDGES } from "./draft";
import { APPENDIX_TYPES, layerGaps } from "./layer";
import { hooksOf } from "./anchor-gate";
import type { Calculation } from "@/lib/research/calc";

/**
 * 出口对账最多跑几轮。**2026-09-04 晚从 2 压到 1：不再整段打回重写。**
 *
 * 四轮真运行的账：227 没打回；228、229 打回了但时间不够没重写；230 真的重写了一遍 ——
 * 重跑锚定 + 对账（247 秒）+ 整遍成稿，499 秒，三条 p0 只修掉了 N05 那一条，N03（独立来源
 * 不够）和 N04（占比加总）是证据层和词面的问题，重写正文改不动。也就是说这条循环在四轮里
 * 只兑现过一次，花了八分钟，换回一条。
 *
 * 留下的是按块的返修（`stage-write.ts` 的 `spliceRepair`，40 秒修掉两处没绑证据的数字）和
 * 缺陷清单：没过的那几条原话进 `gaps`、报告标成 degraded。要重写，走「打回重研」那个明确
 * 的动作，不在这里自动烧。
 */
export const MAX_AUDIT_ROUNDS = 1;

/** 每条规则打回哪个节点。屏幕上和 trace 上说的是同一句。 */
export const NODE_OF_RULE: Record<string, string> = {
  "A4-N01": "N5",
  "A4-N02": "N3",
  "A4-N03": "N4",
  "A4-N04": "N4",
  "A4-N05": "N0/N5",
  "A4-N06": "N4",
  "A4-N07": "N5",
  /*
   * 决断包是**收口那一次**（N5 的最后一发，`deadline.ts` 里那条「这一次必须发得出去」）
   * 多交的一段，所以打回 N5 —— 而且是按块的定点返修（`spliceRepair`），只重发这一块，
   * 不是整遍重写。整遍重写在这个仓库里已经证过不划算（`MAX_AUDIT_ROUNDS` 那条注释）。
   */
  "A4-N08": "N5",
  /*
   * 新鲜度是**取证**的事实，不是写作的缺陷：报告里那句「拿的是 2024 年报」重写一百遍
   * 也变不成 2025 年报。所以指向 N3。和 A4-N02/N03 一样，它是 p1，实际不参与打回
   * （`pipeline.ts` 递的是 `blocking(audit)`）—— 哪天打回真的接到 N3 补搜，再谈升级。
   */
  "A4-N09": "N3",
  /*
   * 2026-09-07 加的三条，全指向 N5（出稿）：它们说的都是**同一批事实被写成了什么样**，
   * 不是这一轮少查了什么。三条都是 p1 —— 顶上 `MAX_AUDIT_ROUNDS` 那条注释记着 p0 会去争
   * 那一轮重写的预算，而这一批要拦的是措辞，缺陷清单上印一行就够看的人自己判。
   */
  "A4-N10": "N5",
  "A4-N11": "N5",
  "A4-N12": "N5",
};

/* -------------------------------------------------------------------------- */
/* 决断包（A4-N08）                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 从报告上取决断包。**它不在 `blocks` 里** —— 决断包是报告级的一行（同 `report_meta`），
 * 由 `blocks/parse.ts` 单独收，挂在 `ReportBlocks.commandBrief` 上。
 */
const briefOf = (report: ReportBlocks): CommandBrief | undefined => report.commandBrief;

/* -------------------------------------------------------------------------- */
/* 新鲜度（A4-N09）                                                            */
/* -------------------------------------------------------------------------- */

/*
 * 这几样搬去 `disclosure.ts` 了（装配那一步也要用同一份判据）。仍从这里转出：
 * 单测和别处按 `./audit` 取它们，换 import 路径是一次纯噪音的改动。
 */
export {
  disclosureFreshness,
  disclosureOrigin,
  FRESHNESS_MONTHS,
  isDisclosureEvidence,
  materialCutoff,
  periodEnd,
  periodKind,
  periodWithin,
} from "./disclosure";
export type { AuditEvidence } from "./disclosure";

/* -------------------------------------------------------------------------- */
/* 措辞那三条（A4-N10 / N11 / N12）                                            */
/* -------------------------------------------------------------------------- */

/*
 * 这三条判的都是**同一批事实被写成了什么样**，所以它们读的是整份报告的文字（正文 + 决断包），
 * 不是块的结构。判据全部写成常量正则摆在这里，一条一条能被单测钉住 —— 埋在循环里的话，
 * 「它到底拦什么」要读一遍代码才知道，而这三条本来就是靠词面拦的，判据必须看得见。
 *
 * 三条都是 p1。它们说的是「这句话比依据更硬」，而硬不硬有边界情况，误报的代价是让人不再看
 * 缺陷清单；p0 还会去争那一轮重写的预算（`MAX_AUDIT_ROUNDS`）。
 */

/** 报告的全部文字：正文按 `blocksToText`，决断包各栏另接在后面（它不是块，不在 `blocks` 里）。 */
function reportText(report: ReportBlocks): string {
  const b = report.commandBrief;
  const brief = b
    ? [
        ...b.situation.map((s) => s.text),
        b.recommendation.action,
        b.recommendation.intent,
        b.recommendation.whyNow,
        b.recommendation.evidenceEffectWhy,
        ...b.decisionsRequired.flatMap((d) => [d.question, d.recommendedChoice, d.costOfDelay, d.recoveryIfWrong]),
        ...b.proposedOrders.flatMap((o) => [o.outcome, ...o.acceptance]),
        ...b.controls.mustNot,
        ...b.controls.changeTriggers,
        ...b.controls.abortConditions,
        ...(b.alternatives ?? []).flatMap((a) => [a.action, a.whenBetter]),
      ]
    : [];
  return [blocksToText({ title: report.title, blocks: report.blocks }), ...brief].filter(Boolean).join("\n");
}

/**
 * 断句。**不用 `rules.ts` 的 `sentences`** —— 那一个只在 。！？ 处断，而决断包各栏是一栏一句
 * 短语、多半不带句号：拿它切出来的是一整块几百字的「一句话」，下面按句判的三条会在那一块里
 * 同时看到「任一」和「同时」，然后报一条其实不存在的不一致。这里连换行、分号、顿号级的
 * 停顿一起断。
 */
const lines = (text: string): string[] =>
  text
    .split(/[。；！？\n]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 1);

/** 断言公司没有某条 Mission。**「我没查到」不是「它不存在」**（HANDOVER §1）。 */
const MISSION_ABSENT =
  /(没有|不存在|缺少|未设立?|尚无|均无)[^。；！？\n]{0,24}(Mission|使命)|(Mission|使命)[^。；！？\n]{0,12}(不存在|是空的|均没有)/;
/** 提议新增一条 Mission。月初由 CEO 与各 DRI 协商定，不是研究这一步的产物。 */
const MISSION_NEW = /(新建|新增|另设|单独设[定立]|需要设立|独立设立)[^。；！？\n]{0,14}(Mission|使命)/;
/** 这句话自己已经说清了「这是没查到，不是没有」。 */
const UNKNOWN_HEDGE = /(待确认|待核|未检索到|没有检索到|本轮未|尚未确认|无法确认|未能确认|不确定)/;
/** 新增 Mission 的例外理由：已知的哪一条承接不了。 */
const CANNOT_CARRY = /(无法承接|不能承接|承接不了|承接不住|挂不到|挂不上)/;
/** 新增 Mission 对 OM 的影响：Outcome、原有承诺、资源。 */
const OM_IMPACT = /(Outcome|原有承诺|既有承诺|资源(占用|重排|影响)?|OM)/;

/** 会让我方被动承诺的那几件事。它们的共同点：一号位事后最难收回。 */
const PROMISE_TOPIC =
  /(私有化部署|私有部署|内网部署|本地化部署|数据不出厂|数据不出域|数据不出场|知识产权|知识资产|源码|代码交付|独家授权)/;
/** 把它说成我方可以做到的那几种说法。 */
const PROMISE_VERB = /(承诺|保证|确保|可以做到|做得到|我方(将|会|能)|我们(将|会|能)|明确告知|向对方说明|归客户|归对方|归属客户|归属对方)/;
/** 已经写成待核项、或者本来就是一句「不要承诺」。 */
const PROMISE_HEDGE = /(不承诺|不得承诺|不要承诺|不许承诺|不能承诺|需核实|待核实|未核实|待确认|会前|未确认|尚未确认|待授权)/;

/** 停止/放弃这一类条件。 */
const ABORT_TOPIC = /(放弃|停止|中止|终止|不再推进|收手)/;
/** 成功/验收这一类判据。 */
const SUCCESS_TOPIC = /(成功|验收|算成|达成)/;
/** 「几项里有一项就算」。 */
const ANY_OF = /(任一|其一|任何一[项条个]|只要有一|有一项)/;
/** 「几项都要」。 */
const ALL_OF = /(同时|全部|均需|都要|缺一不可|齐全|三项都|全部满足)/;

const CN_NUM: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8 };
/** 「两小时」「2 小时」都认；「半小时」不认（半小时的议程不会再拆成几段分钟）。 */
const HOURS = /(\d+|[一两二三四五六七八])\s*(?:个)?\s*小时/g;
const MINUTES = /(\d+)\s*分钟/g;
/** 差额已经交代过了，就不是不一致。 */
const SLACK_EXPLAINED = /(机动|留白|缓冲|余下|其余|弹性|不含|另计)/;

export type AuditInput = {
  report: ReportBlocks;
  card: SubjectCard;
  coverage: readonly DimCoverage[];
  strongDims: readonly DimId[];
  gatedHooks: readonly string[];
  /**
   * 那一遍锚点相关性检查到底跑过没有。
   *
   * 必填、而且不能从 `gatedHooks` 推：摘锚点那一步（`stripHooks`）把没过检的锚点从块里删掉，
   * 所以到这里的时候「送检了、一条都没过」和「压根没送检」在数据上长得一样 —— 前者报告里
   * 一条锚点都不剩，后者报告里那几条锚点谁都没看过，而 `gatedHooks` 两种都是空的。
   */
  anchorGateRan: boolean;
  /**
   * N3 取证这一段到底跑过没有。
   *
   * **`coverage` 答不出这件事。** 跑过一波但每一维都空手，和整段被跳过（没有命题、这台
   * 机器没配检索），在覆盖表上长得一模一样：全零。而这两种下面 A4-N02 / A4-N03 该说的话
   * 完全相反 —— 前者是「搜过没搜着，换个问法再搜」，后者是「压根没搜，去看 N2 为什么没
   * 交出命题」。
   *
   * 分开还有一个更贵的理由：整段没跑的那一轮，覆盖表会一次报出八到十几条 p0，把 N6 那一
   * 轮重写的预算全部指向一件重写改不动的事。`RUN-A4-mth5jkf0-6` 就死在这里 —— 11 条 p0
   * 里绝大多数是这一类，而真正该重跑的是收口那一次。
   */
  retrievalRan: boolean;
  /**
   * 这道题问的是本公司自己的事（`SubjectCard.inward`）：取证是**有意**不跑的，覆盖表全零是
   * 设计而不是缺陷，A4-N02 / N03 那两条不适用。缺省为假。
   */
  inward?: boolean;
  subjectVariables: readonly string[];
  calculations?: readonly Calculation[];
  /*
   * ---- 下面四栏全是可选的，缺省时 A4-N08 / A4-N09 一声不响地跳过 ----
   *
   * 不是保守，是**接线次序**：决断包那一段（`blocks/schema.ts` 的 `commandBrief`、收口
   * 提示词、`pipeline.ts` 的调用点）在另外几条线上同时改。这两条规则连同它们的单测先落地、
   * 等那几条接上来，中间这段时间里整个仓库照旧编译、照旧全绿 —— 代价是「接了一半」的状态下
   * 这两条规则不干活，而那正是我们要的：一道在别人还没交出物料的时候就开火的闸，只会教人
   * 把它关掉。
   */
  /**
   * 收口那一次到底**要没要**这份决断包。
   *
   * **2026-09-07 起没有任何一条规则读它。** 它原来区分的是「要了、模型没交」和「压根没要」——
   * 前者曾经是一条 p0。那条 p0 已经撤掉（没有决断包的报告是合法的，见 A4-N08 那一段），
   * 于是两种情形该说的话变成了同一句：什么都不说。
   *
   * 栏留着不删：`pipeline.ts` 还在递它，运行记录里也还看得见这一轮的收口要没要过这一屏 ——
   * 那是一条读 trace 的人用得上的事实，只是不再是一道闸。
   */
  commandBriefAsked?: boolean;
  /**
   * 这一轮的证据台账（`Ledger.entries`）。A4-N09 要拿它看域名和报告期。
   *
   * 和 `report.evidence` 不是一回事：那一份是**报告引到的**证据（`registry.ts` 折出来的
   * 编号表），这一份是**这一轮抓回来入了账的**全部条目。新鲜度问的是「有没有拿到」，
   * 不是「有没有引到」，所以看台账。
   */
  entries?: readonly AuditEvidence[];
  /**
   * 这一轮的任务范围（`dims.ts` 的 `TaskScope`）。**A4-N02 / N03 按它出缺失，不按八维。**
   *
   * 缺省是行业题那一份（`INDUSTRY_SCOPE`），所以老调用点行为一字不变。决策题上不递它的
   * 后果是：这道题压根不需要的那几维会被逐条报成「一组独立来源都没有」—— ISS-239 那一轮
   * 正是这样，而那些缺失一条都改不动。
   */
  scope?: TaskScope;
  /** 「今天」。测试要钉住窗口边界，所以不在函数体里 `new Date()`。缺省时 A4-N09 不判。 */
  now?: Date;
  /**
   * 除 `DISCLOSURE_HOSTS` 之外还算一手披露的域名 —— 主体自己的官网（重大公告和 IR 材料
   * 也是一手的）。模型给的串，可能是空串或者带协议头，`isDisclosureEvidence` 里已经防过。
   */
  disclosureDomains?: readonly string[];
};

/**
 * 十二项出口对账。每条违规带打回的节点号。
 */
export function auditExit(input: AuditInput): Violation[] {
  const violations: Violation[] = [];

  // A4-N01: 立场存在性 —— verdict_banner 骑墙或证据不足
  const banner = input.report.blocks.find((b) => b.type === "verdict_banner");
  if (banner && banner.type === "verdict_banner") {
    const text = banner.text;
    if (HEDGES.some((h) => text.includes(h)) || text.includes("证据不足") || text.includes("不足以判断")) {
      violations.push({
        rule: "A4-N01",
        severity: "p0",
        message: `总判断缺立场：「${text}」—— 骑墙或证据不足的话，后续节点没有可验证的东西`,
      });
    }
  }

  /*
   * A4-N02 / A4-N03：维度覆盖与源独立性。
   *
   * **取证整段没跑的那一轮，这两条合成一句 p1。** 逐维报的话是八到十几条 p0，而它们说的
   * 是同一件事、指向同一个原因（N2 没交出命题，或者这台机器没配检索），且没有一条是重写
   * 报告能改动的 —— 覆盖表由取证决定。
   *
   * 用 p1 而不是 p0，是因为 p0 会去争 N6 那一轮重写的预算，而重写救不了它；一同挂在那一轮
   * 上的、真的能被重写救回来的东西（比如收口没跑、报告没有核心判断横幅）会被它挤掉。
   * `RUN-A4-mth5jkf0-6` 正是这样丢掉重写的：11 条 p0 里九条是这一类，剩下的预算差 49 秒。
   *
   * 降级只降**这一种**（整段没跑）。跑过一波、某几维空手的那一种照旧逐条 p0 —— 那一种换个
   * 问法再搜是真的可能补上的，值得打回。
   */
  if (input.inward) {
    // 问的是自己家里的事：没有外部主体，覆盖表全零是设计。这两条不报。
  } else if (!input.retrievalRan) {
    violations.push({
      rule: "A4-N02",
      severity: "p1",
      message:
        "这一轮 N3 取证整段没跑，八个维度的覆盖表全是空的 —— 这不是报告写得不够，" +
        "是这一轮压根没有外部证据可写。去看 N2 检索计划为什么没交出命题（额度、模型、或者这台机器没配检索）。",
    });
  } else {
    /*
     * **2026-09-04：覆盖与独立性两条降成 p1。** 上面那段注释说「换个问法再搜是真的可能补上的，
     * 值得打回」——但打回去的是 N4/N5（`NODE_OF_RULE`），没有任何一处会再搜。ISS-230 为一条
     * 「D4 独立来源 1 组，要 2 组」重跑了主体卡、对账（247 秒）和整份 N5，回来仍是同一条 p0。
     * 覆盖是取证的事实，不是写作的缺陷；记在清单上，不拿它换一次改不动它的重写。
     * 哪天打回真的接到 N3 补搜，再升回 p0。
     */
    // A4-N02: 维度覆盖 —— 八个维度都要进覆盖表
    const { missing: allMissing } = gateOpen(input.coverage, [], input.scope);
    for (const msg of allMissing) {
      violations.push({
        rule: "A4-N02",
        severity: "p1",
        message: msg,
      });
    }

    // A4-N03: 源独立性 —— 强判断要两组独立来源
    const { missing: strongMissing } = gateOpen(input.coverage, input.strongDims, input.scope);
    // 差集：避免和 A4-N02 重复报同一条
    const uniqueStrongMissing = strongMissing.filter((m) => !allMissing.includes(m));
    for (const msg of uniqueStrongMissing) {
      violations.push({
        rule: "A4-N03",
        severity: "p1",
        message: msg,
      });
    }
  }

  // A4-N04: 口径纪律 —— 算术复核失败 + 正文跨口径算数
  if (input.calculations) {
    const failed = input.calculations.filter((c) => !c.ok);
    for (const c of failed) {
      /*
       * 占比加总那一条降成 p1（2026-09-04）：今天两轮两次都是假警报——三个时点的份额、收入构成
       * 与客户集中度（分母不同）被当成一个整体的几块加起来。它拦到真错的那一次还没出现过，
       * 却已经换走了一整遍重写。增速与数量级两条照旧 p0，那两条误报少、错了是真错。
       */
      violations.push({
        rule: "A4-N04",
        severity: c.kind === "share_sum" ? "p1" : "p0",
        message: c.note,
      });
    }
  }
  // 正文扫描：同一句里有两个带不同统计期间标记的数，且句中有算术操作符
  const proseBlocks = input.report.blocks.filter((b) => b.type === "prose");
  for (const block of proseBlocks) {
    if (block.type !== "prose") continue;
    const sents = sentences(block.md);
    for (const sent of sents) {
      // 找统计期间标记：YYYY 年、YYYY年、YYYY年第N季度
      const periodMatches = sent.match(/\d{4}\s*年(?:第[一二三四1-4]\s*季度)?/g);
      if (periodMatches && periodMatches.length >= 2) {
        // 去重后还有至少两个不同的期间
        const uniquePeriods = [...new Set(periodMatches.map((p) => p.replace(/\s/g, "")))];
        if (uniquePeriods.length >= 2) {
          // 句中有算术操作符
          if (/[+\-]|占|倍|增速/.test(sent)) {
            violations.push({
              rule: "A4-N04",
              severity: "p1",
              message: `正文同一句跨口径算数：「${sent.slice(0, 100)}」—— 不同统计期间的数不能直接运算`,
            });
          }
        }
      }
    }
  }

  // A4-N05: 落回主体 —— 主体变量要和重项目有交集
  const heavyProjects = input.card.projects.filter((p) => p.heavy);
  if (heavyProjects.length > 0) {
    let hasIntersection = false;
    for (const proj of heavyProjects) {
      for (const variable of input.subjectVariables) {
        if (shares(proj.name, variable) || shares(variable, proj.name)) {
          hasIntersection = true;
          break;
        }
      }
      if (hasIntersection) break;
    }
    if (!hasIntersection) {
      const projNames = heavyProjects.map((p) => p.name).join("、");
      const vars = input.subjectVariables.join("、");
      violations.push({
        rule: "A4-N05",
        severity: "p0",
        message: `落回主体那一节和战略项目没有交集 —— 重项目「${projNames}」和主体变量「${vars}」没有共同的两字片段`,
      });
    }
  }

  /*
   * A4-N06: 锚点污染 —— 判断块里留着没过相关性检查的内部锚点。
   *
   * 两句话，各拦一头：
   *
   * 1. **检查压根没跑**，而报告里带着内部锚点。这一句是这道闸的实际形态：摘锚点那一步
   *    （`anchor-gate.ts` 的 `stripHooks`）把没过检的锚点从块里删掉之后写回 `report.blocks`，
   *    所以下面那个差集在正常跑法下**永远是空的** —— 只有这一句能拦住「回调丢了」那一种
   *    （报告照样带着锚点，一条都没送检，而这道闸会安静地过）。
   * 2. 差集那一句留着当**保险带**：哪天摘那一步不再原地改 `report.blocks`（或者只在某些块上
   *    摘），报告里就会真的剩下没过检的锚点，那时是这一句报出来。
   */
  const hooksInReport = hooksOf(input.report.blocks);
  if (!input.anchorGateRan && hooksInReport.length) {
    violations.push({
      rule: "A4-N06",
      severity: "p0",
      message: `报告里带着 ${hooksInReport.length} 条内部锚点，而锚点相关性检查这一遍压根没跑：「${hooksInReport.join("、").slice(0, 60)}」—— 没人判过它们和这次研究的命题有没有交集`,
    });
  }
  const ungated = hooksInReport.filter((h) => !input.gatedHooks.includes(h));
  for (const hook of ungated) {
    violations.push({
      rule: "A4-N06",
      severity: "p0",
      message: `留着没过相关性检查的内部锚点：「${hook}」—— 它和这次研究的命题没有直接交集`,
    });
  }

  // A4-N07: 正文自足 —— layerGaps 的四条规则 + 索引与类型的双重检查
  const gaps = layerGaps(input.report);
  for (const gap of gaps) {
    // 口径重复那一条是 p1，其他都是 p0
    const isCaliberRepeat = gap.includes("口径") && gap.includes("个块");
    violations.push({
      rule: "A4-N07",
      severity: isCaliberRepeat ? "p1" : "p0",
      message: gap,
    });
  }

  // `layerGaps`/`partition` 按块的 type 决定正文还是附录，`report.appendixFrom` 按 index
  // 决定 —— 两套标准互不制约，所以一份报告可以通过 `layerGaps`（type 维度无附录块混在正文
  // 类型块里）但 index 维度仍有校验机械（judgment/evidence_list 这类 APPENDIX_TYPES）坐在
  // `appendixFrom` 之前。两层都检查才能拦全。
  const appendixFrom = input.report.appendixFrom;
  if (typeof appendixFrom === "number") {
    // 缺 appendixFrom = 分层之前写的报告，整份当正文（旧报告照旧渲染），没有索引可检查
    for (let i = 0; i < appendixFrom; i++) {
      const block = input.report.blocks[i];
      if (block && (APPENDIX_TYPES as readonly string[]).includes(block.type)) {
        violations.push({
          rule: "A4-N07",
          severity: "p0",
          message: `第 ${i} 个块（${block.type}）出现在 appendixFrom (${appendixFrom}) 之前 —— 校验机械铺在正文里`,
        });
      }
    }
  }

  /*
   * A4-N08: 决断包成形。**只判决策题（`card.decision`），而且只判交上来的那一份。**
   *
   * ## 2026-09-07：这道闸从「必须交」退成「交了就要成形」
   *
   * 上一版建立在「决策题的一级产物是决断包」这个前提上，所以没交就是 p0。前提被推翻了
   * （见下面 `!brief` 那一支里的注释）：**研究完成 ≠ 已经形成决议 ≠ 应该立即派发命令。**
   * 现在没交一条都不报，交了照旧按形状判 —— 一份交上来的决断包缺一栏「做错了怎么退」，
   * 看的人还是得翻回正文去找，那件事没变。
   *
   * ## 为什么形状那几条仍旧是 p0
   *
   * 顶上 `MAX_AUDIT_ROUNDS` 那条注释记着 `RUN-A4-mth5jkf0-6` 的账：11 条 p0 把那一轮重写的
   * 预算全部指向重写改不动的事，真能被救回来的那几条被挤掉。形状这几条和那 11 条正好相反：
   * 返修的对象是可指认的（就是 `command_brief` 这一块），修法是明确的（`spliceRepair` 只重发
   * 这一块，40 秒的量级），而且重发**真的能修好** —— 缺的是模型没写的栏，不是没搜到的事实。
   *
   * 承重事实和无依据的日期那两条是 p1：要补的是证据和依据，重写这一块补不出来。
   */
  const brief = briefOf(input.report);
  if (input.card.decision) {
    if (!brief) {
      /*
       * **2026-09-07：没交决断包不再是缺陷，一条都不报。**
       *
       * 上一版在这里开了一条 p0：决策题没交这一屏就打回收口。那条闸建立在「一级产物是决断包」
       * 这个已经被推翻的前提上 —— `SubjectCard.decision` 只表示**这道题需要做一个选择**，
       * 不表示一号位此刻授权派发命令。默认研究首屏是当前判断、依据、边界和下一步要弄清的问题；
       * 行动整理是他明确进入那一步之后的事（`prompt.ts` 的 `DECISION_SHAPE` 上那段同日的注释）。
       *
       * 所以这里现在什么都不做：**没有命令包的新报告是完全合法的。** 留着这条 p0 的下场是
       * 「新的出稿形状已经不要它了，旧闸还在逼它交」—— 而闸逼出来的那一屏正是 ISS-239 里那份
       * 无依据的日期和承诺。
       *
       * `commandBriefAsked` 那一栏留着（`pipeline.ts` 还在递，别处也可能要知道这一轮要没要过），
       * 只是不再有任何一条规则读它。
       */
    } else {
      const push = (message: string, severity: "p0" | "p1" = "p0") =>
        violations.push({ rule: "A4-N08", severity, message });

      // 唯一主张：一条 action，备选最多两条。备选多过两条就不是「主张」，是又一份选项清单。
      if (!brief.recommendation.action.trim()) {
        push("决断包的 recommendation.action 是空的 —— 这一屏没有给出要做的那一件事");
      }
      const alts = brief.alternatives ?? [];
      if (alts.length > 2) {
        push(`决断包给了 ${alts.length} 条备选（alternatives），上限 2 条 —— 备选摊开就不是唯一主张了`);
      }

      /*
       * 态势也是 ≤3 条。**这道闸在这里判，屏幕不再截**：`CommandBriefView` 原来自己
       * 又截了一次前三条，于是多交的那几条在屏幕上不留任何痕迹 —— 一号位看到的三条
       * 和参谋交的六条长得一模一样，而「它到底交了几条」正是这一屏该不该被信任的一部分。
       * 一处判、一处显示，两边不各截各的。
       */
      if (brief.situation.length > 3) {
        push(`决断包里 situation 有 ${brief.situation.length} 条，上限 3 条 —— 只留会改变行动的那几条`);
      }

      // 要一号位定的事：≤3 条，每条四栏齐。少「做错了怎么退」的那一条最常见。
      if (brief.decisionsRequired.length > 3) {
        push(`决断包里 decisionsRequired 有 ${brief.decisionsRequired.length} 条，上限 3 条 —— 一屏装不下第四条`);
      }
      brief.decisionsRequired.forEach((d, i) => {
        const miss = (
          [
            ["question", d.question],
            ["recommendedChoice", d.recommendedChoice],
            ["costOfDelay", d.costOfDelay],
            ["recoveryIfWrong", d.recoveryIfWrong],
          ] as const
        )
          .filter(([, v]) => !(v ?? "").trim())
          .map(([k]) => k);
        if (miss.length) {
          push(`decisionsRequired 第 ${i + 1} 条缺 ${miss.join("、")} —— 四栏缺一栏，这一条就不是可拍板的形态`);
        }
      });

      /*
       * 派下去的活：≤3 条，每条 role / outcome / acceptance 齐。没有 acceptance 的活等于没派。
       *
       * ## 2026-09-07：`dueOn` 从「必填」改成「填了就要站得住」
       *
       * 上一版把 `dueOn` 非空列进必填，于是每一条命令都得有一个日期 —— ISS-239 那三个九月的
       * 日子（11/14/18）就是这么被逼出来的：一个都说不出依据，而它们在屏幕上和真的约好的日子
       * 长得一模一样。**一道闸只要求「这一栏有字」，模型就一定会往里填字**，填的是不是真的
       * 它答不出来。
       *
       * 改成三条，各答一问（栏的分工见 `schema.ts` 的 `proposedOrders`）：
       *
       *   1. 三栏都空 —— **合法，一条都不报。** 没有排期好过替一号位约一个他没约过的时间。
       *   2. `dueOn` 里写的不是日期 —— p0。这一栏下游会被当成日期消费（「首访前」会变成一个
       *      到期日）。`readCommandBrief` 已经在入口把这一种挪去 `dueNote` 了，所以这一条
       *      正常跑法下不该响；它是 A4-N06 第 2 句那种保险带 —— 哪天有人绕过那一层构造报告，
       *      要有一处说得出话。
       *   3. `dueOn` 是个确定日期但没有 `dueBasis` —— p1。这正是「输出的确定性超过了已知信息」
       *      那一类：日期本身没错，错在它凭空。p1 不 p0 的理由同 A4-N02/N03 —— 要补的是依据，
       *      而依据在研究那一层，不在重发这一块里。
       */
      if (brief.proposedOrders.length > 3) {
        push(`决断包里 proposedOrders 有 ${brief.proposedOrders.length} 条，上限 3 条`);
      }
      brief.proposedOrders.forEach((o, i) => {
        const miss: string[] = [];
        if (!(o.role ?? "").trim()) miss.push("role");
        if (!(o.outcome ?? "").trim()) miss.push("outcome");
        if (!(o.acceptance ?? []).some((a) => a.trim())) miss.push("acceptance");
        if (miss.length) {
          push(`proposedOrders 第 ${i + 1} 条缺 ${miss.join("、")} —— 没有验收标准的活派不下去`);
        }
        const due = (o.dueOn ?? "").trim();
        if (due && !isDueDay(due)) {
          push(
            `proposedOrders 第 ${i + 1} 条的 dueOn 写的是「${due}」，不是一个日期 —— ` +
              "相对时间（「首访前」「日期待定」）写进 dueNote，dueOn 只放会被当成日期去算天数的那一种"
          );
        }
        if (due && !(o.dueBasis ?? "").trim()) {
          push(
            `proposedOrders 第 ${i + 1} 条给了确定日期 ${due}，却没写它是怎么定出来的（dueBasis）—— ` +
              "没有依据的日期是替一号位约的时间；说不出依据就把日期留空，相对时间写进 dueNote",
            "p1"
          );
        }
      });

      /*
       * 变更触发与中止条件各至少一条。这两栏是决断包里唯一朝前看的东西：没有它们，这一屏
       * 是一次性的意见；有了它们，它是一份可以被后来的事实推翻的承诺。`mustNot` 不强制 ——
       * 不是每一件事都有禁区，硬要一条的结果是模型编一条。
       */
      if (!brief.controls.changeTriggers.some((t) => t.trim())) {
        push("决断包的 controls.changeTriggers 是空的 —— 没有说什么变了就要改主意");
      }
      if (!brief.controls.abortConditions.some((t) => t.trim())) {
        push("决断包的 controls.abortConditions 是空的 —— 没有说什么情况下停手");
      }

      // 这一轮证据把上一轮的判断怎么了。四选一 + 一句为什么，缺了就是「附会」而不是「更新」。
      if (!(EVIDENCE_EFFECTS as readonly string[]).includes(brief.recommendation.evidenceEffect)) {
        push(
          `决断包的 evidenceEffect 是「${brief.recommendation.evidenceEffect}」—— 只认 ${EVIDENCE_EFFECTS.join("/")} 四个值`
        );
      }
      if (!brief.recommendation.evidenceEffectWhy.trim()) {
        push("决断包的 evidenceEffectWhy 是空的 —— 说了证据把判断怎么了，没说凭哪一条");
      }

      /*
       * 引到的编号必须在这一份报告的证据表里找得到。找不到 = 一个凭空的编号，屏幕上和真的
       * 那一份长得一样。归一化按 `normalizeRef`：`e3`/`[E3]`/`E3 ` 是同一条，校验器和屏幕上
       * 必须是同一个字符串。
       */
      const byId = new Map(input.report.evidence.map((e) => [normalizeRef(e.id), e]));
      const cited: { where: string; refs: readonly string[] }[] = [
        ...brief.situation.map((s, i) => ({ where: `situation 第 ${i + 1} 条`, refs: s.evidenceRefs ?? [] })),
        { where: "recommendation", refs: brief.recommendation.evidenceRefs ?? [] },
      ];
      for (const { where, refs } of cited) {
        const unknown = refs.map(normalizeRef).filter((r) => r && !byId.has(r));
        if (unknown.length) {
          push(`决断包 ${where} 引的编号在证据表里不存在：${unknown.join("、")}`);
        }
      }

      /*
       * **承重事实门。** 决断包引到的每一条都要 A/B 级。
       *
       * 这条比「A/B 证据总数够不够」准：ISS-238 那一份有 7 条 A 级证据，仍然漏了最要紧的那一份
       * （2025 年报），因为承重的那几句引的不是那 7 条里的任何一条。总数问的是「这一轮搜得好
       * 不好」，这一条问的是「**这一屏上的话**站在什么上面」—— 后者才是一号位要承担的东西。
       *
       * p1 而不是 p0：要补的是证据，重发这一块补不出来（和 A4-N02/N03 降级是同一个理由）。
       */
      for (const { where, refs } of cited) {
        const known = refs.map(normalizeRef).filter((r) => byId.has(r));
        if (!known.length) {
          push(`决断包 ${where} 一条证据都没引 —— 这一屏上的话没有承重的事实`, "p1");
          continue;
        }
        const weak = known.filter((r) => byId.get(r)?.grade === "C");
        if (weak.length) {
          push(
            `决断包 ${where} 承重在 C 级证据上：${weak.join("、")} —— 一号位要拍的板不能只有媒体转述在撑`,
            "p1"
          );
        }
      }
    }
  }

  /*
   * A4-N09: 新鲜度门。**台账里有没有一份最近一期的一手披露。**
   *
   * ISS-238：一份深研拿 2024 年报下了「现金流薄」的判断，而 2026 年 4 月发布的 2025 年报
   * （经营现金流回升到 23 亿）当时就挂在巨潮上。那一轮的证据数量、覆盖表、独立来源全部达标 ——
   * 现有的每一道闸都问「有没有证据」，没有一道问「有没有**最近那一份**」。
   *
   * 判据拆成两个纯函数（`isDisclosureEvidence` / `periodWithin`），是为了让「哪一天算过期」
   * 这件事被单测钉死而不是靠读一遍这段循环。
   *
   * p1：拿不到最近一期披露不是写作的缺陷，重写救不了；它该做的是印在缺陷清单上，让看的人
   * 知道下面那些财务判断建立在什么上面。
   */
  const entries = input.entries;
  const now = input.now;
  const inward = input.inward || input.card.inward;
  if (
    entries &&
    now &&
    !inward &&
    input.card.subject.trim() &&
    // 取证整段没跑那一轮，A4-N02 已经用一句话说清了原因，这里再报一条是同一根手指指两次。
    input.retrievalRan
  ) {
    /*
     * **2026-09-07（ISS-239）：这一条拆成两句话。**
     *
     * 上一版只问「有没有一手披露域名上的近期报告期」，答不上就印「没拿到最近一期披露，
     * 下面关于财务状况的判断都建立在旧数上」。ISS-239 那一轮它就是这么报的 —— 而那句话
     * 是**假的**：台账上有 2025 年年报和 2026 年 5 月的投资者关系记录，只是它们挂在新浪
     * 的镜像页上，域名不在表里。
     *
     * 「一条近期公司材料都没有」和「近期材料只有镜像转载、原件没拿到」是两件事，
     * 后面那件要做的不是重查，是去原站核一次身份。混成一句话的代价是：真的什么都没查到
     * 的那一轮，和查到了但来源要核的那一轮，在缺陷清单上长得一模一样。
     */
    const freshness = disclosureFreshness(entries, now, {
      disclosureDomains: input.disclosureDomains ?? [],
    });
    if (!freshness.companyFresh) {
      violations.push({
        rule: "A4-N09",
        severity: "p1",
        message:
          `台账 ${entries.length} 条里没有一条近期公司材料（一手披露与镜像转载都没有）——` +
          `报告期落在最近 ${FRESHNESS_MONTHS} 个月内的一条都没有。下面关于${input.card.subject}` +
          "经营状况的判断都建立在旧数上。",
      });
    } else if (!freshness.primaryFresh) {
      violations.push({
        rule: "A4-N09",
        severity: "p1",
        message:
          `最近一期公司材料（${freshness.latestPeriod || "期次未写"}）取自镜像转载站` +
          `（${freshness.mirroredRefs.join("、")}），原站与报告身份未核对；` +
          `没有从巨潮 / 交易所 / ${input.card.subject}官网拿到同一期原件。`,
      });
    }
  }

  /*
   * A4-N10 / N11 / N12：**输出的确定性不得超过已知信息。**
   *
   * 三条一起加（2026-09-07），拦的是 ISS-239 那一份里三类真的出现过的写法。判据在文件上半部分
   * 那一组常量里，一条一条能被单测钉住。全部 p1，理由同那一组注释。
   */
  const text = reportText(input.report);
  const sents = lines(text);

  // A4-N10: 本体里检索不到 Mission ≠ 公司没有该 Mission，更不是可以自己新建一条。
  for (const sent of sents) {
    if (MISSION_ABSENT.test(sent) && !UNKNOWN_HEDGE.test(sent)) {
      violations.push({
        rule: "A4-N10",
        severity: "p1",
        message:
          `把「没检索到」写成了「公司没有」：「${sent.slice(0, 60)}」—— ` +
          "研究这一步看不到完整的 Outcome/Mission 清单，检索不到只能写成「本轮未检索到，归属待确认」。",
      });
    }
  }
  if (MISSION_NEW.test(text) && !(CANNOT_CARRY.test(text) && OM_IMPACT.test(text))) {
    /*
     * 例外理由和 OM 影响在**整份**里找，不在同一句里找：模型多半会把「为什么挂不上去」写在
     * 前一段、把「对原有承诺的影响」写在后一段。逐句要求三样齐全的话，写对了的那一份也会被报。
     */
    violations.push({
      rule: "A4-N10",
      severity: "p1",
      message:
        "报告提出新增一条 Mission，却没有同时写清**已知的哪条 Mission 为什么承接不了**、" +
        "以及它对原有 Outcome、承诺和资源的影响 —— 新增 Mission 是月初 CEO 与 DRI 协商的少量例外，" +
        "研究这一步只能提出例外建议并交代这两件事。",
    });
  }

  // A4-N11: 能力与商务边界未知时只能写「会前需核实」，不能替我方许诺。
  for (const sent of sents) {
    if (PROMISE_TOPIC.test(sent) && PROMISE_VERB.test(sent) && !PROMISE_HEDGE.test(sent)) {
      violations.push({
        rule: "A4-N11",
        severity: "p1",
        message:
          `替我方许下了一条没有依据的承诺：「${sent.slice(0, 60)}」—— ` +
          "部署方式、数据边界、知识产权归属这几样，公司上下文里没有明确写着我方能做、能授权的，" +
          "只能写成一条会前需核实项。规划中的能力不是当前能交付的能力。",
      });
    }
  }

  /*
   * A4-N12: 同一件事在这一份里有两个版本。**只在有决断包的时候判** —— 这一类不一致的成因
   * 是「摘要那一屏和正文各写了一遍」（ISS-239：决断包说三项同时拒绝才停，正文说任一拒绝就停），
   * 没有那一屏的报告不会有这个病，拿同一套词面去扫行业题只会收获误报。
   *
   * 代码这一层只判**数字和结构**：量词冲突、时长加总。语义上的一致性（这两句到底是不是在说
   * 同一件事）留给已有的出口调用，不另加一条固定的评审链。
   */
  if (input.report.commandBrief) {
    for (const [topic, name] of [
      [ABORT_TOPIC, "放弃/停止条件"],
      [SUCCESS_TOPIC, "成功/验收判据"],
    ] as const) {
      const onTopic = sents.filter((s) => topic.test(s));
      const anyOnes = onTopic.filter((s) => ANY_OF.test(s));
      const allOnes = onTopic.filter((s) => ALL_OF.test(s));
      if (anyOnes.length && allOnes.length) {
        violations.push({
          rule: "A4-N12",
          severity: "p1",
          message:
            `${name}在这一份里有两个版本：一处写「任一就算」（「${anyOnes[0].slice(0, 40)}」），` +
            `另一处写「要同时/全部」（「${allOnes[0].slice(0, 40)}」）—— 摘要和正文各写一遍就会这样，` +
            "同一件事只留一个版本。",
        });
      }
    }

    for (const block of input.report.blocks) {
      const t = blocksToText({ title: "", blocks: [block] });
      if (SLACK_EXPLAINED.test(t)) continue;
      const hours = [...t.matchAll(HOURS)].map((m) => Number(m[1]) || CN_NUM[m[1]] || 0).filter(Boolean);
      const minutes = [...t.matchAll(MINUTES)].map((m) => Number(m[1])).filter((n) => n > 0);
      if (hours.length !== 1 || minutes.length < 2) continue;
      const sum = minutes.reduce((a, b) => a + b, 0);
      const declared = hours[0] * 60;
      if (sum >= 60 && sum !== declared) {
        violations.push({
          rule: "A4-N12",
          severity: "p1",
          message:
            `一段标着 ${hours[0]} 小时的安排，里面几段加起来是 ${sum} 分钟（${minutes.join("+")}）—— ` +
            `差 ${Math.abs(declared - sum)} 分钟没有交代。要么改总时长，要么写清余下那一段做什么。`,
        });
      }
    }
  }

  return violations;
}

/**
 * 从违规列表提取要打回的节点号，去重并按优先级排序。
 * 优先级：先重跑靠前的节点（N0/N5 → N3 → N4 → N5）。
 */
export function backTo(violations: Violation[]): string[] {
  const nodes = new Set<string>();
  for (const v of violations) {
    const node = NODE_OF_RULE[v.rule];
    if (node) nodes.add(node);
  }
  const order = ["N0/N5", "N3", "N4", "N5"];
  return order.filter((n) => nodes.has(n));
}
