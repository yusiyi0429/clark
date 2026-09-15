/**
 * 一轮对谈的可审计快照，以及「一次确认能不能重放出来」——规格 §8-4 与 §8-6 里
 * **机器答得了的那部分**。两个纯函数，都不开库。
 *
 * ## 这里检的是让步日志这一半，板与图那一半在 `land.test.ts`
 *
 * §8-4（任意轮的结论与判断状态、判断卡片无矛盾）和 §8-6（任意一次确认可从让步日志加
 * 证据台账完整重放）这两行都横跨两半：书面日志这一半，和候选落成板上一条、图上一条那一半。
 *
 * 板那一半有自己的实施者与自己的机检 —— `land.ts` 的摆盘加 `api.landTalkCandidate`，
 * 测试在 `land.test.ts` 第三个 describe「落库到他手上那一步为止」里。与本文件直接接壤的是
 * 其中两条：`落板 + 落图 + arms 排队，一路到他手上那一步为止` 钉住「板上那一条就是候选
 * 那一句」，`落完之后一条 trigger 都没布控；他按下确认，这时才布控` 钉住「确认只能由人
 * 按下」在这条链上的落点。
 *
 * 落上去那一条**不是被写进一个叫 draft 的数组**：板上全部条目里 `!confirmed` 的那些被
 * 过滤出来算成 `draft`（按符号名 grep `draft:` 看得到那处派生视图）。所以它是**因为还没被
 * 确认**才出现在待确认那一半 —— 照前一种说法写，下一个人会去找一个不存在的数组。
 *
 * 本文件不重复一遍那套 store 装置，**这是分工不是缺口**：同一件事有两处机检，迟早对不上，
 * 而对不上的那天没人知道该信哪一处。
 */

import { SELF_CONFIRMED } from "@/lib/agent/rules";
import { citedIds } from "./cite";
import type { DeliberationEntry } from "./point";
import { findDesync } from "./verifier";

/**
 * 把一段文字里引到的编号分成两堆：台账上真有的，和台账上根本没有的。两堆保持出现顺序。
 *
 * **两堆一趟分完，不写成两个各扫一遍的函数。** 那两个函数的差别只有一个取反，而两处不
 * 一致的症状是「引对的认得出、编的认不出」—— 那正好是判据 3 静默失效，而它失效时屏幕上
 * 什么都不会少。
 *
 * 编号从哪儿抠由 `cite.ts` 一处说了算（去重也在那边）。这里从前自带一份只认单编号的
 * 正则，而它旁边的注释恰恰论证过「放宽编号格式时只改一半」的危险 —— 它防住了同一个
 * 函数体内的一半，没看见隔壁两个文件里各有一份全量拷贝，也没看见报告层早就放宽了。
 */
function splitCited(text: string, evidenceIds: readonly string[]): { known: string[]; unknown: string[] } {
  const inLedger = new Set(evidenceIds);
  const known: string[] = [];
  const unknown: string[] = [];
  for (const id of citedIds(text)) {
    (inLedger.has(id) ? known : unknown).push(id);
  }
  return { known, unknown };
}

/** 一轮的可审计快照。`entry` 为 null = 这一轮一条日志都没有。 */
export type TurnRecord = {
  turn: number;
  reply: string;
  entry: DeliberationEntry | null;
  /**
   * 结算之后判断现在的样子。
   *
   * **调用方现在传的是整场跑完那一句**（`replay` 只交回 `finalThesis`，没有逐轮的判断），
   * 这在「判断最多动一次、动完不回头」的脚本上与逐轮的那一句恰好等价 —— 三套现成脚本
   * 都是这个形状，所以现在成立。
   *
   * **会在什么形状的脚本上出错**：某一轮 A→B、后面某一轮又 B→A 时，前一轮的快照拿到的
   * `judgement` 是 A，正好等于它自己的 `entry.before`，于是判据 2 会对一次真实的改判凭空
   * 开火。将来写出会来回改的脚本时，这里要先改成逐轮的判断（那要给 `replay` 加一栏返回值），
   * 不能只把断言放宽。
   */
  judgement: string;
};

/**
 * 这一轮的回应与结算结果有没有互相矛盾。返回空数组 = 不矛盾，每一项都是能上屏的一句话。
 *
 * 三条判据都是机械的，一条都不需要读懂语义：
 *
 * 1. **日志说这一轮没动，回应里却说这件事已经过了他。** `kind: "hold"` 且 `before === after`
 *    是「他压了、我没动」，而 `SELF_CONFIRMED`（`@/lib/agent/rules`，Task 4 已经在用同一张表）
 *    命中的是「已确认／已达成一致／据此执行」这类自称越过了那道权力转移的写法。
 *    **它认的是这一类措辞，不是所有可能的改判说法** —— 换个说法绕过去是做得到的，
 *    这一条守的是最贵的那一种矛盾（屏幕上看起来这件事已经被他确认过了），不是全部。
 * 2. **日志说动了，而结算之后判断还停在 `before`。** `concede` / `partial` 记的是一次真的
 *    改判，改完判断仍等于改判前那一句，说明这两边有一处在说假话。
 * 3. **回应里引的编号台账上没有。** 编号是编的，屏幕上却是个可以点开的东西。
 *
 * 判据 1、3 拿脚本写的回应去比**代码算出来的** `entry` 与真台账，判据 2 两边都是代码算的 ——
 * 所以三条没有一条是「拿夹具自己给的字符串去断言夹具自己给的字符串」。
 */
export function contradicts(rec: TurnRecord, evidenceIds: readonly string[]): string[] {
  const why: string[] = [];
  const e = rec.entry;

  // 判据 1：日志记的是「没动」，回应却自称这件事已经确认过了
  if (e && e.kind === "hold" && e.before === e.after && SELF_CONFIRMED.test(rec.reply)) {
    why.push(`第 ${rec.turn} 轮的让步日志记的是判断没动，回应里却说这件事已经确认了`);
  }

  // 判据 2：日志记的是「改了」，结算之后判断还停在改判前那一句
  if (e && e.kind !== "hold" && rec.judgement === e.before) {
    why.push(`第 ${rec.turn} 轮记了一次改判（${e.before} → ${e.after}），结算之后判断还停在「${e.before}」`);
  }

  // 判据 3：回应引了台账上没有的编号
  for (const id of splitCited(rec.reply, evidenceIds).unknown) {
    why.push(`第 ${rec.turn} 轮的回应引了 ${id}，台账里没有这个编号`);
  }

  return why;
}

export type ConfirmReplay = {
  steps: { turn: number; trigger: string; before: string; after: string; citedEvidence: string[] }[];
  /** 「判断这里变过，但说不出为什么」的轮号。直接用 `findDesync` 的结果，不另写一套判据。 */
  unexplained: number[];
};

/**
 * 把一次确认的形成过程从让步日志加证据台账里重放出来。
 *
 * `steps` 取日志里判断真的动过的那几条（`kind !== "hold"`）：坚持那几轮是这场对谈的一部分，
 * 但它们不构成「这一句是怎么来的」的一步 —— 重放要答的是形成过程，不是流水账。
 *
 * `unexplained` **直接调 `findDesync`**，不另写一套判据：同一个问题两套判据，迟早对不上，
 * 而它俩不一致的那天，屏幕上会同时出现「这一轮说不出为什么」和「这一轮账是平的」。
 * `nowTurn` 传日志里最大的轮号（日志为空时是 0，`findDesync` 那时本来就一条都不返回），
 * `nowJudgement` 传入参那一句 —— 于是「他确认的那一句」与「日志最后停在的那一句」对不上时，
 * 这里会照实报成说不出为什么。
 */
export function replayConfirmation(o: {
  log: readonly DeliberationEntry[];
  evidenceIds: readonly string[];
  statement: string;
}): ConfirmReplay {
  const steps = o.log
    .filter((e) => e.kind !== "hold")
    .map((e) => ({
      turn: e.turn,
      trigger: e.trigger,
      before: e.before,
      after: e.after,
      citedEvidence: splitCited(e.trigger, o.evidenceIds).known,
    }));

  const nowTurn = o.log.reduce((max, e) => (e.turn > max ? e.turn : max), 0);
  const unexplained = findDesync(o.log, {
    evidenceIds: o.evidenceIds,
    nowTurn,
    nowJudgement: o.statement,
  }).map((d) => d.turn);

  return { steps, unexplained };
}
