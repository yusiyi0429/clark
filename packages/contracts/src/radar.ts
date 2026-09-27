import { Type, type Static } from "@sinclair/typebox";
import { IssueLocation, IssueUrgencyLevel } from "./issues.js";

export const RadarLocation = Type.Union([
  Type.Object({ type: Type.Literal("company") }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("battlefield"), id: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("capability"), id: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }),
]);

/** anchor 写入来源：ontology 由已签发 MonthlyPlan 重建；meeting-reopen 为会议复议条件；manual 为人工配置。 */
export const RadarAnchorSource = Type.Union([
  Type.Literal("ontology"),
  Type.Literal("manual"),
  Type.Literal("meeting-reopen"),
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

export const RadarOutletChannel = Type.Object({
  kind: Type.Union([Type.Literal("rss"), Type.Literal("atom"), Type.Literal("news-sitemap")]),
  url: Type.String({ minLength: 1, maxLength: 500 }),
}, { additionalProperties: false });

/**
 * 发布方级来源：渠道（channels）负责取回，articleDomains 只负责归属校验，二者永不互换。
 * feeds.bbci.co.uk / feeds.a.dj.com / feeds.bloomberg.com 是渠道主机，绝不能写进 articleDomains。
 */
export const RadarOutlet = Type.Object({
  outletId: Type.String({ minLength: 1, maxLength: 100 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  articleDomains: Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { minItems: 1, maxItems: 10 }),
  channels: Type.Array(RadarOutletChannel, { minItems: 1, maxItems: 5 }),
  /** feed 只给摘要时，逐条抓文章页提取全文（CEO 2026-09-21 裁决：Signal 存完整原文而非摘录）。 */
  fullText: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export type TRadarOutlet = Static<typeof RadarOutlet>;

/**
 * 9 家白名单媒体。纯数据，不是运营配置。
 * cnbctv18.com 是被许可方（印度 CNBC-TV18）、bloomberglaw.com 是独立产品线、
 * bloomberg.co.jp 与 jp.reuters.com 是独立日文版、ftchinese.com 是独立中文品牌——都刻意不纳入。
 * 不要把「漏配的域名」补进去；它们属于别的编辑部。
 */
export const RADAR_OUTLETS = [
  {
    outletId: "bbc",
    name: "BBC",
    articleDomains: ["bbc.com", "bbc.co.uk"],
    channels: [
      { kind: "rss", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
      { kind: "rss", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
    ],
  },
  {
    outletId: "wsj",
    name: "华尔街日报",
    articleDomains: ["wsj.com"],
    channels: [
      { kind: "rss", url: "https://feeds.a.dj.com/rss/RSSWorldNews.xml" },
      { kind: "rss", url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml" },
    ],
  },
  {
    outletId: "bloomberg",
    name: "彭博",
    articleDomains: ["bloomberg.com"],
    channels: [
      { kind: "rss", url: "https://feeds.bloomberg.com/markets/news.rss" },
      { kind: "rss", url: "https://feeds.bloomberg.com/politics/news.rss" },
    ],
  },
  {
    outletId: "reuters",
    name: "路透社",
    articleDomains: ["reuters.com"],
    channels: [
      { kind: "news-sitemap", url: "https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml" },
    ],
  },
  {
    outletId: "ft",
    name: "金融时报",
    articleDomains: ["ft.com"],
    channels: [
      { kind: "rss", url: "https://www.ft.com/world?format=rss" },
      { kind: "rss", url: "https://www.ft.com/rss/home" },
    ],
  },
  {
    outletId: "cnbc",
    name: "CNBC",
    articleDomains: ["cnbc.com"],
    channels: [
      { kind: "rss", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html" },
      { kind: "rss", url: "https://www.cnbc.com/id/100727362/device/rss/rss.html" },
    ],
  },
  {
    outletId: "economist",
    name: "经济学人",
    articleDomains: ["economist.com"],
    channels: [
      { kind: "rss", url: "https://www.economist.com/latest/rss.xml" },
      { kind: "rss", url: "https://www.economist.com/finance-and-economics/rss.xml" },
    ],
  },
  {
    outletId: "qbitai",
    name: "量子位",
    articleDomains: ["qbitai.com"],
    channels: [
      { kind: "rss", url: "https://www.qbitai.com/feed" },
    ],
    // WordPress feed 只有 20-30 字摘要；Signal 要完整原文，需逐条抓文章页提取
    fullText: true,
  },
  {
    outletId: "theinformation",
    name: "The Information",
    articleDomains: ["theinformation.com"],
    // Atom 1.0：链接在 <link rel="alternate" href>，时间取 <published> 或 <updated>（2026-09-27 实测 19 条）
    channels: [
      { kind: "atom", url: "https://www.theinformation.com/feed" },
    ],
  },
] satisfies Static<typeof RadarOutlet>[];

export const RadarOutletSource = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 100 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  enabled: Type.Boolean(),
  /** 引用 RADAR_OUTLETS 的 outletId；域名与渠道由目录定义，不在配置里重复。 */
  outlets: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 20 }),
}, { additionalProperties: false });

export const RadarSources = Type.Object({
  sites: Type.Array(RadarSiteSource, { maxItems: 20 }),
  wechatAccounts: Type.Array(RadarWechatAccountSource, { maxItems: 20 }),
  /** 必须保持 Optional：线上旧行没有这个字段，改成必填会让 Value.Check 失败导致整个 Radar 停摆。 */
  outlets: Type.Optional(Type.Array(RadarOutletSource, { maxItems: 20 })),
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
  Type.Object({
    type: Type.Literal("outlet"),
    provider: Type.Literal("publisher-feed"),
    outletId: Type.String({ minLength: 1, maxLength: 100 }),
    outletName: Type.String({ minLength: 1, maxLength: 200 }),
  }, { additionalProperties: false }),
]);

/** 原文配图：src 仅限 https，after = 图片跟在第几段（0 起）之后，用于原文内按位插入。 */
export const RadarSourceImage = Type.Object({
  src: Type.String({ minLength: 8, maxLength: 1000 }),
  after: Type.Integer({ minimum: 0, maximum: 9_999 }),
}, { additionalProperties: false });

export const RadarSourceItem = Type.Object({
  sourceType: Type.Union([Type.Literal("web"), Type.Literal("wechat-account"), Type.Literal("outlet")]),
  title: Type.String({ minLength: 1, maxLength: 500 }),
  url: Type.String({ minLength: 1, maxLength: 2000 }),
  publishedAt: Type.String({ format: "date-time" }),
  excerpt: Type.String({ minLength: 1, maxLength: 10_000 }),
  sourceRef: RadarSourceRef,
  images: Type.Optional(Type.Array(RadarSourceImage, { maxItems: 12 })),
}, { additionalProperties: false });

export const RadarDecisionKind = Type.Union([
  Type.Literal("company_direction"),
  Type.Literal("resource_allocation"),
  Type.Literal("external_commitment"),
  Type.Literal("major_risk"),
  Type.Literal("mission_boundary"),
]);

/** Radar 候选 decisionQuestion 上限：schema 与 prompt 同源引用，改这里两边同步。 */
export const DECISION_QUESTION_MAX_LENGTH = 25;

export const RadarPromotionCandidate = Type.Object({
  decisionKind: RadarDecisionKind,
  decisionQuestion: Type.String({ minLength: 1, maxLength: DECISION_QUESTION_MAX_LENGTH }),
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
  promotion: RadarPromotionCandidate,
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
export type TRadarAnchorSource = Static<typeof RadarAnchorSource>;
export type TRadarSources = Static<typeof RadarSources>;
export type TRadarOutletSource = Static<typeof RadarOutletSource>;
export type TRadarSourceItem = Static<typeof RadarSourceItem>;
export type TRadarCandidateSubmission = Static<typeof RadarCandidateSubmission>;
export type TSignalStateRequest = Static<typeof SignalStateRequest>;
export type TRadarScanResponse = Static<typeof RadarScanResponse>;
