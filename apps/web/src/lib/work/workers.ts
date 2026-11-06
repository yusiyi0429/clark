/**
 * worker 和链路（V2 设计第 20.1、20.2 节，契约 workers.ts）：岗位这一趟派出去的执行就是一个 worker（「开发 #2」），每个都在
 * 「已排队 → 进行中 → 已完成」这条链的某一格上；已排队写清在等什么，进行中的情况用标记。
 * 列表来自云端 GET /api/me/workers；网页在这台电脑上再合进本机的实时状态（排队、等你批准、等你回复、已暂停以本机为准）。
 * 规划员、验收员也是 worker（第 21 节）：都在本机跑、占位置；交回后本机接的验收员让那张卡的一行变成「验收员 · 验收中」。
 */
import type { TRoleRef, TWorkerItem, TWorkerMark } from "@warmap/contracts";
import type { TLocalSessionSummary } from "@/lib/local/runner";
import { localWaitOf, type CardItem } from "@/lib/board/cards";
import type { SplitRequest } from "./splits";

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
  /** plan：规划员（拆一个 Task）。 */
  kind: "card" | "topic" | "plan";
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
  /** 登记了还没开的规划员：哪条登记、什么时候登记的。 */
  splitId?: string;
  requestedAt?: string;
};

export const PLANNER: TRoleRef = { id: "", name: "规划员", kind: "worker" };
export const VERIFIER: TRoleRef = { id: "", name: "验收员", kind: "reviewer" };

export const workerName = (worker: Pick<Worker, "role" | "seq">) => `${worker.role.name} #${worker.seq}`;
export const resourceText = (worker: Pick<Worker, "where" | "model">) =>
  [worker.where === "cloud" ? "云端" : worker.where === "local" ? "本机" : null, worker.model].filter(Boolean).join(" · ") || null;
const OCCUPYING = new Set(["starting", "running", "waiting_permission"]);
const ACTIVE = new Set(["queued", ...OCCUPYING]);

/** 云端的一条 + 这台电脑上的本机会话 + 卡本身 → 界面上的 worker。 */
export function toWorker(entry: TWorkerItem, { sessions, cards, deviceName }: { sessions: TLocalSessionSummary[]; cards: Map<string, CardItem>; deviceName: string | null }): Worker {
  const session = sessions.find((candidate) => {
    const subject = candidate.subject;
    return (subject.kind === "card" && !!entry.cardId && subject.cardId === entry.cardId) || (subject.kind === "topic" && !!entry.topicId && subject.topicId === entry.topicId);
  }) ?? null;
  const verify = sessions.find((candidate) => {
    const subject = candidate.subject;
    return subject.kind === "verify" && subject.cardId === entry.cardId && ACTIVE.has(candidate.status);
  }) ?? null;
  let state: ChainState = entry.stage === "todo" ? "queued" : entry.stage === "done" ? "done" : "doing";
  let reason: QueueReason | null = state === "queued" ? REASON[entry.queueReason ?? "not_dispatched"] : null;
  let mark: WorkerMark | null = state === "doing" ? entry.wait : null;
  let queuePos: number | null = entry.queuePosition;
  // 本机的更新：排队、开工、等你批准、等你回复、已暂停以这台电脑为准；验收中、验收没过、受阻只有云端知道。
  if (session && state !== "done" && mark !== "reviewing" && mark !== "review_failed" && mark !== "blocked") {
    if (session.status === "queued") { state = "queued"; reason = "slot"; mark = null; queuePos = session.queuePosition; }
    else { state = "doing"; reason = null; mark = localWaitOf(session); }
  }
  const worker: Worker = {
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
  // 交回后本机接的验收员在这台电脑上：这一行换成验收员（排队时写等空位），资源是本机；回复、说一句仍对执行的会话。
  if (!verify || state === "done") return worker;
  const queued = verify.status === "queued";
  return {
    ...worker, role: entry.role.kind === "reviewer" ? entry.role : VERIFIER,
    state: queued ? "queued" : "doing", reason: queued ? "slot" : null, mark: queued ? null : "reviewing", queuePos: verify.queuePosition,
    doing: null, step: null, where: "local", device: deviceName, model: verify.modelLabel,
  };
}

/**
 * 规划员（第 21.3 节）：这台电脑上的 plan 会话（拆完退出就不再列，派活单接着出），
 * 加登记了还没开的「拆卡 · 等开工」（同一个 Task 已经有规划员在跑的不重复列）。
 */
export function plannerWorkers({ sessions, splits, tasks, deviceName }: {
  sessions: TLocalSessionSummary[]; splits: SplitRequest[]; tasks: { taskId: string; name: string; missionId: string | null }[]; deviceName: string | null;
}): Worker[] {
  const base = (taskId: string): Omit<Worker, "key" | "state" | "reason" | "mark" | "queuePos" | "model" | "startedAt" | "session"> => {
    const task = tasks.find((entry) => entry.taskId === taskId);
    return { kind: "plan", cardId: null, topicId: null, title: "拆卡", role: PLANNER, seq: 1, taskId, taskName: task?.name ?? null, missionId: task?.missionId ?? null,
      doing: null, step: null, where: "local", device: deviceName, endedAt: null, costUsd: null, tokens: 0, ask: null, item: null };
  };
  const running = sessions.flatMap((session): Worker[] => {
    const subject = session.subject;
    if (subject.kind !== "plan" || !subject.taskId || (!ACTIVE.has(session.status) && session.status !== "idle")) return [];
    const queued = session.status === "queued";
    return [{ ...base(subject.taskId), key: `plan:${session.id}`, state: queued ? "queued" : "doing", reason: queued ? "slot" : null, mark: queued ? null : localWaitOf(session),
      queuePos: session.queuePosition, model: session.modelLabel, startedAt: session.createdAt, session,
      costUsd: session.usage.costUsd, tokens: session.usage.inputTokens + session.usage.outputTokens }];
  });
  const busy = new Set(running.map((worker) => worker.taskId));
  const waiting = splits.filter((request) => !busy.has(request.taskId)).map((request): Worker => ({
    ...base(request.taskId), key: `split:${request.id}`, state: "queued", reason: "start", mark: null, queuePos: null, model: null, startedAt: null, session: null,
    splitId: request.id, requestedAt: request.createdAt,
  }));
  return [...running, ...waiting];
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
