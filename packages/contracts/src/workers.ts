import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { RoleRef } from "./roles.js";
import { CardStage } from "./taskCardView.js";

/**
 * worker 列表（V2 设计第 20 节）：不做看板，以「资源」和「worker」呈现。worker 是岗位这一趟派出去的执行（一张带岗位的卡、一个带岗位的专题，
 * 第 21 节起还有本机的规划员会话和验收员会话），
 * 跨所有 Task 分「进行中 / 已排队 / 已完成（今天）」三组列出，每条标着用的资源；另带一份资源摘要。没有岗位的执行事项是人自己的活，不算 worker。
 * GET /api/me/workers 给网页；伙伴的「worker 摘要」工具经 /internal 读同一份内容。
 */

const strict = { additionalProperties: false } as const;
const Instant = Type.String({ format: "date-time" });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/**
 * worker 身上的标记，都在「进行中」：approval 等你批准、reply 等你回复、paused 已暂停、reviewing 验收中（云端的验收员在验）、
 * review_failed 验收没过、blocked 受阻。
 */
export const WorkerMark = Type.Union([
  Type.Literal("approval"), Type.Literal("reply"), Type.Literal("paused"), Type.Literal("reviewing"), Type.Literal("review_failed"), Type.Literal("blocked"),
]);

/** 已排队在等什么：not_dispatched 等开工（本人确认了、还没交给本机）、slot 等空位（本机同时跑满了）、device_offline 等本机上线。 */
export const WorkerQueueReason = Type.Union([Type.Literal("not_dispatched"), Type.Literal("slot"), Type.Literal("device_offline")]);

/** worker 用的资源：local 在本人电脑上（哪台、什么模型）；cloud 在云端（验收员验收），没有设备。 */
export const WorkerResource = Type.Object({
  where: Type.Union([Type.Literal("local"), Type.Literal("cloud")]),
  deviceId: Nullable(Type.String({ format: "uuid" })),
  deviceName: Nullable(Type.String()),
  modelLabel: Nullable(Type.String()),
}, strict);

/** 花费：token 累计；costUsd 是本机给的估价，costCny 是 TokenHub 给的人民币（还没有时为 null）。 */
export const WorkerCost = Type.Object({
  inputTokens: Type.Integer({ minimum: 0 }),
  outputTokens: Type.Integer({ minimum: 0 }),
  costUsd: Nullable(Type.Number({ minimum: 0 })),
  costCny: Nullable(Type.Number({ minimum: 0 })),
}, strict);

/**
 * 一个 worker。key 是 card:<卡 id>、topic:<专题 id>、plan:<规划员会话 id> 或 verify:<被验的卡 id>；
 * workerNo 是界面上「开发 #2」的号：本人列出来的同一岗位的 worker 按开工时间排的第几个，读的时候算，不存。
 * kind=plan 是本机的规划员在拆一个 Task（第 21 节）：title、task 是那个 Task，role 是规划员，stage=doing。
 * kind=verify 是本机的验收员在验一张卡最近一次交回：cardId、title 是被验的那张卡，role 是验收员，stage=review；
 * 本机还没起验收员时在「已排队」（那台电脑在线是等开工 not_dispatched，不在线是等本机上线）；验收员停了没交结论是 paused。
 * 卡在验收中、云端验收开着（BOARD_CLOUD_AGENTS）且本机没起验收员时，干活的是云端的验收员：kind=card，role 是验收员岗位，resource.where=cloud，wait=reviewing。
 * step 是本机报的计划条目里正在做第几步、共几步、这一步写什么。needsYou：等你批准、等你回复、验收没过、受阻（排在「进行中」最前面）。
 * startedAt 是开工时间（等开工的为 null），elapsedSeconds 是到现在（已完成的到完成）用了多久。queueReason 只有「已排队」的有。
 * step 取本机报的计划进度：n 是 progress.step，label 是 progress.current（没有正在做的一步时 step 为 null）。
 * queuePosition 是「排第 n」：只有 queueReason=slot 的有，和本机程序的 queuePosition 同义——这台电脑上等空位的会话按开工先后排第几（1 起）。
 */
export const WorkerItem = Type.Object({
  key: Type.String({ minLength: 1 }),
  kind: Type.Union([Type.Literal("card"), Type.Literal("topic"), Type.Literal("plan"), Type.Literal("verify")]),
  cardId: Nullable(Type.String({ minLength: 1 })),
  topicId: Nullable(Type.String({ format: "uuid" })),
  title: Type.String({ minLength: 1 }),
  role: RoleRef,
  workerNo: Type.Integer({ minimum: 1 }),
  task: Nullable(Type.Object({ id: Type.String({ minLength: 1 }), name: Type.String() }, strict)),
  mission: Nullable(Type.Object({ id: Type.String({ minLength: 1 }), title: Type.String() }, strict)),
  step: Nullable(Type.Object({ n: Type.Integer({ minimum: 1 }), total: Type.Integer({ minimum: 1 }), label: Type.String() }, strict)),
  resource: Nullable(WorkerResource),
  startedAt: Nullable(Instant),
  elapsedSeconds: Nullable(Type.Integer({ minimum: 0 })),
  finishedAt: Nullable(Instant),
  cost: Nullable(WorkerCost),
  stage: CardStage,
  wait: Nullable(WorkerMark),
  needsYou: Type.Boolean(),
  queueReason: Nullable(WorkerQueueReason),
  queuePosition: Nullable(Type.Integer({ minimum: 1 })),
}, strict);

/**
 * 资源摘要：本人的设备（online 看最近一次上报的时间，10 分钟内算在线）；running 和 cap 取在线设备最近一批同步报的 slots（本机程序契约的 LocalSlots）：
 * running 是占着位置的会话数（slots.running 相加，含不带岗位的卡），cap 是同时跑的上限（slots.max 相加，没有在线设备报过为 null）；
 * 今天和本月的花费（按开工日、公司时区算，只算本机报的，云端验收的模型花费不在里面）。
 */
export const WorkerResources = Type.Object({
  devices: Type.Array(Type.Object({
    id: Type.String({ format: "uuid" }),
    name: Type.String(),
    lastSeenAt: Nullable(Instant),
    online: Type.Boolean(),
  }, strict)),
  running: Type.Integer({ minimum: 0 }),
  cap: Nullable(Type.Integer({ minimum: 1 })),
  cost: Type.Object({ today: WorkerCost, month: WorkerCost }, strict),
}, strict);

/** GET /api/me/workers：进行中（等你的在前，再按开工时间）、已排队、已完成（今天，公司时区，新的在前），加资源摘要。 */
export const WorkersResponse = Type.Object({
  running: Type.Array(WorkerItem),
  queued: Type.Array(WorkerItem),
  done: Type.Array(WorkerItem),
  resources: WorkerResources,
}, strict);

export type TWorkerMark = Static<typeof WorkerMark>;
export type TWorkerQueueReason = Static<typeof WorkerQueueReason>;
export type TWorkerResource = Static<typeof WorkerResource>;
export type TWorkerCost = Static<typeof WorkerCost>;
export type TWorkerItem = Static<typeof WorkerItem>;
export type TWorkerResources = Static<typeof WorkerResources>;
export type TWorkersResponse = Static<typeof WorkersResponse>;
