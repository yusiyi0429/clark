import { Type, type Static } from "@sinclair/typebox";
import { IssueLocation, IssueUrgencyLevel } from "./issues.js";

export const RadarLocation = Type.Union([
  Type.Object({ type: Type.Literal("company") }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("battlefield"), id: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("capability"), id: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }),
]);

/** anchor 写入来源：meeting-reopen 为会议复议条件，ontology 为月度签发刷新的基础方向。 */
export const RadarAnchorSource = Type.Union([
  Type.Literal("meeting-reopen"),
  Type.Literal("ontology"),
]);

export const RadarAnchor = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 100 }),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  query: Type.String({ minLength: 1, maxLength: 500 }),
  location: RadarLocation,
  source: Type.Optional(RadarAnchorSource),
  /** 产生该 anchor 的业务对象引用，用于幂等重建与精确撤回。 */
  originRef: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
}, { additionalProperties: false });

export const RadarSiteSource = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 100 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  enabled: Type.Boolean(),
  domains: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { maxItems: 20 })),
}, { additionalProperties: false });

export const RadarWechatAccountSource = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 100 }),
  accountId: Type.String({ minLength: 1, maxLength: 200 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  enabled: Type.Boolean(),
}, { additionalProperties: false });

export const RadarSources = Type.Object({
  sites: Type.Array(RadarSiteSource, { maxItems: 20 }),
  wechatAccounts: Type.Array(RadarWechatAccountSource, { maxItems: 20 }),
}, { additionalProperties: false });

export const RadarSourceRef = Type.Union([
  Type.Object({
    type: Type.Literal("web-search"),
    provider: Type.String({ minLength: 1, maxLength: 100 }),
    query: Type.String({ minLength: 1, maxLength: 500 }),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("wechat-account"),
    provider: Type.String({ minLength: 1, maxLength: 100 }),
    accountId: Type.String({ minLength: 1, maxLength: 200 }),
    accountName: Type.String({ minLength: 1, maxLength: 200 }),
  }, { additionalProperties: false }),
]);

export const RadarSourceItem = Type.Object({
  sourceType: Type.Union([Type.Literal("web"), Type.Literal("wechat-account")]),
  title: Type.String({ minLength: 1, maxLength: 500 }),
  url: Type.String({ minLength: 1, maxLength: 2000 }),
  publishedAt: Type.String({ format: "date-time" }),
  excerpt: Type.String({ minLength: 1, maxLength: 10_000 }),
  sourceRef: RadarSourceRef,
}, { additionalProperties: false });

export const RadarDecisionKind = Type.Union([
  Type.Literal("company_direction"),
  Type.Literal("resource_allocation"),
  Type.Literal("external_commitment"),
  Type.Literal("major_risk"),
  Type.Literal("mission_boundary"),
]);

export const RadarPromotionCandidate = Type.Object({
  decisionKind: RadarDecisionKind,
  decisionQuestion: Type.String({ minLength: 1, maxLength: 1000 }),
  options: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 2, maxItems: 4 }),
  location: IssueLocation,
  urgency: Type.Object({
    level: IssueUrgencyLevel,
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    decisionBy: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    decisionByEvidence: Type.Optional(Type.Object({
      quote: Type.String({ minLength: 1, maxLength: 1000 }),
    }, { additionalProperties: false })),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export const RadarCandidate = Type.Object({
  sourceFingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  anchorId: Type.String({ minLength: 1, maxLength: 100 }),
  summary: Type.String({ minLength: 1, maxLength: 500 }),
  strategicImpact: Type.String({ minLength: 1, maxLength: 1000 }),
  evidenceQuote: Type.String({ minLength: 1, maxLength: 1000 }),
  unknowns: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 5 }),
  score: Type.Object({
    relevance: Type.Integer({ minimum: 0, maximum: 5 }),
    impact: Type.Integer({ minimum: 0, maximum: 5 }),
    urgency: Type.Integer({ minimum: 0, maximum: 5 }),
  }, { additionalProperties: false }),
  promotion: Type.Optional(RadarPromotionCandidate),
}, { additionalProperties: false });

export const RadarCandidateSubmission = Type.Object({
  candidates: Type.Array(RadarCandidate, { maxItems: 50 }),
}, { additionalProperties: false });

export const SignalStateRequest = Type.Object({
  read: Type.Optional(Type.Boolean()),
  saved: Type.Optional(Type.Boolean()),
  dismissed: Type.Optional(Type.Boolean()),
}, { additionalProperties: false, minProperties: 1 });

export const RadarScanResponse = Type.Object({
  trigger: Type.Union([Type.Literal("manual"), Type.Literal("scheduled")]),
  status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("skipped"), Type.Literal("busy")]),
  companyDay: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  createdSignals: Type.Integer({ minimum: 0 }),
  warnings: Type.Array(Type.String()),
}, { additionalProperties: false });

export type TRadarAnchor = Static<typeof RadarAnchor>;
export type TRadarSources = Static<typeof RadarSources>;
export type TRadarSourceItem = Static<typeof RadarSourceItem>;
export type TRadarCandidateSubmission = Static<typeof RadarCandidateSubmission>;
export type TSignalStateRequest = Static<typeof SignalStateRequest>;
export type TRadarScanResponse = Static<typeof RadarScanResponse>;
