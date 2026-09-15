import type { IssueId, ViewId } from './model';

export type HeavyNoticeId = 'preflight-product' | 'preflight-workshop' | 'monthly';
export type DecisionReceipt = { issueId: IssueId; status: 'decided' | 'deferred'; summary: string };
export type DecisionRecords = Partial<Record<IssueId, DecisionReceipt>>;
export function readDecisions(raw: string | null): DecisionRecords {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const valid: DecisionRecords = {};
    for (const id of ['capacity', 'growth', 'hub', 'voice', 'payment', 'participation'] as IssueId[]) {
      const item = (parsed as Record<string, unknown>)[id];
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (record.issueId === id && (record.status === 'decided' || record.status === 'deferred') && typeof record.summary === 'string' && record.summary.trim()) {
        valid[id] = { issueId: id, status: record.status, summary: record.summary };
      }
    }
    return valid;
  } catch { return {}; }
}
export type DecisionMeta = { urgency: 'red' | 'yellow' | 'gray'; battlefieldIds: ViewId[]; campaignId?: string; reason?: string };

/** Demonstration routing and urgency, not live company commitments or deadlines. */
export const decisionMeta: Record<IssueId, DecisionMeta> = {
  capacity: { urgency: 'red', battlefieldIds: ['lighthouse', 'tokenops'], reason: '交付优先级未明确，两边的投入安排无法定稿' },
  growth: { urgency: 'yellow', battlefieldIds: ['lighthouse', 'tokenops'] },
  hub: { urgency: 'gray', battlefieldIds: ['tokenops'] },
  voice: { urgency: 'red', battlefieldIds: ['lighthouse'], campaignId: 'ceo', reason: '首次交付范围未确认，客户承诺无法定稿' },
  payment: { urgency: 'yellow', battlefieldIds: ['lighthouse'], campaignId: 'ceo' },
  participation: { urgency: 'gray', battlefieldIds: ['lighthouse'], campaignId: 'dri' },
};
