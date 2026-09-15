import type { Provenance, TargetRef, TriggerOnFire, TriggerProposal, TriggerSource } from "./stages";

/**
 * 监控条件的默认存活期。90 天不是拍的：一条 90 天都没命中的监控条件，
 * 要么当初的判断已经不成立，要么这个条件核不出来 —— 两种都该让他重新看一眼，
 * 而不是让它无声地挂在表上。
 */
export const TRIGGER_TTL_DAYS = 90;

/** 条件要上屏，也要能被人一眼核对「这句话算不算命中」。80 字约两行。 */
export const TRIGGER_CONDITION_MAX = 80;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 造一条触发器**提案**。
 *
 * 名字里那个「提案」是全部要点：这个函数的返回值 `status` 恒为 `proposed`，
 * 没有参数能改它。转 `active` 只发生在人按下待定那一下（`api.disposeCard` 的
 * watch 分支），布控（`ReopenTrigger.armed`）仍然只发生在他按确认那一下。
 */
export function proposeTrigger(o: {
  seq: number;
  condition: string;
  targetRef: TargetRef;
  source: TriggerSource;
  onFire: TriggerOnFire;
  nowIso: string;
  ttlDays?: number;
  provenance: Provenance;
}): TriggerProposal {
  const condition = o.condition.trim();
  if (!condition || condition.length > TRIGGER_CONDITION_MAX) {
    throw new Error(`proposeTrigger：监控条件要 1–${TRIGGER_CONDITION_MAX} 字，当前 ${condition.length} 字`);
  }
  const expiresAt = new Date(new Date(o.nowIso).getTime() + (o.ttlDays ?? TRIGGER_TTL_DAYS) * DAY_MS).toISOString();
  return {
    id: `TG-${o.provenance.issueId}-${o.seq}`,
    condition,
    targetRef: o.targetRef,
    source: o.source,
    onFire: o.onFire,
    expiresAt,
    status: "proposed",
    provenance: o.provenance,
  };
}

/**
 * 到期清扫。`fired` 是终态不动它 —— 已经开过火的那条是账，不是待办。
 * `expired` 里回的是被清掉的编号，调用方要拿它上屏（清扫也要记账）。
 */
export function expireTriggers(
  list: readonly TriggerProposal[],
  nowIso: string,
): { next: TriggerProposal[]; expired: string[] } {
  const now = new Date(nowIso).getTime();
  const expired: string[] = [];
  const next = list.map((t) => {
    if (t.status === "fired" || t.status === "expired") return t;
    if (new Date(t.expiresAt).getTime() > now) return t;
    expired.push(t.id);
    return { ...t, status: "expired" as const };
  });
  return { next, expired };
}
