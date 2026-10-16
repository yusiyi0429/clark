import { Type, type Static } from "@sinclair/typebox";

export const IssueLocation = Type.Union([
  Type.Object({
    level: Type.Literal("company"),
    relatedBattlefieldIds: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 20, uniqueItems: true }),
  }, { additionalProperties: false }),
  Type.Object({
    level: Type.Literal("battlefield"),
    battlefieldId: Type.String({ minLength: 1, maxLength: 100 }),
  }, { additionalProperties: false }),
  Type.Object({
    level: Type.Literal("capability"),
    capabilityId: Type.String({ minLength: 1, maxLength: 100 }),
  }, { additionalProperties: false }),
]);

export const IssueUrgencyLevel = Type.Union([
  Type.Literal("red"),
  Type.Literal("yellow"),
  Type.Literal("gray"),
]);

/**
 * 议题来源性质（演示资料包 issues[].nature）：ai_suggested 是 AI 识别的候选议题——不是已经发生的业务问题，也不是正式待决策；
 * 界面在标题旁标「AI 建议」，Agent 引用时必须说明。省略即真实议题（旧数据都没有这一项）。
 */
export const IssueNature = Type.Literal("ai_suggested");

export const DriIssueImportRequest = Type.Object({
  externalId: Type.String({ minLength: 1, maxLength: 200 }),
  submitterPersonId: Type.String({ minLength: 1, maxLength: 200 }),
  title: Type.String({ minLength: 1, maxLength: 500 }),
  whyNow: Type.String({ minLength: 1, maxLength: 2000 }),
  sourceRef: Type.String({ minLength: 1, maxLength: 2000 }),
  location: IssueLocation,
  urgency: Type.Optional(Type.Object({
    level: IssueUrgencyLevel,
    /** 时间窗口由代码解析校验（Date.parse），schema 只约束形状。 */
    decisionBy: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export const ResearchStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("running"),
  Type.Literal("ready"),
  Type.Literal("failed"),
]);

/** 唯一预研深度：判断、选择、后果、证据、未知和来源只存在 ResearchDoc。 */
export const ResearchDocOption = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 100 }),
  label: Type.String({ minLength: 1, maxLength: 500 }),
  consequences: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 10 }),
}, { additionalProperties: false });

/**
 * 来源只允许真实 http(s) 地址。模型会自编 `file:///...` 或 `urn:issue:...` 假来源，
 * Web 会把它渲染成链接，既虚构证据又暴露内部路径。内部材料改用 sourceTitle 表达。
 */
const ResearchSourceUrl = Type.String({ minLength: 8, maxLength: 2000, pattern: "^https?://\\S+$" });

export const ResearchDocEvidence = Type.Object({
  quote: Type.String({ minLength: 1, maxLength: 2000 }),
  sourceTitle: Type.String({ minLength: 1, maxLength: 500 }),
  sourceUrl: Type.Optional(ResearchSourceUrl),
}, { additionalProperties: false });

export const ResearchDocSource = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 500 }),
  url: ResearchSourceUrl,
}, { additionalProperties: false });

/** 严格 candidate schema：Agent 只能通过 submit_candidate 提交这一整份结构。 */
export const ResearchDoc = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 2000 }),
  options: Type.Array(ResearchDocOption, { minItems: 2, maxItems: 4 }),
  evidence: Type.Array(ResearchDocEvidence, { maxItems: 10 }),
  unknowns: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 10 }),
  sources: Type.Array(ResearchDocSource, { maxItems: 10 }),
}, { additionalProperties: false });

export const IssueDecideInput = Type.Object({
  decisionText: Type.String({ minLength: 1, maxLength: 5000 }),
  optionId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
}, { additionalProperties: false });

/** `confirmOverride: true` 是 Research Override 的服务端二次确认；预研未完成时没有建议选项可选。 */
export const IssueDecideOverrideInput = Type.Object({
  decisionText: Type.String({ minLength: 1, maxLength: 5000 }),
  confirmOverride: Type.Literal(true),
}, { additionalProperties: false });

export const IssueDismissInput = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 500 }),
}, { additionalProperties: false });

/** 恢复被移出的 Issue：无输入；dismissed-only，移出审计字段保留。 */
export const IssueRestoreInput = Type.Object({}, { additionalProperties: false });

/** 指派主责人（docs/superpowers/specs/2026-10-12-assign-and-mission-status.md）：一个人，可附一句说明。 */
export const IssueAssignInput = Type.Object({
  personId: Type.String({ minLength: 1, maxLength: 200 }),
  note: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
}, { additionalProperties: false });

/** 议题的当前主责与指派历史里的一条。 */
export const IssueAssignment = Type.Object({
  personId: Type.String(),
  displayName: Type.String(),
  assignedAt: Type.String(),
  assignedBy: Type.String(),
  assignedByName: Type.String(),
  note: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });

export const IssueRetryResearchInput = Type.Object({}, { additionalProperties: false });

export const IssueRevokeReceiptInput = Type.Object({
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
}, { additionalProperties: false });

/** meeting-item Receipt 的来源：知道它来自哪一个会议条目。 */
export const IssueReceiptSource = Type.Object(
  {
    kind: Type.Literal("meeting-item"),
    meetingId: Type.String({ minLength: 1 }),
    outcomeItemId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** Receipt 是 Issue 内嵌结构：保存 CEO 最终文本、决定时预研状态与 override 事实。 */
export const IssueReceipt = Type.Object({
  id: Type.String(),
  actionType: Type.String(),
  effectRef: Type.String(),
  decisionText: Type.String(),
  optionId: Type.Optional(Type.String()),
  researchStatusAtDecision: ResearchStatus,
  researchRunId: Type.Optional(Type.String()),
  override: Type.Boolean(),
  /** 由 MeetingOutcome decision 确认产生的 Receipt 携带精确来源。 */
  source: Type.Optional(IssueReceiptSource),
  createdAt: Type.String(),
  revokedAt: Type.Optional(Type.String()),
  revokeReason: Type.Optional(Type.String()),
}, { additionalProperties: false });

/**
 * 议题有效历史分层（feedback 9 / H05）。三层互不混用：
 * - effective：仍有效的已确认决定（Issue Receipt、会后确认、客户包导入的历史决定），未撤回、未被替代；
 * - changes：决定之后实际发生、有日期和出处的执行变化（阶段反馈、群讨论、材料修订、战场信号）；
 * - pending：本次待判断事项与待确认候选，明确不是决定；
 * - inactive：已撤回或被替代的决定，只供审计和解释变化，不得作为当前约束。
 * ref 格式：`decision:<receiptId|historyId>`、`discussion:<threadMessageId>`、`material:<id>@v<n>`、
 * `feedback:<monthlyFeedbackId>`、`signal:<signalId>`、`fact:<executionFactId>`、`issue:<id>`、`outcome:<meetingId>#<itemId>`。
 */
export const DecisionHistoryPerson = Type.Object({
  personId: Type.Union([Type.String(), Type.Null()]),
  displayName: Type.String(),
}, { additionalProperties: false });

export const DecisionHistorySource = Type.Object({
  kind: Type.Union([Type.Literal("issue-receipt"), Type.Literal("meeting-item"), Type.Literal("imported")]),
  receiptId: Type.Optional(Type.String()),
  meetingId: Type.Optional(Type.String()),
  meetingTitle: Type.Optional(Type.String()),
  meetingAt: Type.Optional(Type.String()),
  outcomeItemId: Type.Optional(Type.String()),
  turnId: Type.Optional(Type.String()),
  quote: Type.Optional(Type.String()),
  /** 导入历史决定的客户原始出处（纪要/邮件等），原文由方法团队提供。 */
  importedRef: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const DecisionHistoryEntry = Type.Object({
  ref: Type.String(),
  issueId: Type.String(),
  kind: Type.Union([Type.Literal("decision"), Type.Literal("judgment")]),
  text: Type.String(),
  decidedAt: Type.String(),
  decidedBy: Type.Union([DecisionHistoryPerson, Type.Null()]),
  confirmedVia: Type.Union([
    Type.Literal("issue.decide"),
    Type.Literal("issue.decide_override"),
    Type.Literal("meeting.confirm_item"),
    Type.Literal("imported"),
  ]),
  option: Type.Union([Type.Object({
    id: Type.Union([Type.String(), Type.Null()]),
    label: Type.Union([Type.String(), Type.Null()]),
  }, { additionalProperties: false }), Type.Null()]),
  status: Type.Union([Type.Literal("effective"), Type.Literal("revoked"), Type.Literal("superseded")]),
  statusAt: Type.Union([Type.String(), Type.Null()]),
  statusReason: Type.Union([Type.String(), Type.Null()]),
  /** 被哪条决定替代（decision:<id>）。 */
  supersededBy: Type.Union([Type.String(), Type.Null()]),
  /** 被哪条决定撤回（decision:<id>）；现场撤回 Receipt 没有撤回依据决定时为 null。 */
  revokedBy: Type.Union([Type.String(), Type.Null()]),
  source: DecisionHistorySource,
  sourceRefs: Type.Array(Type.String()),
}, { additionalProperties: false });

export const DecisionHistoryChange = Type.Object({
  ref: Type.String(),
  kind: Type.Union([
    Type.Literal("monthly_feedback"),
    Type.Literal("discussion"),
    Type.Literal("material_revision"),
    Type.Literal("signal"),
    /** 客户资料导入的执行/外部事实（issue_execution_facts），ref 为 fact:<id>。 */
    Type.Literal("execution_fact"),
  ]),
  at: Type.String(),
  text: Type.String(),
  author: Type.Union([DecisionHistoryPerson, Type.Null()]),
  /** 原始出处说明（反馈 sourceRef、材料名、信号来源标题等）。 */
  sourceRef: Type.String(),
  /** 这条变化关联的历史决定（decision:<id>），用于解释“相较上次为何变化”。 */
  relatedDecisionRefs: Type.Optional(Type.Array(Type.String())),
  /** 群发言性质（提案/意见/事实核对等，来自导入资料）；发言不是决定。 */
  stance: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const DecisionHistoryPending = Type.Object({
  ref: Type.String(),
  kind: Type.Union([Type.Literal("issue_pending"), Type.Literal("outcome_candidate")]),
  text: Type.String(),
  at: Type.Union([Type.String(), Type.Null()]),
  options: Type.Array(Type.Object({ id: Type.String(), label: Type.String() }, { additionalProperties: false })),
  source: Type.Union([DecisionHistorySource, Type.Null()]),
  /** 固定提示：尚未确认，不是决定。 */
  note: Type.String(),
}, { additionalProperties: false });

export const IssueDecisionHistory = Type.Object({
  issueId: Type.String(),
  issueTitle: Type.String(),
  issueStatus: Type.Union([Type.Literal("pending"), Type.Literal("decided"), Type.Literal("dismissed")]),
  effective: Type.Array(DecisionHistoryEntry),
  changes: Type.Array(DecisionHistoryChange),
  /** changes 的起算时间：最早一条仍有效决定的时间；没有有效决定时为 null（不列执行变化）。 */
  changesSince: Type.Union([Type.String(), Type.Null()]),
  /** 没有执行证据时的明确说明，例如“未获得执行证据（待补）”；有变化时为 null。 */
  changesNote: Type.Union([Type.String(), Type.Null()]),
  pending: Type.Array(DecisionHistoryPending),
  inactive: Type.Array(DecisionHistoryEntry),
  /** 检索到的全部相关会议（不限一场），按时间升序。 */
  relatedMeetings: Type.Array(Type.Object({
    id: Type.String(),
    title: Type.String(),
    status: Type.String(),
    scheduledAt: Type.String(),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export const MeetingDecisionHistoryResponse = Type.Object({
  meetingId: Type.String(),
  issues: Type.Array(IssueDecisionHistory),
}, { additionalProperties: false });

export type TDecisionHistoryPerson = Static<typeof DecisionHistoryPerson>;
export type TDecisionHistorySource = Static<typeof DecisionHistorySource>;
export type TDecisionHistoryEntry = Static<typeof DecisionHistoryEntry>;
export type TDecisionHistoryChange = Static<typeof DecisionHistoryChange>;
export type TDecisionHistoryPending = Static<typeof DecisionHistoryPending>;
export type TIssueDecisionHistory = Static<typeof IssueDecisionHistory>;
export type TMeetingDecisionHistoryResponse = Static<typeof MeetingDecisionHistoryResponse>;
export type TIssueAssignInput = Static<typeof IssueAssignInput>;
export type TIssueAssignment = Static<typeof IssueAssignment>;
export type TIssueNature = Static<typeof IssueNature>;
export type TIssueLocation = Static<typeof IssueLocation>;
export type TIssueUrgencyLevel = Static<typeof IssueUrgencyLevel>;
export type TDriIssueImportRequest = Static<typeof DriIssueImportRequest>;
export type TResearchStatus = Static<typeof ResearchStatus>;
export type TResearchDoc = Static<typeof ResearchDoc>;
export type TIssueDecideInput = Static<typeof IssueDecideInput>;
export type TIssueDecideOverrideInput = Static<typeof IssueDecideOverrideInput>;
export type TIssueDismissInput = Static<typeof IssueDismissInput>;
export type TIssueRestoreInput = Static<typeof IssueRestoreInput>;
export type TIssueRevokeReceiptInput = Static<typeof IssueRevokeReceiptInput>;
export type TIssueReceiptSource = Static<typeof IssueReceiptSource>;
export type TIssueReceipt = Static<typeof IssueReceipt>;
