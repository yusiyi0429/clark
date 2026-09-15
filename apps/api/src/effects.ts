import type { IssueReceiptRow, IssueRow } from "./issues.js";

export type EffectRevokeOutcome =
  | { ok: true; receipts: IssueReceiptRow[] }
  | { ok: false; code: string; message: string };

/**
 * 统一 effect revoker：所有撤回都必须经过这里，调用方不能直接改 Receipt/Outcome。
 * 本票只实现 Issue decision Receipt；外部不可逆效果或无对应 revoker 的 effectRef
 * 必须返回失败，不得声称已恢复。
 */
export function revokeEffect(
  row: IssueRow,
  effectRef: string,
  fingerprint: string,
  { reason, at = new Date().toISOString() }: { reason?: string; at?: string } = {},
): EffectRevokeOutcome {
  const match = /^issue:([^:]+):decision:([^:]+)$/.exec(effectRef);
  if (match && match[1] === row.id) {
    const receiptId = match[2];
    const receipt = row.receipts.find((candidate) => candidate.id === receiptId);
    if (!receipt) return { ok: false, code: "RECEIPT_NOT_FOUND", message: "Receipt 不存在" };
    if (receipt.revokedAt) {
      // 已撤回：同 fingerprint 重放不产生第二个 effect；不同 fingerprint 也不再改变状态
      return { ok: true, receipts: row.receipts };
    }
    const receipts = row.receipts.map((candidate) =>
      candidate.id === receiptId
        ? { ...candidate, revokedAt: at, revokedFingerprint: fingerprint, revokeReason: reason }
        : candidate,
    );
    return { ok: true, receipts };
  }
  if (effectRef.startsWith("meeting:")) {
    return {
      ok: false,
      code: "EFFECT_REVOKER_PENDING",
      message: "Meeting item 撤回由 MeetingOutcome revoker 处理（Ticket 11），本票不代为恢复",
    };
  }
  return { ok: false, code: "UNKNOWN_EFFECT", message: "未知 effectRef，无法撤回" };
}
