/**
 * 「查一下」的**作答那一半** —— 拿这一次现查回来的几条证据，就地回一段带编号的话。
 *
 * ## 它在整件事里的位置
 *
 * 一次轻量核查是三步：**取证 → 落台账 → 就地作答**。前两步一个字都不新写 ——
 * 取证是 `micro.ts` 的 `runMicroResearch`（它自己走 `a4/evidence.ts` 的
 * `gatherEvidence`），落台账是 `store.ts` 的 `landTalkEvidence`（编号重排在
 * `land.ts` 的 `landMicroEvidence` 上）。本文件只管第三步。
 *
 * 分出来一个文件，是因为第三步是这条路上**唯一一次新的模型调用**，而它的提示词有一条
 * 硬规矩要守：**编号只许从落库回来的那几条里取**。落库那一步会重排编号（现查回来的
 * 条目永远从 `E1` 起，和报告里已有的 `E1` 撞号），所以喂给模型的必须是重排之后的
 * 那几条 —— 拿重排之前的喂，他看到的 `[E1]` 指的是报告里另一条证据。
 *
 * ## 为什么不进那套 25 分钟的预算
 *
 * 深研那一轮的墙上时间上限（`a4/deadline.ts`）管的是「一轮要交一份报告」；这一次的
 * 产物是对话里的一段话，分钟级。所以这里开的 harness 不带 deadline —— 调用方
 * （`store.ts` 的 `quickCheck`）也不给。
 *
 * ## 查不到是合法结果
 *
 * 同 HP-5，也同 `micro.ts` 的口径：这一轮没查到就照实说没查到，不发这次模型调用、
 * 不抛异常。一次「外面没有材料」和一次「这条路挂了」在屏幕上必须分得开。
 */

import type { Harness } from "@/lib/agent/harness";
import type { Evidence } from "@/lib/research/ledger";

import { citedIds } from "./cite";
import { describeFound, toFound } from "./lookup";

/** 这次调用在罐头表与 trace 上的名字。假模型按它认罐头（`models/mock.ts`）。 */
export const CHECK_HINT = "talk.check";

/**
 * 作答那一次的规矩。
 *
 * 第 1 条是这条路的要害：**编号只许从下面列出的那几条里取**。它同时也是这一档存在的
 * 理由 —— 一次轻量核查换来的东西就是「这句话背后有一条能点开的证据」，编号编错了，
 * 这一档和凭记忆答没有区别。
 *
 * 第 3 条挡的是这条路上最容易长出来的赘肉：一段以「根据本次检索」开头的过渡。他要的
 * 是答案，不是这次检索的自述。
 */
export const CHECK_SYSTEM = `你在议事对话里回答他刚提的一个问题。手上只有下面这一轮现查回来的几条证据，别的一概不用。

1. 每一句事实性的话，句末带上它的台账编号，写成 [E12]。编号只能从下面列出的那几条里取，一个都不许自己编。
2. 这几条答不到的部分，直说这一轮的材料答不到，不用记忆去补。
3. 不写导语、不写「根据以上证据」这类过渡，第一句就是答案。
4. 不出现工具名、字段名、链路代号。
5. 三百字以内。`;

/**
 * 作答那一次的正文。
 *
 * 每一条的形状走 `describeFound`，与按编号查回来那一路、轮内取证那一路**共用同一份**
 * —— 三处各拼一份的表现是同一条证据在不同轮里长得不一样，而模型是靠这个形状认
 * 「口径」那一栏的（那一段的来龙去脉写在 `lookup.ts` 的 `describeFound` 上）。
 */
export function buildCheckUser(question: string, entries: readonly Evidence[]): string {
  const lines = entries.map((e) => describeFound(toFound(e)));
  return `他问的是：${question}\n\n这一轮现查回来的证据：\n\n${lines.join("\n\n")}`;
}

/** 这一次核查的结果。两个终态，不许合成一个。 */
export type CheckReply = {
  /** 要落进对话里的那段话。两个终态都有话说 —— 查不到也得说清楚是没查到。 */
  reply: string;
  /** 这段话真引到的编号，去重按出现顺序（`citedIds`）。 */
  cited: string[];
  /**
   * 引了但台账里没有的那几个号。**不改模型的正文** —— 改了之后屏幕上那段话和它
   * 真的说过的话就对不上了。调用方拿它留痕。
   */
  fabricated: string[];
};

/**
 * 这段话里引了、而这一次手上没有的那几个号。
 *
 * 它盯的是这条路唯一那条硬规矩（`CHECK_SYSTEM` 第 1 条）：编号只许从手上那几条里取。
 * 编造一个号的后果不是显示难看 —— 他点开那个号会指到报告里另一条证据，或者指不到
 * 任何东西，而那段话读起来完全像有据可查。
 *
 * **不改正文**：改了之后屏幕上那段话和它真的说过的话就对不上了，而那是更坏的一种失真。
 * 这里只把号交出来，留痕由调用方做。
 */
export function offLedger(reply: string, entries: readonly { id: string }[]): string[] {
  const known = new Set(entries.map((e) => e.id));
  return citedIds(reply).filter((id) => !known.has(id));
}

/**
 * 这一轮没查到时的那句话。
 *
 * 只报事实：没查到、发出去过哪几个问法。不写「要不要换个问法」这类替他拿主意的话 ——
 * 屏幕上那句话的作用是让他知道发生了什么。
 */
export function notFoundReply(tried: readonly string[]): CheckReply {
  const how = tried.length ? `发出去的问法：${tried.map((q) => `「${q}」`).join("")}。` : "";
  return { reply: `这一轮没查到能引的材料。${how}`.trim(), cited: [], fabricated: [] };
}

/**
 * 拿这几条证据回一段话。
 *
 * `entries` 必须是**落库之后**那几条（编号已重排），理由见文件头。一条都不给时直接
 * 走查不到那一支，不发调用 —— 一次没有证据的「带编号作答」只会得到编造的编号。
 */
export async function answerFromCheck(
  h: Harness,
  question: string,
  entries: readonly Evidence[],
): Promise<CheckReply> {
  if (entries.length === 0) return notFoundReply([question]);

  const { text } = await h.callMessages(
    `模型调用 · ${CHECK_HINT}`,
    [
      { role: "system", content: CHECK_SYSTEM },
      { role: "user", content: buildCheckUser(question, entries) },
    ],
    // `json: false` —— 这一次要的是说给他听的一段话，不是一份结构。
    { json: false, maxTokens: 1200 },
    { promptKey: CHECK_HINT, evidence: entries.length },
    CHECK_HINT,
  );

  const reply = text.trim();
  return { reply, cited: citedIds(reply), fabricated: offLedger(reply, entries) };
}
