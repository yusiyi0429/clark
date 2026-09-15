import type { SourceTier } from "@/lib/research/ledger";
import { bigramOverlap } from "@/lib/agent/overlap";
import { ALIAS_MIN } from "./targets";
import type { BlindspotRuling, EntityRef, EvidenceLite, Magnitude, Proximity, TargetHit } from "./stages";

/**
 * 盲区要过的最低源档。B 档以下（C 是二手转述、D 是溯不到源）撑不起
 * 「这件事他没在看但该看」这句话 —— 那句话一旦说出口就要花掉他的注意力。
 */
export const TIER_FLOOR: SourceTier = "B";

/**
 * 「挨着」的最大跳数。本体图上的跳数今天算不出来（GraphKnowledge 只答得出
 * 成员归属，答不出跳数），所以 `hops` 常常是 `null` —— 那时接近度退回靶点命中
 * 这一条判据。这个常量留着，等图那边给得出跳数时它就是那道门槛。
 */
export const PROXIMITY_MAX_HOPS = 2;

const ORDER: Record<SourceTier, number> = { A: 3, B: 2, C: 1, D: 0 };

export function tierAtLeast(t: SourceTier | null, floor: SourceTier): boolean {
  return t !== null && ORDER[t] >= ORDER[floor];
}

/** 台账里最高的那一档。**空台账回 `null` 而不是 `"D"`** —— 没有和最差是两件事。 */
export function bestTier(list: readonly EvidenceLite[]): SourceTier | null {
  let best: SourceTier | null = null;
  for (const e of list) if (!best || ORDER[e.tier] > ORDER[best]) best = e.tier;
  return best;
}

/**
 * 盲区三判据。三条全部机械可判，所以这一段一次模型都不调。
 *
 * 「已经在看」不是盲区，这一点容易写反：盲区的定义是**近、可信、够大，而他没在看**。
 * 已经在监控清单上的东西命中了，那是监控正常工作，不是发现盲区。
 */
export function ruleBlindspot(o: {
  entities: readonly EntityRef[];
  hits: readonly TargetHit[];
  evidence: readonly EvidenceLite[];
  /** 他此刻在看的东西（`sensorTargets()` 的文本 + 监控焦点）。 */
  watched: readonly string[];
  magnitude: Magnitude;
}): BlindspotRuling {
  const why: string[] = [];

  const watchedHit = o.entities.find((e) =>
    o.watched.some((w) => bigramOverlap(e.name, w) >= ALIAS_MIN),
  );
  const nearest = o.hits.find((x) => x.hops !== null) ?? o.hits[0];

  let proximity: Proximity;
  if (watchedHit) {
    proximity = "in_watchlist";
    why.push(`「${watchedHit.name}」已经在看了 —— 这是监控命中，不是盲区`);
  } else if (nearest) {
    proximity = "adjacent";
    why.push(
      nearest.hops === null
        ? `撞上了 ${nearest.target.id}（${nearest.match}），本体图上的跳数这一轮算不出来`
        : `撞上了 ${nearest.target.id}（${nearest.match}），本体图上 ${nearest.hops} 跳`,
    );
  } else {
    proximity = "far";
    why.push("一条既有判断都对不上 —— 离他现在关心的事太远");
  }

  const credibility = bestTier(o.evidence);
  if (credibility === null) why.push("这一轮没有外部证据可依");
  else if (tierAtLeast(credibility, TIER_FLOOR)) why.push(`台账里最高一档是 ${credibility} 档，到得了 ${TIER_FLOOR} 档这条线`);
  else why.push(`台账里最高一档只有 ${credibility} 档，撑不起一句「他该看这个」`);

  if (o.magnitude === "material") why.push("量级够大，值得他花时间");
  else if (o.magnitude === "immaterial") why.push("量级不够，不值得占他的时间");
  else why.push("材料不足以判断量级");

  return {
    isBlindspot: proximity === "adjacent" && tierAtLeast(credibility, TIER_FLOOR) && o.magnitude === "material",
    proximity,
    hops: nearest?.hops ?? null,
    credibility,
    magnitude: o.magnitude,
    why,
  };
}
