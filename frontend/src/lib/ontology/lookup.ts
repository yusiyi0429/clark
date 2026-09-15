/**
 * 说到一半再去取一次 —— **两个源的分派点**（开局那一次在 `context.ts`）。
 *
 * 分开的理由和门那边一样：开局那次问的是「这条议题的既有认识是什么」，这一次问的是
 * 「他刚说的这个东西，公司记过没有」。两个问题的入参、预算和失败处理都不一样。
 *
 * ## 这一支答不了「记过没有」，而这件事必须传下去
 *
 * 它取的是**公司层的语义记忆**（愿景 / Outcome / Mission / 经营原则），那一层跟问什么
 * 无关、一直都在；能回答「公司记过这条没有」的是**工作记忆**（议题 + 判断 + 共识），
 * 本体还没建到那一层。所以旧路那个「图里没有这条」的正常空结果，在这一支不会出现 ——
 * 拿一句跟公司毫无关系的话去问，它照样回一整段。
 *
 * 补救**不在这一层**：这里照实把取回来的东西交上去，由 `turn.ts` 那侧在摆给模型看的时候
 * 写清「这一段里没有具体议题的既有判断与共识」。在这里伪造一个 `not_found`（比如按某个
 * 字数阈值判它「其实没答上」）是最坏的做法：那是拿一个我们自己编的判据去回答一个上游没
 * 回答的问题，而错判的样子是「公司明明记过却说没有」。
 */
import { lookupMembers, type MemberLookup } from "@/lib/graphknowledge";

import { NarrativeClient } from "./narrative";
import { ontologySource } from "./source";

/**
 * 两支共用 `MemberLookup`，第三档 `narrative` 定在那个类型上（见它的注释）。
 *
 * 复用而不是另起一个类型：上面那扇门（`ontologyLookupForChat`）和 `turn.ts` 的
 * `renderMembers` 都按它分派，另起一个就要在两处各写一遍「这两种其实是一件事」。
 *
 * `items` 在 `narrative` 那一档**永远是空的** —— 没有短码可发，所以 `turn.ts` 那边的
 * `loaded` 集合一个都不会加，短码机检整轮不报（空集合是合法的，见 `turn.ts` 的
 * `loadedCodes` 注释）。正文走 `recall`：那一栏本来就是「随手带回来的那段话」。
 */
export type OntologyLookup = MemberLookup;

export async function lookupOntology(q: string): Promise<OntologyLookup> {
  if (ontologySource() === "graph") return lookupMembers(q);

  const r = await new NarrativeClient().narrative(q, { includeRaw: false });
  return {
    mode: "narrative",
    sent: r.sent,
    items: [],
    recall: r.text,
    /*
     * 上游那个压缩模型带上来。这一栏原来装的是图服务自己报的降级，语义是「这段话有个
     * 你该知道的来历」—— 同一个语义。摆到模型面前的那段话是它写的转写，不是图里的原文，
     * 而对谈里最容易发生的就是把这段话当成公司原话再复述一遍。
     */
    warning: r.model ? `这段叙述由上游 ${r.model} 压缩生成，不是图里的原话` : "",
  };
}
