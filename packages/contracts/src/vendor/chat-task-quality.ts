import { Type, type Static } from "@sinclair/typebox";

export const TaskQualityId = Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" });
const NullableText = Type.Union([Type.String(), Type.Null()]);
export const TaskQualityOptions = Type.Object({ maxAgeHours: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 87600 }), Type.Null()])) }, { additionalProperties: false });
export const TaskRepairValue = Type.Union([Type.String({ maxLength: 12000 }), Type.Array(Type.String({ maxLength: 2048 }), { maxItems: 50 }), Type.Null()]);
export const TaskRepairField = Type.Object({
  key: Type.String(), label: Type.String(), kind: Type.Union((["text", "date", "links", "dependencies"] as const).map(value => Type.Literal(value))),
  value: Type.Union([Type.String(), Type.Array(Type.String()), Type.Null()]),
  target: Type.Union([
    Type.Object({ kind: Type.Literal("component"), block_id: Type.String(), component_id: NullableText, create_type: NullableText,
      attribute: Type.Union([Type.Literal("start_date"), Type.Literal("finish_date"), Type.Null()]) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("state"), block_id: Type.Union([Type.Literal("current_state"), Type.Literal("blockers"), Type.Literal("materials")]) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("depends_on") }, { additionalProperties: false }),
  ]),
}, { additionalProperties: false });
export const TaskQualityFinding = Type.Object({
  id: Type.String(), code: Type.String(), kind: Type.Union(["missing", "unknown", "stale", "conflict", "pending"].map(value => Type.Literal(value))),
  path: Type.String(), message: Type.String(), suggested_action: Type.String(), evidence_refs: Type.Array(Type.String()),
  handler: Type.Object({ role: Type.String(), principal_id: NullableText }),
}, { additionalProperties: false });
export const TaskQualityReport = Type.Object({
  ruleset: Type.Literal("task-quality/0.1"), observed_at: Type.String(), active: Type.Boolean(),
  policy: Type.Object({ max_age_hours: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]) }),
  findings: Type.Array(TaskQualityFinding), fields: Type.Array(TaskRepairField), counts: Type.Record(Type.String(), Type.Integer({ minimum: 0 })), meaning: Type.String(),
}, { additionalProperties: false });
export const RuntimeTaskReport = Type.Object({
  interface_version: Type.Literal("tkos.task-writeback/0.1"),
  task: Type.Object({
    business: Type.Object({ object_id: TaskQualityId, title: Type.String(), version: Type.Integer({ minimum: 1 }), object_version: Type.Integer({ minimum: 1 }),
      revision_id: TaskQualityId, attributes: Type.Record(Type.String(), Type.Unknown()), blocks: Type.Array(Type.Unknown()), relations: Type.Array(Type.Unknown()),
      pending_change: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
    }, { additionalProperties: true }),
    records: Type.Object({ lifecycle: Type.Object({ status: Type.String() }, { additionalProperties: true }), latest_state: Type.Unknown() }, { additionalProperties: true }),
  }, { additionalProperties: true }),
  baseline: Type.Object({ subject_ref: Type.String(), object_version: Type.Integer(), snapshot_id: NullableText, event_count: Type.Integer({ minimum: 0 }) }),
  freshness: Type.Array(Type.Unknown()), quality: TaskQualityReport,
}, { additionalProperties: true });
export const TaskQualityReviewView = Type.Object({ taskId: TaskQualityId, title: Type.String(), checkedAt: Type.String(), report: RuntimeTaskReport }, { additionalProperties: false });
export const TaskQualityReviewList = Type.Object({ reviews: Type.Array(TaskQualityReviewView) }, { additionalProperties: false });
export const TaskRepairClassification = Type.Union((["fact", "decision", "suggestion", "question"] as const).map(value => Type.Literal(value)));
export const TaskRepairInput = Type.Object({
  clientRequestId: Type.String({ minLength: 1, maxLength: 200 }), fieldKey: Type.String({ minLength: 1, maxLength: 300 }),
  value: TaskRepairValue, classification: TaskRepairClassification, quote: Type.String({ minLength: 1, maxLength: 20000 }),
  occurredAt: NullableText,
}, { additionalProperties: false });
export const TaskRepairSource = Type.Object({
  kind: Type.Union([Type.Literal("statement"), Type.Literal("conversation"), Type.Literal("meeting")]),
  title: Type.String(), version: Type.String(), quote: Type.String(), occurredAt: NullableText, locator: NullableText,
  links: Type.Array(Type.String()), meetingId: NullableText, meetingRevision: Type.Union([Type.Integer(), Type.Null()]),
  payloadHash: NullableText, conversationId: NullableText, messageId: NullableText,
}, { additionalProperties: false });
export const TaskRepairState = Type.Union((["needs_input", "pending_decision", "needs_source", "ready", "handed_off", "blocked", "verified", "superseded"] as const).map(value => Type.Literal(value)));
export const TaskRepairView = Type.Object({
  id: TaskQualityId, taskId: Type.Union([TaskQualityId, Type.Null()]), taskTitle: NullableText,
  fieldKey: NullableText, fieldLabel: NullableText, classification: TaskRepairClassification,
  before: Type.Union([Type.String(), Type.Array(Type.String()), Type.Null()]), after: TaskRepairValue,
  source: TaskRepairSource, state: TaskRepairState, message: NullableText,
  sourceReceiptId: NullableText, receiptId: NullableText, writebackStatus: NullableText, updatedAt: Type.String(),
}, { additionalProperties: false });
export const TaskRepairList = Type.Object({ proposals: Type.Array(TaskRepairView) }, { additionalProperties: false });
export const TaskRepairReceiptInput = Type.Union([
  Type.Object({ stage: Type.Literal("source"), receiptId: TaskQualityId }, { additionalProperties: false }),
  Type.Object({ stage: Type.Literal("change"), receiptId: Type.Optional(TaskQualityId) }, { additionalProperties: false }),
]);
export const TaskRepairRevision = Type.Object({ taskId: TaskQualityId, input: TaskRepairInput }, { additionalProperties: false });
export const TaskRepairHandoff = Type.Object({
  proposal: TaskRepairView, scopeId: TaskQualityId, stage: Type.Union([Type.Literal("source"), Type.Literal("change"), Type.Literal("blocked")]),
  request: Type.Optional(Type.Record(Type.String(), Type.Unknown())), package: Type.Optional(Type.Record(Type.String(), Type.Unknown())), instruction: Type.String(),
}, { additionalProperties: false });
export type QualityOptions = Static<typeof TaskQualityOptions>;
export type RuntimeReport = Static<typeof RuntimeTaskReport>;
export type ReviewView = Static<typeof TaskQualityReviewView>;
export type RepairField = Static<typeof TaskRepairField>;
export type RepairValue = Static<typeof TaskRepairValue>;
export type RepairInput = Static<typeof TaskRepairInput>;
export type RepairSource = Static<typeof TaskRepairSource>;
export type RepairView = Static<typeof TaskRepairView>;
export type RepairState = Static<typeof TaskRepairState>;
export type RepairHandoff = Static<typeof TaskRepairHandoff>;
export type RepairReceiptInput = Static<typeof TaskRepairReceiptInput>;
export const TaskQualityCatalog = Type.Object({ items: Type.Array(Type.Object({ taskId: TaskQualityId, title: Type.String(), status: Type.String() })), nextCursor: NullableText });
export const TaskMeetingInput = Type.Object({ taskIds: Type.Array(TaskQualityId, { maxItems: 10, uniqueItems: true }) }, { additionalProperties: false });
export const TaskMeetingRepairInput = Type.Object({ taskId: TaskQualityId, sectionId: Type.String({ minLength: 1, maxLength: 64 }), input: TaskRepairInput }, { additionalProperties: false });
export const TaskMeetingCoverage = Type.Object({ sectionId: Type.String(), heading: Type.String(), body: Type.String(),
  disposition: Type.Union([Type.Literal("proposed"), Type.Literal("no_task_change"), Type.Literal("needs_clarification")]), reason: Type.String(), proposalIds: Type.Array(TaskQualityId) });
export const TaskMeetingAnalysis = Type.Object({ meetingId: Type.String(), revision: Type.Integer(), payloadHash: Type.String(),
  coverage: Type.Array(TaskMeetingCoverage), proposals: Type.Array(TaskRepairView) }, { additionalProperties: false });
export type MeetingAnalysis = Static<typeof TaskMeetingAnalysis>;
