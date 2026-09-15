import type { Provenance } from "./stages";

/**
 * 给产物挂来源。空议题号直接抛：一份挂不上来源的产物流到下游，
 * 就再也查不出它是哪一次跑出来的了 —— 那比这一次跑失败更贵。
 */
export function makeProvenance(issueId: string, sessionId?: string): Provenance {
  if (!issueId) throw new Error("makeProvenance：议题号不能为空");
  return { issueId, stage: "pre_research", ...(sessionId ? { sessionId } : {}) };
}
