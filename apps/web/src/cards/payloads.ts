import type { TCapabilityCardPayload, TMeetingCardPayload, TMissionCardPayload, TMonthlyPlanCardPayload, TBattlefieldCardPayload } from "@warmap/contracts";
import type { Card } from "@/lib/api/client";

export type IssueLocation =
  | { level: "company"; relatedBattlefieldIds: string[] }
  | { level: "battlefield"; battlefieldId: string }
  | { level: "capability"; capabilityId: string };

export type IssueUrgency = { level: "red" | "yellow" | "gray"; reason?: string; decisionBy?: string };

export type ResearchDoc = {
  summary: string;
  options: { id: string; label: string; consequences: string[] }[];
  evidence: { quote: string; sourceTitle: string; sourceUrl?: string }[];
  unknowns: string[];
  sources: { title: string; url: string }[];
};

export type IssuePayload = {
  origin: "radar" | "dri" | "ceo";
  originRef: unknown;
  status: "pending" | "decided" | "dismissed";
  location: IssueLocation;
  urgency: IssueUrgency;
  research: {
    status: "pending" | "running" | "ready" | "failed";
    pendingSince?: string;
    runId?: string | null;
    error?: { code: string; message: string; at: string } | null;
    doc?: ResearchDoc;
  };
  receipts: {
    id: string;
    actionType: string;
    effectRef: string;
    decisionText: string;
    optionId?: string;
    researchStatusAtDecision: string;
    override: boolean;
    createdAt: string;
    revokedAt: string | null;
    revokeReason: string | null;
  }[];
  dismissedAt: string | null;
  dismissReason: string | null;
  restoredAt?: string | null;
};

/** 直接复用 packages/contracts 的投影契约，避免 Web 内再定义一份会漂移的类型。 */
export type BattlefieldPayload = TBattlefieldCardPayload;
export type CapabilityPayload = TCapabilityCardPayload;


export type RadarPayload = {
  timezone: string;
  lookbackHours: number;
  anchors: { id: string; title: string; query: string; location: { type: string; id?: string }; source?: string }[];
  scheduledCompanyDay: string | null;
  unreadCount: number;
  lastScheduledAt: string | null;
  lastRun: { trigger: string; status: string; companyDay: string; warnings: string[] } | null;
  sources: Record<string, { configured: boolean; sourceCount: number; message: string }>;
};

export type SignalPayload = {
  source: { type: string; title: string; url: string; publishedAt: string; excerpt: string; images?: { src: string; after: number }[] };
  assessment: {
    anchorId: string;
    location: { type: string; id?: string };
    summary: string;
    strategicImpact: string;
    evidenceQuote: string;
    unknowns: string[];
    score: { relevance: number; impact: number; urgency: number };
  };
  state: { read: boolean; saved: boolean; dismissed: boolean };
  collectedAt: string;
};

export type MeetingPayload = TMeetingCardPayload;
export type MonthlyPlanPayload = TMonthlyPlanCardPayload;
export type MissionPayload = TMissionCardPayload;

export const payloadOf = <T,>(card: Card): T => card.payload as T;
