/**
 * 候选判断的独立复核。
 *
 * 复核分两半：**机检在前**（对不上的轮次机械列出来、独立源不足两组直接拦），
 * 机检过了才叫模型。这样做不只是省钱：它让「构造用例打回率 100%」成为一条
 * 机械保证，而不是对模型的期望。
 */

import type { Harness } from "@/lib/agent/harness";
import { citedIds } from "./cite";
import type { DeliberationEntry, TalkPoint } from "./point";
import { isTrigger } from "./point";
import type { Evidence } from "@/lib/research/ledger";
import type { Slot } from "@/lib/models/slots";
import { resolveModel, areIndependent } from "@/lib/models/slots";
import { parseJson } from "@/lib/agent/json";

/**
 * 复核提示词。给一个未参与前序对话的模型评审候选判断。
 *
 * 与规格 §6 原文的五处不同：
 * 1. `Point 当前状态` → `判断状态`（内部字段名不进提示词）
 * 2. `deliberation_log` → `让步日志`（同上，而且下划线标识符会被误认为 JSON 键）
 * 3. 删掉「轨迹同步性」这个自造词，判据本身已经写清楚了
 * 4. 补充了「证据以 [E{n}] 标识」，因为 `findDesync` 判据1 要查这个格式，提示词必须说清
 * 5. 补充了输出格式一节，说清字段名与类型 —— 提示词与解析器之间要有契约
 */
export const VERIFIER_PROMPT = `你没有参与之前的对话，独立评审以下候选判断。

输入：
- 判断状态与候选判断
- 证据台账（含各证据等级与共源标记，证据以 [E{n}] 标识）
- 让步日志（每次改判及其声明的触发物）

评审三件事：
1. 候选判断是否被台账内的证据支持？强度档位是否与源独立性匹配
   （沿用 Part1 §2.2：强判断 ≥2 独立源）？
2. 逐条核对让步日志：每次改判声明的触发物（论证/证据）是否
   真实存在且足以支撑该次改变？
3. 列出所有"判断方向变了、但证据集与论证集没有对应新增"的轮次
   ——这些是疑似压力性让步。

输出：通过 / 打回。打回必须指明是哪一次改判缺乏依据，退回该判断的
before 状态重新议。

## 输出格式

只输出一个 JSON 对象，包含两个字段：
- \`pass\`（布尔值）：true 表示通过，false 表示打回
- \`why\`（字符串数组）：每项一句能上屏的理由。通过时说明依据，打回时说明问题`;

/** 一条对不上的改判。`why` 要能上屏 —— 「这一轮为什么被点出来」得答得出。 */
export type Desync = { turn: number; before: string; after: string; why: string };

/**
 * 机械地找出「判断动了但账对不上」的轮次。
 *
 * **它检的是这串日志的顺序与交叉引用，不是单条日志本身。** 单条的校验已经在
 * `checkEntry` 里做完了（空 trigger、拒绝表、kind 与 before/after 一致性），
 * 而进得了库的每一条都过了 `checkEntry`（`recordDeliberationEntry` 拒就抛）。
 * 所以这里再写一遍「trigger 是不是拒绝表上的话」等于写一条永远为空的分支。
 *
 * 三种真会发生的对不上：
 *   1. 改判声称的触发物引了一个 `[E{n}]`，而台账里没有这个编号（编号是编的）。
 *      这一条在生产路径上由 F2 那条路直接喂进来（trigger 从本轮回应里抠出的 [E{n}]）。
 *   2. 第 k 条的 `after` 与第 k+1 条的 `before` 不接（中间有一次没记的改判）。
 *   3. 判断现在的样子与最后一条日志的 `after` 不一样，而这一轮**一条日志都没有**
 *      （改判发生了，日志整条缺席 —— 这是最容易出的一种，因为它不需要谁写错，
 *      只需要谁忘了写）。
 *
 * **判据 2/3 对 settle 自己写的条目恒不开火**，因为 `before` 按构造等于前一条的 `after`。
 * 它们是 `findDesync` 作为纯函数的保证（调用方可以喂任何数组进来，Task 14 的重放正是这么用的）。
 *
 * **生产路径上活着的是判据 1（编号是编的）与 settle 自己构造的那一条**：改判但指不出编号、
 * 或 `checkEntry` 拒了日志时，settle 不 return，而是构造一条 desync 强制进复核 → 机检打回。
 *
 * 「进这一轮之前判断是什么样子」现在真存下来了（`TalkPoint.settledJudgement`，终评裁的），
 * 于是**「这一轮改判没落成日志」不再会被下一轮洗掉**：下一轮的 `before` 取的是那一栏，
 * 于是**下一条真的落成的日志与前一条接不上**，判据 2 把那次缺席报出来（它一直留在
 * 日志里，此后每一次复核都会再报一次）。
 *
 * 仍然检不出的是「某一轮的结算整轮没跑」（那一栏也没写成）—— 那是另一件事，还欠着。
 */
export function findDesync(
  log: readonly DeliberationEntry[],
  o: {
    /** 台账里真在的证据编号。 */
    evidenceIds: readonly string[];
    /** 刚结算完的这一轮轮号。 */
    nowTurn: number;
    /** 判断现在的样子（`TalkPoint.candidate?.statement ?? thesis`）。 */
    nowJudgement: string;
  },
): Desync[] {
  const result: Desync[] = [];
  const eSet = new Set(o.evidenceIds);

  for (let i = 0; i < log.length; i++) {
    const entry = log[i];

    // 检查1: 引用的证据编号台账里要有
    // 抠编号只有 `cite.ts` 一处（`[E3]` / `[E3, E7]` / `[E3][E7]` 三种都认）。这里从前
    // 自带一份只认单编号的正则，比报告层产出的形状窄一档 —— 而这道判据正是这一侧唯一
    // 活着的反谄媚机检，窄一档就等于对 `[E9, E10]` 这种编造的引用静默放行。
    for (const id of citedIds(entry.trigger)) {
      if (!eSet.has(id)) {
        result.push({
          turn: entry.turn,
          before: entry.before,
          after: entry.after,
          why: `触发物引用了 ${id}，但台账里没有这个编号`,
        });
      }
    }

    // 检查2: 前后相接性（不是第一条时才检查）
    if (i > 0) {
      const prev = log[i - 1];
      if (prev.after !== entry.before) {
        result.push({
          turn: entry.turn,
          before: entry.before,
          after: entry.after,
          why: `第 ${entry.turn} 轮的 before「${entry.before}」与前一条的 after「${prev.after}」接不上`,
        });
      }
    }

    // 兜底检查：这里再调用 isTrigger 是为了应对从其他地方传进来的日志数组
    // （比如将来从快照恢复的、或者别处拼的）。这不是本函数的机制，只是一道防御。
    // 正常情况下进得了库的日志都过了 checkEntry，这一条不会被触发。
    if (entry.before !== entry.after && !isTrigger(entry.trigger)) {
      result.push({
        turn: entry.turn,
        before: entry.before,
        after: entry.after,
        why: `判断变了但 trigger 指不出可核查的论证或证据`,
      });
    }
  }

  // 检查3: 最后一条日志的 after 要和当前判断对得上
  if (log.length > 0) {
    const last = log[log.length - 1];
    if (last.after !== o.nowJudgement) {
      result.push({
        turn: o.nowTurn,
        before: last.after,
        after: o.nowJudgement,
        why: `第 ${o.nowTurn} 轮判断变成「${o.nowJudgement}」，但让步日志里没有这一次改判`,
      });
    }
  }

  return result;
}

export type Review = {
  pass: boolean;
  /** 打回时退回哪一句（那次改判的 `before`）。 */
  rollbackTo?: string;
  why: string[];
  /**
   * 这一次复核用的是哪个槽位；`null` = 机检就定了，没叫模型。
   *
   * 这一栏存在的理由是**它是唯一可断言的那一半**：假模型返回 `emptyUsage()`
   * （`src/lib/models/complete.ts:115-119`），`Harness.trace` 是私有的（`harness.ts:138`），
   * 所以离线测试没有别的办法证明「机检能定的事没花一次模型调用」，也没有别的办法
   * 证明「复核用的不是主对谈那个槽位」。它同时是 trace 上要答的一句话。
   */
  modelSlot: Slot | null;
};

/**
 * 把复核器返回的原样东西截一小段写进 `why`。
 *
 * **不能直接 `JSON.stringify(x).slice(...)`**：`JSON.stringify(undefined)` 返回的是
 * `undefined` 这个值本身（不是字符串），`.slice` 当场抛 `TypeError` —— 而这个函数存在的
 * 全部理由就是「不许抛异常把整个结算带崩」。今天 `parseJson` 造不出 `undefined`，所以
 * 这是一条防御，不是一次修 bug；但这一段是那条硬承诺的最后一道，防御摆在这里最便宜。
 */
const peek = (x: unknown): string => String(JSON.stringify(x) ?? x).slice(0, 80);

/**
 * 校验复核模型的返回。形状不合法一律判成打回并留痕。
 *
 * 照这一层已有的姿态（`checkProposal` / `checkEntry`）：整份拒 + 留痕，不过滤、不猜。
 * `pass` 不是布尔、或 `why` 不是字符串数组 → 返回打回，`why` 里写清复核器返回的形状
 * 读不懂并带上原文的前若干字。**不许 fallback 成通过**，也不许抛异常把整个结算带崩。
 */
export function checkVerdict(raw: unknown, reviewSlot: Slot): { ok: true; value: { pass: boolean; why: string[] } } | { ok: false; review: Review } {
  if (typeof raw !== "object" || raw === null) {
    return {
      ok: false,
      review: {
        pass: false,
        why: [`复核器返回的不是对象，是 ${typeof raw}。原文前 80 字：${peek(raw)}`],
        modelSlot: reviewSlot,
      },
    };
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.pass !== "boolean") {
    return {
      ok: false,
      review: {
        pass: false,
        why: [
          `复核器返回的 pass 字段不是布尔值，是 ${typeof obj.pass}`,
          `原文前 80 字：${peek(raw)}`,
        ],
        modelSlot: reviewSlot,
      },
    };
  }

  if (!Array.isArray(obj.why)) {
    return {
      ok: false,
      review: {
        pass: false,
        why: [
          `复核器返回的 why 字段不是数组，是 ${typeof obj.why}`,
          `原文前 80 字：${peek(raw)}`,
        ],
        modelSlot: reviewSlot,
      },
    };
  }

  if (!obj.why.every((s) => typeof s === "string")) {
    return {
      ok: false,
      review: {
        pass: false,
        why: [
          `复核器返回的 why 数组里有非字符串元素`,
          `原文前 80 字：${peek(raw)}`,
        ],
        modelSlot: reviewSlot,
      },
    };
  }

  return {
    ok: true,
    value: { pass: obj.pass, why: obj.why as string[] },
  };
}

/**
 * 复核候选判断。三个输入对应规格 §6 的三行「输入：」，一个不少。
 *
 * 机检在前：desync 非空或独立源不足两组时直接打回，不叫模型。
 * 机检过了才调用异系模型（与主对谈不同槽位）做规格 §6 里那半需要读懂论证的判断。
 */
export async function reviewCandidate(
  h: Harness,
  input: {
    point: TalkPoint;
    ledger: readonly Evidence[];
    log: readonly DeliberationEntry[];
    desync: readonly Desync[];
  },
): Promise<Review> {
  // 机检第一道：有对不上的轮次 → 直接打回
  if (input.desync.length > 0) {
    const first = input.desync[0];
    return {
      pass: false,
      rollbackTo: first.before,
      why: [first.why, ...input.desync.slice(1).map((d) => d.why)],
      modelSlot: null,
    };
  }

  // 机检第二道：独立源不足两组 → 直接打回
  if (input.point.candidate) {
    const groups = new Set(input.ledger.map((e) => e.independenceGroup));
    if (groups.size < 2) {
      /*
       * 这句话上屏，所以它说的必须就是它检的那件事：检的是**整份台账**有几组独立源，
       * 不是「支撑这条候选的那几条证据有几组」。今天这是个可接受的机械代理（台账整份
       * 撑不起两组，这条候选更撑不起），但上屏那句话不许说成后者 —— 他读到「支撑这条
       * 候选的只有一组」会去翻那条候选的依据，而机检根本没看依据。
       */
      return {
        pass: false,
        why: [
          `这份台账只有 ${groups.size} 组独立源，撑不起一条强判断`,
          ...(groups.size === 1 ? [`仅有的一组是：${[...groups][0]}`] : []),
        ],
        modelSlot: null,
      };
    }
  }

  // 机检通过，叫模型 —— 异系槽位
  const reviewSlot: Slot = h.slot === "pro" ? "alt" : "pro";

  // 检查对侧槽位是否解析出来了；如果两边是同一个 family，记一条 note 提醒运维
  const mainConfig = resolveModel(h.slot);
  const reviewConfig = resolveModel(reviewSlot);
  if (mainConfig && reviewConfig && !areIndependent(mainConfig, reviewConfig)) {
    h.note("异系复核变同系", {
      mainSlot: h.slot,
      mainFamily: mainConfig.family,
      reviewSlot,
      reviewFamily: reviewConfig.family,
      note: "两边解出的是同一个 family —— 这一次复核其实不异系",
    });
  }

  // 将 independenceGroup 映射为不透明组号（甲/乙/丙…）
  // 只让模型看见「这几条同源、那几条不同源」，不暴露内部标识（如 src:E7）
  const groupMap = new Map<string, string>();
  const groupLabels = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];
  let groupIndex = 0;
  for (const e of input.ledger) {
    if (!groupMap.has(e.independenceGroup)) {
      groupMap.set(e.independenceGroup, groupLabels[groupIndex % groupLabels.length] + (groupIndex >= groupLabels.length ? Math.floor(groupIndex / groupLabels.length) : ""));
      groupIndex++;
    }
  }

  // 拼 messages
  const systemMsg = VERIFIER_PROMPT;
  const userMsg = `## 判断状态
论点：${input.point.thesis}
已积累的说法：${input.point.statements.join("；")}
候选判断：${input.point.candidate ? `${input.point.candidate.statement}（依据：${input.point.candidate.basis}）` : "无"}

## 证据台账
${input.ledger.map((e) => `- [${e.id}] ${e.claim}（来源：${e.sourceDomain}，等级：${e.sourceTier}，组：${groupMap.get(e.independenceGroup)}）`).join("\n")}

## 让步日志
${input.log.map((e) => `第 ${e.turn} 轮：${e.before} → ${e.after}（触发：${e.trigger}）`).join("\n")}`;

  // 调用模型，罐头键 talk.verify
  const r = await h.callMessages(
    "复核候选判断",
    [
      { role: "system", content: systemMsg },
      { role: "user", content: userMsg },
    ],
    { slot: reviewSlot },
    { reviewSlot, mainSlot: h.slot },
    "talk.verify"
  );

  // 解析返回
  let parsed: unknown;
  try {
    parsed = parseJson<unknown>(r.text);
  } catch {
    return {
      pass: false,
      why: ["复核器返回的不是合法 JSON"],
      modelSlot: reviewSlot,
    };
  }

  // 校验形状
  const checked = checkVerdict(parsed, reviewSlot);
  if (!checked.ok) {
    return checked.review;
  }

  return {
    pass: checked.value.pass,
    ...(checked.value.pass ? {} : { rollbackTo: input.point.candidate?.statement ?? input.point.thesis }),
    why: checked.value.why,
    modelSlot: reviewSlot,
  };
}
