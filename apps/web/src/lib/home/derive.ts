/**
 * 新首页的数据，在 B 的 GET /api/me/work-home、/api/me/background、/api/me/route 到之前，由网页现有的几份数据拼出来：
 * 本月计划（Mission、Task）、云端的 worker 列表合进本机的实时会话（lib/work）、通知（会议、Mission Card、群消息）、岗位建议、合不回的卡。
 * 都是纯函数，换成 B 的接口时只换 useWorkHome 里的来源。
 */
import type { THomePlanResponse, TMissionRoundSummary } from "@warmap/contracts";
import type { MemberNotification, UnreadMissionGroup } from "@/components/member/useMemberHome";
import type { TLocalSessionSummary } from "@/lib/local/runner";
import type { TaskBoard } from "@/lib/board/useTaskBoard";
import type { RoleProposalView } from "@/lib/team/roles";
import { FIELD_LABEL } from "@/lib/team/roles";
import type { MergeIssue } from "@/lib/work/merge";
import { MARK_LABEL, type Worker } from "@/lib/work/workers";
import type {
  BackgroundItem, BackgroundScope, BackgroundState, HomeMission, HomeTask, RouteTarget, SubSession, SubSessionState, SubSessionWait, TaskSummary, WaitingItem, WorkHomeData,
} from "./types";

export type UnreadThread = { objectType: string; objectId: string; title: string; unread: number; href: string };
export type NoticeSources = {
  notifications: MemberNotification[];
  rounds: TMissionRoundSummary[];
  unreadThreads: UnreadThread[];
  unreadMissionGroups: UnreadMissionGroup[];
};

export const cardHref = (cardId: string) => `/me/work/cards/${encodeURIComponent(cardId)}`;
export const topicHref = (topicId: string) => `/me/work/topics/${encodeURIComponent(topicId)}`;
export const taskHref = (taskId: string) => `/me/work/tasks/${encodeURIComponent(taskId)}`;
export const infoHref = (taskId: string) => `/me/work/tasks/${encodeURIComponent(taskId)}/info`;
export const BUDDY_HREF = "/me/work/buddy";
export const HOME_HREF = "/me/work";

/** 子会话在树上的状态：等你批准、等你回复、受阻、已暂停是等你（小圆点）；验收没过是叉；验收中还在跑。 */
function subState(worker: Worker): { state: SubSessionState; waiting?: SubSessionWait } {
  if (worker.state === "done") return { state: "done" };
  if (worker.state === "queued") return { state: "queued" };
  switch (worker.mark) {
    case "approval": return { state: "waiting", waiting: "approval" };
    case "reply": return { state: "waiting", waiting: "question" };
    case "blocked": return { state: "waiting", waiting: "verdict" };
    case "paused": return { state: "waiting" };
    case "review_failed": return { state: "failed" };
    default: return { state: "running" };
  }
}

const at = (worker: Worker) => worker.endedAt ?? worker.startedAt ?? worker.requestedAt ?? worker.item?.updatedAt ?? new Date(0).toISOString();

/** 能对话的 worker（执行的卡、探索的专题）→ 子会话；规划员、验收员不是。 */
export function toSubSession(worker: Worker): SubSession | null {
  const id = worker.kind === "card" ? worker.cardId : worker.kind === "topic" ? worker.topicId : null;
  if (!id) return null;
  return { id, kind: worker.kind as "card" | "topic", title: worker.title, ...subState(worker), updatedAt: at(worker) };
}

const ORDER: Record<SubSessionState, number> = { waiting: 0, failed: 1, running: 2, queued: 3, done: 4 };
/** 树上的顺序：等你的、没过的在前，然后在跑的、排着的，完成的最后；同一格按先后。 */
export const sortSubSessions = (list: SubSession[]) => [...list].sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.updatedAt.localeCompare(b.updatedAt));

export function summarize(list: SubSession[]): TaskSummary {
  return {
    // 没过的正在自动重做，算进行中（树上照样是叉）。
    running: list.filter((entry) => entry.state === "running" || entry.state === "failed").length,
    // 没过的会自动送回重做（设计第 4.5 条），已暂停在子会话里说继续，都不算等你；和首页「等你」列的一致。
    waiting: list.filter((entry) => entry.state === "waiting" && entry.waiting).length,
    queued: list.filter((entry) => entry.state === "queued").length,
    done: list.filter((entry) => entry.state === "done").length,
  };
}

/** 首页 Task 一行的现状：「进行中 2 · 等你 1」，什么都没有是「还没开始」，规划员在拆是「拆卡中」。 */
export function statusLine(task: Pick<HomeTask, "summary" | "planning"> & { delivered?: boolean }): string {
  if (task.delivered) return "已完成";
  const { running, waiting, queued, done } = task.summary;
  const parts = [waiting ? `等你 ${waiting}` : null, running ? `进行中 ${running}` : null, queued ? `已排队 ${queued}` : null, done ? `已完成 ${done}` : null].filter(Boolean);
  if (task.planning) return ["拆卡中", ...parts].join(" · ");
  return parts.length ? parts.join(" · ") : "还没开始";
}

const short = (text: string, max = 28) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function deriveWorkHome({ plan, workers, boards, notices, proposals, merges }: {
  plan: THomePlanResponse | null;
  workers: Worker[];
  boards: Record<string, TaskBoard>;
  notices: NoticeSources | null;
  proposals: RoleProposalView[];
  merges: MergeIssue[];
}): WorkHomeData {
  const tasks = plan?.tasks ?? [];
  const known = new Set(tasks.map((task) => task.taskId));
  const subs = (filter: (worker: Worker) => boolean) => sortSubSessions(workers.filter(filter).map(toSubSession).filter((entry): entry is SubSession => !!entry));
  const missions: HomeMission[] = (plan?.missions ?? []).map((mission) => ({
    missionId: mission.missionId,
    title: mission.title,
    tasks: tasks.filter((task) => task.missionId === mission.missionId).map((task): HomeTask => {
      const subSessions = subs((worker) => worker.taskId === task.taskId);
      const board = boards[task.taskId];
      const planning = workers.some((worker) => worker.kind === "plan" && worker.taskId === task.taskId && worker.state === "doing")
        || board?.plan?.status === "queued" || board?.plan?.status === "running";
      return {
        taskId: task.taskId, name: task.name, subtitle: task.doneDefinition?.trim() || task.criteria[0] || null,
        summary: summarize(subSessions), pipeline: { conversationId: null }, planning, delivered: task.deliverable?.status === "delivered", subSessions,
      };
    }),
  })).filter((mission) => mission.tasks.length);
  return {
    missions,
    other: { subSessions: subs((worker) => !worker.taskId || !known.has(worker.taskId)) },
    waiting: [...workerWaiting(workers), ...noticeWaiting(notices), ...proposalWaiting(proposals), ...mergeWaiting(merges)],
  };
}

function workerHref(worker: Worker): string {
  if (worker.kind === "card" && worker.cardId) return cardHref(worker.cardId);
  if (worker.kind === "topic" && worker.topicId) return topicHref(worker.topicId);
  if (worker.kind === "verify" && worker.cardId) return cardHref(worker.cardId);
  return worker.taskId ? taskHref(worker.taskId) : HOME_HREF;
}

/** 等你批准写要做的事（「要运行命令」），等你回复写问的是什么；受阻、验收没过照标记。 */
export function askTitle(worker: Worker): string {
  if (worker.mark === "approval") return worker.ask ? (worker.ask.command ? "要运行命令" : worker.ask.text) : MARK_LABEL.approval;
  if (worker.mark === "reply") {
    const question = worker.session?.pendingQuestion?.questions[0];
    return question ? question.question : MARK_LABEL.reply;
  }
  return MARK_LABEL[worker.mark!];
}

/** 没过（第一次）不在这里：改法自动送回执行员重做，不打扰你；连续两次没过（受阻）才等你拍板。已暂停在子会话里说「继续」，也不在这里。 */
const WORKER_KIND = { approval: "approval", reply: "question", blocked: "verdict" } as const;

function workerWaiting(workers: Worker[]): WaitingItem[] {
  return workers.flatMap((worker): WaitingItem[] => {
    const kind = worker.mark && worker.state === "doing" ? WORKER_KIND[worker.mark as keyof typeof WORKER_KIND] : undefined;
    if (!kind) return [];
    const who = worker.kind === "plan" ? "拆卡" : worker.kind === "verify" ? `验收「${worker.title}」` : worker.title;
    return [{
      id: `worker:${worker.key}`, kind, title: askTitle(worker), source: [who, worker.taskName].filter(Boolean).join(" · "),
      href: kind === "verdict" && worker.taskId ? taskHref(worker.taskId) : workerHref(worker), at: worker.startedAt, ref: { workerKey: worker.key },
    }];
  });
}

function noticeWaiting(notices: NoticeSources | null): WaitingItem[] {
  if (!notices) return [];
  const unread = notices.notifications.filter((item) => !item.readAt);
  const meetings = unread.filter((item) => item.kind === "meeting_card_pending").map((item): WaitingItem => ({
    id: `notice:${item.id}`, kind: "meeting", title: item.subject ?? item.text, source: item.source ?? "会议记录待确认",
    href: `/me/meetings/${encodeURIComponent(item.objectId)}`, at: item.createdAt, ref: { notificationId: item.id },
  }));
  const assigned = unread.filter((item) => item.kind === "meeting_action_assigned").map((item): WaitingItem => ({
    id: `notice:${item.id}`, kind: "assigned", title: item.subject ?? item.text, source: item.source ? `「${item.source}」分给你` : "会后分给你",
    href: `/me/tasks/${encodeURIComponent(item.objectId)}`, at: item.createdAt, ref: { notificationId: item.id },
  }));
  const rounds = notices.rounds.filter((round) => round.todo).map((round): WaitingItem => ({
    id: `round:${round.roundId}`, kind: "mission_card", title: round.todo!, source: `${round.battlefieldName} · Mission Card`,
    href: "/me/mission-cards", at: round.openedAt, ref: {},
  }));
  const threads = notices.unreadThreads.map((thread): WaitingItem => ({
    id: `thread:${thread.objectType}:${thread.objectId}`, kind: "thread", title: thread.title, source: `${thread.unread} 条新消息`,
    href: thread.href, at: null, ref: {},
  })).concat(notices.unreadMissionGroups.map((group): WaitingItem => ({
    id: `thread:mission-card:${group.cardId}`, kind: "thread", title: group.title, source: `${group.unread} 条新消息`, href: group.href, at: null, ref: {},
  })));
  return [...meetings, ...rounds, ...assigned, ...threads];
}

function proposalWaiting(proposals: RoleProposalView[]): WaitingItem[] {
  return proposals.map((proposal) => ({
    id: `proposal:${proposal.id}`, kind: "role", title: `${proposal.role.name}的${FIELD_LABEL[proposal.field]}改一句`,
    source: "岗位修改建议", href: "/me/team", at: proposal.createdAt, ref: { proposalId: proposal.id },
  }));
}

function mergeWaiting(merges: MergeIssue[]): WaitingItem[] {
  return merges.map((issue) => ({
    id: `merge:${issue.sessionId}`, kind: "merge", title: "合并不了", source: `${issue.title} · ${short(issue.text, 40)}`,
    href: issue.cardId ? cardHref(issue.cardId) : HOME_HREF, at: null, ref: { sessionId: issue.sessionId },
  }));
}

const LIVE = new Set(["starting", "running", "waiting_permission", "queued", "idle"]);
const bgState = (worker: Worker): BackgroundState => (worker.session?.status === "failed" ? "failed" : worker.state === "done" ? "done" : worker.state === "queued" ? "queued" : "running");

/**
 * 后台任务：规划员（拆卡）、验收员（验收「卡」）来自 worker 列表；子 agent、后台命令要本机程序报上来（D 在做），
 * 由 local 补：这台电脑上拆完的规划员（worker 列表拆完就不列了），用假本机程序时再补子 agent、命令各几条（真程序没报之前没有）。
 */
export function backgroundItems({ workers, scope, canStop, local = [] }: {
  workers: Worker[];
  scope: BackgroundScope;
  /** 这台电脑能不能停（本机连着、不是手机）。 */
  canStop: boolean;
  local?: (BackgroundItem & { taskId: string | null; cardId: string | null; topicId: string | null })[];
}): BackgroundItem[] {
  const own = workers.filter((worker) => worker.kind === "plan" || worker.kind === "verify").map((worker) => ({
    item: {
      id: worker.key, kind: worker.kind as "plan" | "verify", title: worker.kind === "plan" ? "拆卡" : `验收「${worker.title}」`, state: bgState(worker),
      startedAt: worker.startedAt, finishedAt: worker.endedAt,
      stoppable: canStop && !!worker.session && LIVE.has(worker.session.status), ...(worker.session ? { sessionId: worker.session.id } : {}),
    } satisfies BackgroundItem,
    taskId: worker.taskId, cardId: worker.kind === "verify" ? worker.cardId : null, topicId: null as string | null,
  }));
  const children = local.map(({ taskId, cardId, topicId, ...item }) => ({ item, taskId, cardId, topicId }));
  const inScope = (entry: { taskId: string | null; cardId: string | null; topicId: string | null }) => {
    if (scope === "main") return true;
    const [kind, id] = scope.split(":") as [string, string];
    return kind === "task" ? entry.taskId === id : kind === "card" ? entry.cardId === id : entry.topicId === id;
  };
  return [...own, ...children].filter(inScope).map((entry) => entry.item);
}

/** 进行中（含已排队，排在后面）和已完成两组；失败算已完成那组。 */
export function groupBackground(items: BackgroundItem[]): { running: BackgroundItem[]; finished: BackgroundItem[] } {
  const rank = (item: BackgroundItem) => (item.state === "running" ? 0 : 1);
  return {
    running: items.filter((item) => item.state === "running" || item.state === "queued").sort((a, b) => rank(a) - rank(b) || (a.startedAt ?? "").localeCompare(b.startedAt ?? "")),
    finished: items.filter((item) => item.state === "done" || item.state === "failed").sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? "")),
  };
}

/** 用时：「12 秒」「3 分」「1 小时 5 分」。 */
export function duration(from: string | null, to: string | number | null): string | null {
  if (!from) return null;
  const end = typeof to === "string" ? Date.parse(to) : to ?? Date.now();
  const seconds = Math.max(0, Math.round((end - Date.parse(from)) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} 分` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/** 关键词：Task 名，和标准、完成定义里四个字以上的片段。 */
function keywords(task: { name: string; criteria: string[]; doneDefinition?: string | null }): string[] {
  const pieces = [task.doneDefinition ?? "", ...task.criteria].flatMap((text) => text.split(/[\s,，。、；;：:（）()「」“”"'《》/|·\-—]+/)).filter((piece) => piece.length >= 4);
  return [task.name.trim(), ...pieces].filter(Boolean);
}

/**
 * 「自动」先不用模型（第 4.1 条）：消息里提到哪件 Task 的名字或标准里的词，就发给那件 Task；一件都没提到、或提到好几件，交给伙伴。
 * B 的 POST /api/me/route 到了以后换成它。
 */
export function routeText(text: string, tasks: { taskId: string; name: string; criteria: string[]; doneDefinition?: string | null }[]): RouteTarget {
  const hits = tasks.filter((task) => keywords(task).some((word) => text.includes(word)));
  return hits.length === 1 ? { taskId: hits[0]!.taskId } : "main";
}
