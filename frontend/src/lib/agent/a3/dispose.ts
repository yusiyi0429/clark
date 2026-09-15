import { independentGroupCount } from "./evidence-lite";
import { MIN_INDEPENDENT_SOURCES } from "./impact";
import { proposeTrigger, TRIGGER_CONDITION_MAX } from "./trigger";
import type {
  BlindspotRuling, DispositionSuggestion, EvidenceLite, ImpactProposal, Provenance, TargetHit,
} from "./stages";

/**
 * 方向相反的信号的加权倍数。
 *
 * 加权而不是降权 —— 这是这一层最容易做反的地方：一条跟既有判断相反的信号，
 * 在任何按「与现有认知的一致度」排序的系统里都会自然沉底，而它恰恰是最该被看到的那条。
 * 一个只顺着自己假设走的系统，最先丢掉的就是这一条。系统的职责包括把反证推到他面前。
 */
export const CONTRA_WEIGHT = 2;

/** 盲区的加权倍数。他没在看的东西不该排在末尾。 */
export const BLINDSPOT_WEIGHT = 1.5;

/**
 * 提请卡的排序分数。**只用于排序，不参与任何分流判定** ——
 * 分流由 `suggestDisposition` 的机械规则定，两件事混在一个数里就都说不清了。
 *
 * 基数取独立源组数（这是「强度」唯一可核的度量），再乘方向与盲区两个权。
 * 乘而不是加：加权只是把相反方向往前挪一档，强度更高的一条照样排在前面 ——
 * 反确认要的是不被埋掉，不是一律插队。
 */
export function cardPriority(o: {
  hits: readonly TargetHit[];
  blindspot: BlindspotRuling;
  evidence: readonly EvidenceLite[];
}): number {
  const strength = Math.max(1, independentGroupCount(o.evidence));
  const contra = o.hits.some((x) => x.match === "challenges") ? CONTRA_WEIGHT : 1;
  const blind = o.blindspot.isBlindspot ? BLINDSPOT_WEIGHT : 1;
  return strength * contra * blind;
}

/**
 * 三键处置**建议**。
 *
 * 名字里那个「建议」是全部要点：三键真正按下去的地方是 `api.disposeCard`，
 * 那是他的手。这里算出来的只是屏幕上默认高亮哪一个键、以及待定那一档会带上
 * 什么监控条件。一次模型都不调 —— 分流的依据（要不要改判断、有几组独立源、
 * 是不是盲区、量级够不够）全部已经是机械结论了，再问一次模型只会引入一次不确定。
 */
export function suggestDisposition(o: {
  impact: ImpactProposal;
  blindspot: BlindspotRuling;
  evidence: readonly EvidenceLite[];
  nowIso: string;
  provenance: Provenance;
  /** 这一轮的靶点命中。不给按空数组 —— 只用于那道「方向相反不许扔」的硬拦。 */
  hits?: readonly TargetHit[];
}): DispositionSuggestion {
  /*
   * 硬拦：方向相反的信号不许判成「不看了」。
   *
   * 这条拦的是确认偏误最贵的那一种表现 —— 一条动摇既有判断的信号被判成不相干，
   * 从此他再也看不到它。量级判得不够就先待定（盯着），不是扔掉。
   */
  const contra = (o.hits ?? []).some((x) => x.match === "challenges");
  const groups = independentGroupCount(o.evidence);
  const wantsChange = o.impact.proposalType === "adjustJudgment" || o.impact.proposalType === "reopenDecision";
  const worthless = o.impact.impactType === "outOfScope" || o.blindspot.magnitude === "immaterial";

  if (worthless && !wantsChange && !contra) {
    return {
      action: "dismiss",
      why:
        o.impact.impactType === "outOfScope"
          ? "跟他现在的任何判断都不相干"
          : "量级不够，占不上他的时间",
      trigger: null,
    };
  }

  if (wantsChange && groups >= MIN_INDEPENDENT_SOURCES) {
    return {
      action: "discuss",
      why: `要动既有判断，而且有 ${groups} 组独立源撑着 —— 这一条值得他现在看`,
      trigger: null,
    };
  }

  // 剩下的一律建议待定：有东西，但还不够让他现在停下来。
  const why = wantsChange
    ? `要动既有判断，但只有 ${groups} 组独立源 —— 先盯着，命中了再请他看`
    : contra
      ? "这条信号跟既有判断方向相反，量级还看不清 —— 方向相反的不扔，先盯着"
      : "这件事挨着他在管的事，但这一轮还提不出要动什么";

  if (!o.impact.targetRef) {
    return { action: "watch", why: `${why}（挂不到具体靶点上，这一轮不设监控条件）`, trigger: null };
  }

  return {
    action: "watch",
    why,
    trigger: proposeTrigger({
      seq: 1,
      condition: o.impact.statement.slice(0, TRIGGER_CONDITION_MAX),
      targetRef: o.impact.targetRef,
      source: "watch",
      onFire: "proposeDiscuss",
      nowIso: o.nowIso,
      provenance: o.provenance,
    }),
  };
}
