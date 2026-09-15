import { chars, type Violation } from "@/lib/agent/rules";
import { bestTier } from "./blindspot";
import { independentGroupCount } from "./evidence-lite";
import type {
  BlindspotRuling, CardDraft, CardKind, CriticVerdict, DispositionSuggestion, EvidenceLite, ImpactProposal,
} from "./stages";

/**
 * 一张提请卡的字数预算。300 字是「他站着能读完」的量 ——
 * 提请卡的职责是让他决定要不要花时间，不是替他把事想完。
 */
export const CARD_BUDGET = 300;

/** 同一议题第二次预研出的增量卡：只说这一次多了什么，所以预算减半。 */
export const INCREMENT_BUDGET = 150;

/** 增量卡的固定开头。固定是有意的：他一眼就知道「这不是新的一张，是上次那张的续」。 */
export const INCREMENT_HEAD = "比上次多了：";

const ACTION_LABEL: Record<DispositionSuggestion["action"], string> = {
  discuss: "建议议一议",
  watch: "建议先待定",
  dismiss: "建议不看了",
};

/**
 * 机械装配提请卡。**不调模型** —— 要说的话在前面几段已经全部产出了，
 * 这一段只决定放哪几句、按什么顺序、放不下先砍谁。
 *
 * 段落按优先级排：说法 → 依据（带标签）→ 底子有多厚 → 处置建议 → 批判结论。
 * 装不下的那一段**跳过，继续试后面的** —— 不是遇到第一段装不下就收工。
 * 后面那几段一句比一句短，前面挤不进去的时候后面往往还放得下，
 * 而「批判没过」这种最短的话恰恰最不该被前面一段长文案挤掉。
 *
 * **不许把一段截断**：截一半的依据会让标签跟正文对不上，
 * 而标签是他分「哪句有出处、哪句是模型的先验」的唯一凭据。
 *
 * **不收 `searchless`**：它是台账为空的投影，收进来就等于给同一件事开两个真源，
 * 而两个方向的口径迟早会不一致。「这一轮没有外部核验」的判据只认台账。
 */
export function assembleCard(o: {
  kind: CardKind;
  impact: ImpactProposal;
  disposition: DispositionSuggestion;
  blindspot: BlindspotRuling;
  evidence: readonly EvidenceLite[];
  critic: CriticVerdict;
}): CardDraft {
  const budget = o.kind === "increment" ? INCREMENT_BUDGET : CARD_BUDGET;
  const groups = independentGroupCount(o.evidence);
  // 取最高档一律用 `bestTier`，**不在这里再写一份 `reduce`**。
  // 靠 `a.tier <= b.tier` 的字典序今天和档次序结果一样 —— 那是巧合。
  // 档位以后多一档、或者改成 `A+` 这类写法，字典序就不再等于档次序，
  // 而两处里只有 `bestTier` 有测试。
  const best = bestTier(o.evidence);

  const basisLine = o.impact.basis
    .map((b) => (b.startsWith("[P]") ? b : `[${b}] ${o.evidence.find((e) => e.id === b)?.claim ?? ""}`.trim()))
    .join("；");

  // 「这一轮没有外部核验」只按台账判：一条都没入账才这么写。
  // 不另收一个布尔入参，那会让同一件事有两个说法。
  const backing = o.evidence.length === 0
    ? "这一轮没有外部核验（一条外部证据都没入账）"
    : `底子：${best} 档，${groups} 组独立源`;

  const criticLine = o.critic.pass
    ? null
    : `${o.critic.modelSlot === null ? "机检没过" : "批判没过"}：${o.critic.why.join("；")}`;

  const paras = [
    o.kind === "increment" ? `${INCREMENT_HEAD}${o.impact.statement}` : o.impact.statement,
    basisLine ? `依据：${basisLine}` : null,
    backing,
    `${ACTION_LABEL[o.disposition.action]} —— ${o.disposition.why}`,
    criticLine,
  ].filter((x): x is string => Boolean(x));

  const body: string[] = [];
  for (const p of paras) {
    const next = [...body, p].join("\n\n");
    // 第一段无论多长都要放：放不下也得让他看见说法本身，超预算由 A3-14 报出来。
    // 后面的段落装不下就 `continue`（**不是 `break`**）—— 跳过这一段，继续试更短的下一段。
    if (body.length > 0 && chars(next) > budget) continue;
    body.push(p);
  }

  const text = body.join("\n\n");
  const headline = o.impact.targetRef
    ? `${o.impact.targetRef.id}｜${o.impact.targetRef.text}`
    : o.blindspot.isBlindspot
      ? "这件事挨着你在管的事，但没在你的监控清单上"
      : "这一轮没撞上任何既有判断";

  return { kind: o.kind, headline, body: text, basis: [...o.impact.basis], chars: chars(text) };
}

/**
 * 卡片的机检。四条新规则，p0/p1 的语义与 `validate.ts` 那一批完全一致 ——
 * `run.ts` 会把这里的结果并进 `validatePreResearch` 的返回里，p0 参与返修判定。
 */
export function checkCard(card: CardDraft): Violation[] {
  const v: Violation[] = [];
  const budget = card.kind === "increment" ? INCREMENT_BUDGET : CARD_BUDGET;

  if (card.chars > budget) {
    v.push({
      rule: "A3-14",
      severity: "p0",
      message: `提请卡 ${card.chars} 字，超了 ${budget} 字的预算 —— 装配已经砍到只剩说法本身，说明说法自己就太长`,
    });
  }

  for (const b of card.basis) {
    // 先验依据要**逐条**查，查的是这一条的整句原文，不是「[P] 出现过就算」。
    // 只认标签的话，两条先验只上去一条也一样绿 —— 而这条规则的全部意义
    // 就是「掉了的那条要被查出来」。装配那边 `[P]` 项是原样上卡的，所以整句能对得上。
    const needle = b.startsWith("[P]") ? b : `[${b}]`;
    if (!card.body.includes(needle)) {
      v.push({
        rule: "A3-15",
        severity: "p0",
        message: `依据 ${b} 没能带着标签上卡 —— 卡上分不出哪句有出处、哪句是先验`,
      });
    }
  }

  if (!/[ABCD] 档/.test(card.body) && !card.body.includes("没有外部核验")) {
    v.push({
      rule: "A3-16",
      severity: "p1",
      message: "卡上既没写档位也没说这一轮没有外部核验 —— 他看不出这份判断有多少底",
    });
  }

  if (card.kind === "increment" && !card.body.startsWith(INCREMENT_HEAD)) {
    v.push({
      rule: "A3-17",
      severity: "p0",
      message: `增量卡的第一句要以「${INCREMENT_HEAD}」开头 —— 否则他会以为这是一张新的卡`,
    });
  }

  return v;
}
