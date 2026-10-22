import { Type, type Static } from "@sinclair/typebox";

/**
 * 管理员视图（已定设计第 10 节）：只给 TIANSHU_ADMIN_PERSON_IDS 里的人，其他人一律 404。
 * 只有运行数据（时间、状态、计数、错误码），不带对话正文。
 */
const Instant = Type.String({ format: "date-time" });
const NullableInstant = Type.Union([Instant, Type.Null()]);

/** 状态色：none＝还没接入（灰）。 */
export const AdminStatus = Type.Union([Type.Literal("red"), Type.Literal("yellow"), Type.Literal("green"), Type.Literal("none")]);

/** 顶部计数；meeting_stuck、delivery_failed 等会议链路合入后再接，先恒为 0。 */
export const AdminCounterKey = Type.Union([
  Type.Literal("collector_gap"),
  Type.Literal("feishu_auth"),
  Type.Literal("meeting_stuck"),
  Type.Literal("delivery_failed"),
  Type.Literal("world_failed"),
  Type.Literal("job_failed"),
]);
export const AdminCounter = Type.Object({
  key: AdminCounterKey,
  value: Type.Integer({ minimum: 0 }),
  status: AdminStatus,
}, { additionalProperties: false });

/** 被标记的对象：人 × 来源的一格（id 是 personId）、后台任务、本体写入、质量信号。 */
export const AdminSubjectType = Type.Union([
  Type.Literal("collector"),
  Type.Literal("feishu"),
  Type.Literal("world"),
  Type.Literal("job"),
  Type.Literal("world_write"),
  Type.Literal("quality"),
]);
export const AdminSubject = Type.Object({
  type: AdminSubjectType,
  id: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });

/** 最近一次「已接手」；已解决的不再显示。 */
export const AdminMark = Type.Object({
  actorName: Type.String(),
  at: Instant,
}, { additionalProperties: false });

export const AdminCollectorDevice = Type.Object({
  deviceName: Type.String(),
  platform: Type.String(),
  source: Type.String(),
  version: Type.String(),
  sourceStatus: Type.String(),
  errorCode: Type.Union([Type.String(), Type.Null()]),
  firstSeenAt: Instant,
  lastAttemptAt: Instant,
  lastSuccessAt: NullableInstant,
  coverageUntil: NullableInstant,
  lastNewEvidenceAt: NullableInstant,
}, { additionalProperties: false });

const cell = {
  status: AdminStatus,
  /** 最近一次成功：采集器同步、飞书授权或续期、周复盘写进本体。 */
  lastSuccessAt: NullableInstant,
  acknowledged: Type.Union([AdminMark, Type.Null()]),
  /** 最近一次给本人发提醒的时间。 */
  remindedAt: NullableInstant,
};
export const AdminCollectorCell = Type.Object({ ...cell, devices: Type.Array(AdminCollectorDevice) }, { additionalProperties: false });
export const AdminFeishuCell = Type.Object({
  ...cell,
  tokenStatus: Type.Union([Type.Literal("active"), Type.Literal("reauth_required"), Type.Null()]),
  authorizedAt: NullableInstant,
  /** 满 365 天飞书一律要求重新授权的那天（授权时刻加 365 天）；续期凭证每次续期都往后挪 7 天，不在这里。 */
  reauthDueAt: NullableInstant,
  reauthReminderAt: NullableInstant,
}, { additionalProperties: false });
export const AdminWorldCell = Type.Object({
  ...cell,
  /** 最近一份提交的周复盘：哪一周、写本体的状态、失败了几个对象。 */
  lastWeek: Type.Union([Type.String({ format: "date" }), Type.Null()]),
  syncStatus: Type.Union([Type.Literal("pending"), Type.Literal("done"), Type.Literal("failed"), Type.Null()]),
  failedTargets: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

export const AdminPersonRow = Type.Object({
  personId: Type.String(),
  displayName: Type.String(),
  collector: AdminCollectorCell,
  feishu: AdminFeishuCell,
  world: AdminWorldCell,
}, { additionalProperties: false });

/** 失败列表的一条：后台任务（dead / 退避重试中）或本体写入（failed / network_error）。 */
export const AdminIssue = Type.Object({
  subject: AdminSubject,
  status: AdminStatus,
  /** job 的 kind，或本体写入的 action_type。 */
  name: Type.String(),
  target: Type.Union([Type.String(), Type.Null()]),
  code: Type.Union([Type.String(), Type.Null()]),
  attempts: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  at: Instant,
  retryable: Type.Boolean(),
  acknowledged: Type.Union([AdminMark, Type.Null()]),
}, { additionalProperties: false });

/** 质量信号：agent_runs 里的 qualitySignals（如 memory_mark_unknown_id），以及失败的运行（run_failed）。 */
export const AdminQualitySignal = Type.Object({
  subject: AdminSubject,
  signal: Type.String(),
  runKind: Type.String(),
  personName: Type.Union([Type.String(), Type.Null()]),
  count: Type.Integer({ minimum: 1 }),
  at: Instant,
  acknowledged: Type.Union([AdminMark, Type.Null()]),
}, { additionalProperties: false });

export const AdminOverviewResponse = Type.Object({
  generatedAt: Instant,
  viewerId: Type.String(),
  counters: Type.Array(AdminCounter),
  people: Type.Array(AdminPersonRow),
  issues: Type.Array(AdminIssue),
  quality: Type.Array(AdminQualitySignal),
}, { additionalProperties: false });

/** clientId 是这次操作的幂等键：重放不再发提醒、不再重跑。 */
const ClientId = Type.String({ format: "uuid" });
export const AdminRemindAction = Type.Object({
  action: Type.Literal("remind"),
  clientId: ClientId,
  personId: Type.String({ minLength: 1, maxLength: 200 }),
  source: Type.Union([Type.Literal("collector"), Type.Literal("feishu"), Type.Literal("world")]),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  body: Type.String({ minLength: 1, maxLength: 2000 }),
}, { additionalProperties: false });
export const AdminMarkAction = Type.Object({
  action: Type.Union([Type.Literal("acknowledge"), Type.Literal("resolve")]),
  clientId: ClientId,
  subject: AdminSubject,
}, { additionalProperties: false });
/** 重试先只对 dead 的后台任务开放。 */
export const AdminRetryAction = Type.Object({
  action: Type.Literal("retry"),
  clientId: ClientId,
  subject: Type.Object({ type: Type.Literal("job"), id: Type.String({ pattern: "^[0-9]{1,19}$" }) }, { additionalProperties: false }),
}, { additionalProperties: false });
export const AdminActionRequest = Type.Union([AdminRemindAction, AdminMarkAction, AdminRetryAction]);

export type TAdminStatus = Static<typeof AdminStatus>;
export type TAdminCounter = Static<typeof AdminCounter>;
export type TAdminCounterKey = Static<typeof AdminCounterKey>;
export type TAdminSubject = Static<typeof AdminSubject>;
export type TAdminSubjectType = Static<typeof AdminSubjectType>;
export type TAdminMark = Static<typeof AdminMark>;
export type TAdminCollectorDevice = Static<typeof AdminCollectorDevice>;
export type TAdminPersonRow = Static<typeof AdminPersonRow>;
export type TAdminIssue = Static<typeof AdminIssue>;
export type TAdminQualitySignal = Static<typeof AdminQualitySignal>;
export type TAdminOverviewResponse = Static<typeof AdminOverviewResponse>;
export type TAdminActionRequest = Static<typeof AdminActionRequest>;
