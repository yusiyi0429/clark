/**
 * worker 和链路（V2 设计第 20.1、20.2 节，契约 workers.ts）：岗位这一趟派出去的执行就是一个 worker（「开发 #2」），每个都在
 * 「已排队 → 进行中 → 已完成」这条链的某一格上；已排队写清在等什么，进行中的情况用标记。
 * 列表来自云端 GET /api/me/workers；网页在这台电脑上再合进本机的实时状态（排队、等你批准、等你回复、已暂停以本机为准）。
 */
import type { TRoleRef, TWorkerItem, TWorkerMark } from "@warmap/contracts";
import type { TLocalSessionSummary } from "@/lib/local/runner";
import { localWaitOf, type CardItem } from "@/lib/board/cards";

export type ChainState = "queued" | "doing" | "done";
/** 等开工：本人确认了还没交给本机；等空位：本机同时跑的满了；等本机上线。 */
export type QueueReason = "start" | "slot" | "offline";
export type WorkerMark = TWorkerMark;

export const CHAIN_LABEL: Record<ChainState, string> = { queued: "已排队", doing: "进行中", done: "已完成" };
export const QUEUE_LABEL: Record<QueueReason, string> = { start: "等开工", slot: "等空位", offline: "等本机上线" };
export const MARK_LABEL: Record<WorkerMark, string> = { approval: "等你批准", reply: "等你回复", paused: "已暂停", reviewing: "验收中", review_failed: "验收没过", blocked: "受阻" };
/** 「等你」：要本人动手的几种。 */
export const WAITING: WorkerMark[] = ["approval", "reply", "review_failed", "blocked"];
export const isWaiting = (mark: WorkerMark | null) => !!mark && WAITING.includes(mark);
const REASON: Record<NonNullable<TWorkerItem["queueReason"]>, QueueReason> = { not_dispatched: "start", slot: "slot", device_offline: "offline" };

export type Worker = {
  key: string;
  kind: "card" | "topic";
  cardId: string | null;
  topicId: string | null;
  title: string;
  /** 验收中时是验收员；kind 决定头像底色。 */
  role: TRoleRef;
  /** 「开发 #2」的号。 */
  seq: number;
  taskId: string | null;
  taskName: string | null;
  missionId: string | null;
  state: ChainState;
  reason: QueueReason | null;
  mark: WorkerMark | null;
  /** 在干什么：当前计划条目。 */
  doing: string | null;
  step: { n: number; total: number } | null;
  where: "local" | "cloud" | null;
  device: string | null;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  costUsd: number | null;
  tokens: number;
  /** 已排队里排第几（本机报的；云端转来的，这台电脑上以本机会话为准）。 */
  queuePos: number | null;
  /** 等你批准时要做的事（「运行 pnpm test」），命令单独给。 */
  ask: { text: string; command: string | null } | null;
  /** 这台电脑上本机的会话（能在这里批准、回复）。 */
  session: TLocalSessionSummary | null;
  /** 卡本身（看板接口来的，带交回和交付物）；专题没有。 */
  item: CardItem | null;
};

export const workerName = (worker: Pick<Worker, "role" | "seq">) => `${worker.role.name} #${worker.seq}`;
export const resourceText = (worker: Pick<Worker, "where" | "model">) =>
  [worker.where === "cloud" ? "云端" : worker.where === "local" ? "本机" : null, worker.model].filter(Boolean).join(" · ") || null;
const OCCUPYING = new Set(["starting", "running", "waiting_permission"]);

/** 云端的一条 + 这台电脑上的本机会话 + 卡本身 → 界面上的 worker。 */
export function toWorker(entry: TWorkerItem, { sessions, cards, deviceName }: { sessions: TLocalSessionSummary[]; cards: Map<string, CardItem>; deviceName: string | null }): Worker {
  const session = sessions.find((candidate) => (entry.cardId && candidate.subject.cardId === entry.cardId) || (entry.topicId && candidate.subject.topicId === entry.topicId)) ?? null;
  let state: ChainState = entry.stage === "todo" ? "queued" : entry.stage === "done" ? "done" : "doing";
  let reason: QueueReason | null = state === "queued" ? REASON[entry.queueReason ?? "not_dispatched"] : null;
  let mark: WorkerMark | null = state === "doing" ? entry.wait : null;
  let queuePos: number | null = entry.queuePosition;
  // 本机的更新：排队、开工、等你批准、等你回复、已暂停以这台电脑为准；验收中、验收没过、受阻只有云端知道。
  if (session && state !== "done" && mark !== "reviewing" && mark !== "review_failed" && mark !== "blocked") {
    if (session.status === "queued") { state = "queued"; reason = "slot"; mark = null; queuePos = session.queuePosition; }
    else { state = "doing"; reason = null; mark = localWaitOf(session); }
  }
  return {
    key: entry.key, kind: entry.kind, cardId: entry.cardId, topicId: entry.topicId, title: entry.title, role: entry.role, seq: entry.workerNo,
    taskId: entry.task?.id ?? null, taskName: entry.task?.name ?? null, missionId: entry.mission?.id ?? null,
    state, reason, mark, queuePos,
    doing: entry.step?.label ?? null,
    step: entry.step ? { n: entry.step.n, total: entry.step.total } : null,
    where: entry.resource?.where ?? (session ? "local" : null),
    device: entry.resource?.deviceName ?? (session ? deviceName : null),
    model: session?.modelLabel ?? entry.resource?.modelLabel ?? null,
    startedAt: entry.startedAt ?? session?.createdAt ?? null,
    endedAt: entry.finishedAt,
    costUsd: entry.cost?.costUsd ?? session?.usage.costUsd ?? null,
    tokens: entry.cost ? entry.cost.inputTokens + entry.cost.outputTokens : session ? session.usage.inputTokens + session.usage.outputTokens : 0,
    ask: null,
    session,
    item: entry.cardId ? cards.get(entry.cardId) ?? null : null,
  };
}

const WAIT_RANK: (WorkerMark | null)[] = ["approval", "reply", "review_failed", "blocked", "paused", "reviewing", null];
const rank = (worker: Worker) => WAIT_RANK.indexOf(worker.mark);
const POS = (worker: Worker) => worker.queuePos ?? Number.MAX_SAFE_INTEGER;

/** 三组：进行中（等你的在最前，再按开工时间）、已排队（排第几、再按先后）、已完成（云端只给今天的，新的在前）。 */
export function groupWorkers(workers: Worker[]): Record<ChainState, Worker[]> {
  return {
    doing: workers.filter((worker) => worker.state === "doing").sort((a, b) => rank(a) - rank(b) || (a.startedAt ?? "").localeCompare(b.startedAt ?? "")),
    queued: workers.filter((worker) => worker.state === "queued").sort((a, b) => POS(a) - POS(b)),
    done: workers.filter((worker) => worker.state === "done").sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? "")),
  };
}

/** 链路数字。 */
export function chainCounts(workers: Worker[]): Record<ChainState, number> {
  return { queued: workers.filter((w) => w.state === "queued").length, doing: workers.filter((w) => w.state === "doing").length, done: workers.filter((w) => w.state === "done").length };
}

/** 用时：「12 分钟」「1 小时 5 分」。 */
export function elapsed(from: string | null, to: number | string | null = Date.now()): string | null {
  if (!from) return null;
  const end = typeof to === "string" ? Date.parse(to) : to ?? Date.now();
  const minutes = Math.max(0, Math.round((end - Date.parse(from)) / 60_000));
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/** 本机占着位置的会话（开工中、进行中、等你批准）。 */
export const liveSessions = (sessions: TLocalSessionSummary[]) => sessions.filter((session) => OCCUPYING.has(session.status));
