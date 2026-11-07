import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { LocalPlanEntry, LocalSessionStatus } from "./localRunner.js";
import { NullableInteger, NullableNumber } from "./nullable.js";

/**
 * 本机程序在云端的那一侧（V2 设计第 4、5 节）：配对出来的设备、本机报上来的执行摘要和产出。
 * 本机只单向上报（POST /api/local-runner/sync，载荷见 localRunner.ts），云端从不指挥本机；这里是网页读这些摘要用的视图。
 */

const strict = { additionalProperties: false } as const;
const Instant = Type.String({ format: "date-time" });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const LocalDeviceOs = Type.Union([Type.Literal("win32"), Type.Literal("darwin"), Type.Literal("linux")]);

/**
 * 本人的一台装了本机程序的电脑。id 就是本机程序自己的 deviceId（GET /v1/status 里的 deviceId），同一台电脑再配对只换令牌、不另建一台。
 * appVersion 是本机程序版本（同步时报的 runnerVersion），没同步过为 null。只列没吊销的。
 */
export const LocalDeviceView = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String({ minLength: 1, maxLength: 60 }),
  os: LocalDeviceOs,
  appVersion: Nullable(Type.String()),
  lastSyncAt: Nullable(Instant),
  createdAt: Instant,
}, strict);

/**
 * 配对时建设备令牌：deviceId 取本机 GET /v1/status 的 deviceId，name 默认用电脑名。
 * 同一台电脑（同一个 deviceId）再配对：旧令牌立刻失效，换一把新的。设备令牌不占「每人 5 把」的名额，也不出现在设置页的令牌列表里。
 */
export const CreateLocalDeviceRequest = Type.Object({
  deviceId: Type.String({ format: "uuid" }),
  name: Type.String({ minLength: 1, maxLength: 60 }),
  os: LocalDeviceOs,
}, strict);
/** token 只在这一次返回，网页经本机 PUT /v1/cloud 交给本机程序，不在网页里存。 */
export const CreateLocalDeviceResponse = Type.Object({
  device: LocalDeviceView,
  token: Type.String({ minLength: 16 }),
}, strict);
export const LocalDeviceListResponse = Type.Object({ devices: Type.Array(LocalDeviceView) }, strict);

/**
 * 计划走到哪，照本机报的计划进度（本机程序契约 localRunner.ts 的 LocalPlanProgress，字段同名）：done / total 条做完；
 * step 是第几步（正在做的那条是第几条，没有正在做的就是做完的条数）；current 是正在做的那条（没有为 null）。
 */
export const LocalRunPlanProgress = Type.Object({
  done: Type.Integer({ minimum: 0 }),
  total: Type.Integer({ minimum: 0 }),
  step: Type.Integer({ minimum: 0 }),
  current: Nullable(Type.String()),
}, strict);

/** 花费：本次执行累计的 token；costUsd 是本机给的估价（订阅时是 Claude Code 自估的等价花费，网关模型可能没有）。 */
export const LocalRunCost = Type.Object({
  inputTokens: Type.Integer({ minimum: 0 }),
  outputTokens: Type.Integer({ minimum: 0 }),
  costUsd: NullableNumber({ minimum: 0 }),
}, strict);

export const LocalRunActivity = Type.Object({ at: Instant, text: Type.String({ minLength: 1, maxLength: 300 }) }, strict);

/**
 * 一次本机执行（一个本机会话，id 就是本机的 sessionId）在云端的摘要，本机是唯一写入方。
 * state 照本机的会话状态：queued（等空位）、starting、running、waiting_permission（等你批准）、idle（一轮结束等你说话）、exited（停下或本机程序重启）、failed。
 * lastActivity 是最近一条动静（状态变化、计划条目、交出的产出、证据、交回）；deviceName 是跑它的那台电脑。
 */
export const LocalRunBrief = Type.Object({
  id: Type.String({ format: "uuid" }),
  deviceId: Type.String({ format: "uuid" }),
  deviceName: Type.String(),
  state: LocalSessionStatus,
  modelLabel: Nullable(Type.String()),
  plan: LocalRunPlanProgress,
  lastActivity: Nullable(LocalRunActivity),
  cost: LocalRunCost,
  startedAt: Instant,
  updatedAt: Instant,
  /** 结束（exited、failed）的时间；还在跑为 null。 */
  endedAt: Nullable(Instant),
}, strict);

/** 详情里的一次执行：再带完整的计划条目和里程碑（最多 50 条，不含每一步工具调用）。 */
export const LocalRunView = Type.Object({
  ...LocalRunBrief.properties,
  planEntries: Type.Array(LocalPlanEntry, { maxItems: 100 }),
  timeline: Type.Array(LocalRunActivity, { maxItems: 50 }),
}, strict);

/**
 * 本机传上来的东西：artifact 是执行方点名交出的文件（md、html、pdf、docx、txt），evidence 是证据（说明、日志片段、链接、改动摘要）。
 * 文件打开走 GET /api/me/local-outputs/:id；证据只有文字和链接。同名再交一份就是新的一行。
 */
export const LocalOutputView = Type.Object({
  id: Type.String({ format: "uuid" }),
  runId: Type.String({ format: "uuid" }),
  kind: Type.Union([Type.Literal("artifact"), Type.Literal("evidence")]),
  /** 证据的种类；artifact 为 null。 */
  evidenceKind: Nullable(Type.Union([Type.Literal("note"), Type.Literal("log"), Type.Literal("link"), Type.Literal("diff_summary")])),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  fileName: Nullable(Type.String()),
  mimeType: Nullable(Type.String()),
  sizeBytes: NullableInteger({ minimum: 0 }),
  url: Nullable(Type.String()),
  text: Nullable(Type.String({ maxLength: 8000 })),
  createdAt: Instant,
}, strict);

export type TLocalDeviceOs = Static<typeof LocalDeviceOs>;
export type TLocalDeviceView = Static<typeof LocalDeviceView>;
export type TCreateLocalDeviceRequest = Static<typeof CreateLocalDeviceRequest>;
export type TCreateLocalDeviceResponse = Static<typeof CreateLocalDeviceResponse>;
export type TLocalDeviceListResponse = Static<typeof LocalDeviceListResponse>;
export type TLocalRunPlanProgress = Static<typeof LocalRunPlanProgress>;
export type TLocalRunCost = Static<typeof LocalRunCost>;
export type TLocalRunActivity = Static<typeof LocalRunActivity>;
export type TLocalRunBrief = Static<typeof LocalRunBrief>;
export type TLocalRunView = Static<typeof LocalRunView>;
export type TLocalOutputView = Static<typeof LocalOutputView>;
