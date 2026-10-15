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
  /** 只在成员的只读议题里有：位置的显示名（成员没有登记表）。 */
  locationName?: string | null;
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
    /** 由会后条目确认产生的结论带来源；直接拍板的没有。 */
    source?: { kind: "meeting-item"; meetingId: string; outcomeItemId: string };
  }[];
  dismissedAt: string | null;
  dismissReason: string | null;
  restoredAt?: string | null;
  /** ai_suggested：AI 识别的候选议题（演示资料包），界面不再标来源（雷达来源另看 origin）；旧接口与真实议题没有这一项。 */
  nature?: "ai_suggested";
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
  lastRun: { trigger: string; status: string; companyDay: string; warnings: string[]; startedAt?: string; completedAt?: string } | null;
  /**
   * 首页雷达卡的信号流：实时扫描到的、未忽略的信号按重要度（impact + urgency）高→低、再按发布时间新→旧，最多 6 条；
   * 资料包预载的信号不在这里（只在雷达页）。source 是发布方（媒体名 / 公众号名 / 站点域名）；importance 三档，未评估为 null。
   * origin 固定为 "scan"——旧接口没有这一项（那时信号流还混着预载信号），首页只认带 origin=scan 的。
   */
  latestSignals?: {
    id: string;
    title: string;
    source: string;
    publishedAt: string;
    importance: "high" | "medium" | "low" | null;
    read: boolean;
    origin?: "scan";
  }[];
  /** 信号流对应的未读数：只数实时扫描到的（unreadCount 是雷达页口径，含预载信号）。旧接口没有这一项。 */
  latestUnreadCount?: number;
  /** outlets 带当前启用的发布方中文名（names），「监测范围」据此如实列出。 */
  sources: Record<string, { configured: boolean; sourceCount: number; message: string; names?: string[] }>;
};

export type SignalPayload = {
  /** fullText：原文是逐篇抓取的发布方文章页（量子位），而非检索/feed 摘录。 */
  source: { type: string; title: string; url: string; publishedAt: string; excerpt: string; images?: { src: string; after: number }[]; fullText?: boolean };
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
