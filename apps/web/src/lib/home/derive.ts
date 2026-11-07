/**
 * 新首页的数据：B 的 GET /api/me/work-home、/api/me/background、/api/me/tasks/:taskId/feed 回 404（实现还没上）时，
 * 由网页现有的几份数据照契约的形状拼出来——本月计划（Mission、Task）、云端的 worker 列表合进本机的实时会话（lib/work）、
 * 通知（会议、Mission Card、群消息）、岗位建议、合不回的卡。都是纯函数；B 的接口上了以后只用来补本机的实时部分。
 */
import type { TCardGit, TCardMerge, THomeItem, THomePlanResponse, TLocalWorkspace, TMissionRoundSummary, TSubSessionWaiting, TTaskView, TWaitingAnswer, TWorkerQueueReason } from "@warmap/contracts";
import { monthHref, pageHref } from "@/components/home/pageKeys";
import { isAgentCard, type CardItem } from "@/lib/board/cards";
import { calendarDate } from "@/lib/companyTime";
import type { MemberNotification, UnreadMissionGroup } from "@/components/member/useMemberHome";
import type { TLocalSessionSummary } from "@/lib/local/runner";
import type { RoleProposalView } from "@/lib/team/roles";
import { FIELD_LABEL } from "@/lib/team/roles";
import type { MergeIssue } from "@/lib/work/merge";
import { clock } from "./quota";
import { MARK_LABEL, type QueueReason, type Worker } from "@/lib/work/workers";
import type { BackgroundItem, BackgroundScope, FeedItem, HomeMission, HomeTask, RouteTarget, SubSession, WaitingItem, WorkHomeData } from "./types";

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

/** 「2026-10」→「10 月」：之前月份没了结、留在树上的 Mission 标一下。 */
export const monthLabel = (period: string) => `${Number(period.slice(5, 7))} 月`;

/** 等你一行点了去哪儿：契约给的是目标（open），网页映射到路由；网页自己拼的通知直接带地址。 */
export function waitingHref(item: Pick<WaitingItem, "open">): string {
  const { open } = item;
  switch (open.kind) {
    case "href": return open.href;
    case "card": return cardHref(open.id);
    case "topic": return topicHref(open.id);
    case "task": return taskHref(open.id);
    case "meeting": return `/me/meetings/${encodeURIComponent(open.id)}`;
    // 具体某张卡去那张卡；拍板人那一侧没有具体的卡（轮次），去原来列着轮次的首页通知栏。
    case "mission_card": return open.round ? "/me" : `/me/mission-cards/${encodeURIComponent(open.id)}`;
    case "role": return "/me/team";
    // 别人请你认可的 Task：只读的 Task 详情；月份页；连接页（这台电脑那一组）。
    case "task_detail": return infoHref(open.id);
    case "month": return monthHref(open.id);
    case "connections": return pageHref("connections");
  }
}

/** 已排队的原因（子会话行、事件行）：等额度恢复带恢复的时刻「等额度恢复 · 08:00」。 */
const QUEUE_TEXT: Record<TWorkerQueueReason, string> = { not_dispatched: "等开工", slot: "等空位", device_offline: "等本机上线", prior_cards: "等前面的卡", quota: "等额度恢复" };
export function queueText(reason: TWorkerQueueReason, holdUntil: string | null): string {
  return reason === "quota" && holdUntil ? `${QUEUE_TEXT.quota} · ${clock(holdUntil, Date.now())}` : QUEUE_TEXT[reason];
}

const QUEUE: Record<QueueReason, TWorkerQueueReason> = { start: "not_dispatched", slot: "slot", offline: "device_offline", folder: "slot", after: "prior_cards", quota: "quota" };
const EPOCH = new Date(0).toISOString();
const at = (worker: Worker) => worker.endedAt ?? worker.startedAt ?? worker.requestedAt ?? worker.item?.updatedAt ?? EPOCH;

/** 卡验收过以后合回到哪了：这台电脑上的工作树合过了是 merged；本机没能自动合回（needsMerge 带原因），或本人点合并没合成，是 needs_merge。 */
function mergeOf({ cardId, at: when, ws, git }: { cardId: string; at: string; ws: TLocalWorkspace | null; git: TCardGit | null }, merges: MergeIssue[]): TCardMerge | null {
  const issue = merges.find((entry) => entry.cardId === cardId);
  const base = ws?.kind === "worktree" ? ws.baseBranch : git?.baseBranch ?? null;
  if (issue) return { state: "needs_merge", commit: null, baseBranch: base, reason: null, message: issue.text, at: when };
  if (ws?.kind !== "worktree") return null;
  if (ws.mergedCommit) return { state: "merged", commit: ws.mergedCommit, baseBranch: ws.baseBranch, reason: null, message: null, at: when };
  // 本机验收过就自己试着合回（「验收过就合回」），合不了或关了才报 needsMerge 等你合；还没报的是正在合，不算等你。
  if (ws.needsMerge) return { state: "needs_merge", commit: null, baseBranch: ws.baseBranch, reason: ws.needsMerge.reason, message: ws.needsMerge.message, at: when };
  return null;
}
function cardMerge(worker: Worker, merges: MergeIssue[]): TCardMerge | null {
  if (worker.kind !== "card" || worker.state !== "done" || !worker.cardId) return null;
  return mergeOf({ cardId: worker.cardId, at: at(worker), ws: worker.workspace ?? worker.session?.workspace ?? null, git: worker.git }, merges);
}

/** 这台电脑上这张卡最近的那个执行会话（合回看它的工作树）。 */
const cardSession = (sessions: TLocalSessionSummary[], cardId: string) =>
  sessions.filter((session) => session.subject.kind === "card" && session.subject.cardId === cardId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;

/** 推翻了的「过」不算过；本人「仍然通过」的「没过」算过。 */
const passed = (handback: NonNullable<NonNullable<CardItem["card"]>["handback"]>) => handback.status === "done" && (handback.outcome === "pass") !== handback.overruled;

/**
 * 看板上已经验收过、worker 列表里没有的卡（worker 列表只带今天完成的）：照样折进「已完成」，没合回的照样等你合。
 */
function boardSub(card: CardItem, sessions: TLocalSessionSummary[], merges: MergeIssue[], deviceId: string | null): SubSession | null {
  const handback = card.card?.handback;
  if (!isAgentCard(card) || !handback || !passed(handback)) return null;
  const session = cardSession(sessions, card.id);
  const when = handback.finishedAt ?? card.updatedAt;
  const merge = mergeOf({ cardId: card.id, at: when, ws: session?.workspace ?? null, git: handback.git }, merges);
  const waiting = merge?.state === "needs_merge";
  return {
    id: card.id, kind: "card", title: card.title, state: waiting ? "waiting" : "done", waiting: waiting ? "merge" : null, queueReason: null,
    role: card.card?.role ?? null, sessionId: session?.id ?? null, deviceId: session ? deviceId : null, autoStart: false, updatedAt: when, merge, holdUntil: null,
  };
}

/**
 * 子会话在树上的状态（契约 SubSessionState 的对法，设计 5.4.2）：等你批准、等你回复、受阻、等你合回、已暂停是等你；
 * 验收第一次没过不单设状态，仍是进行中（阶段「重做中」，自动重做）；第二次没过是受阻（等你）。叉只给程序层面的失败。
 */
function subState(worker: Worker, merge: TCardMerge | null): Pick<SubSession, "state" | "waiting"> {
  if (worker.state === "done") return merge?.state === "needs_merge" ? { state: "waiting", waiting: "merge" } : { state: "done", waiting: null };
  if (worker.state === "queued") return { state: "queued", waiting: null };
  switch (worker.mark) {
    case "approval": return { state: "waiting", waiting: "approval" };
    case "reply": return { state: "waiting", waiting: "question" };
    case "blocked": return { state: "waiting", waiting: "verdict" };
    case "paused": return { state: "waiting", waiting: null };
    default: return { state: "running", waiting: null };
  }
}

/**
 * 能对话的 worker（执行的卡、探索的专题）→ 子会话；规划员不是（后台任务）。验收中云端只列验收员那一条（kind = verify），
 * 卡照样在树上，是进行中（契约：验收中 → running）。
 */
export function toSubSession(worker: Worker, merges: MergeIssue[] = [], deviceId: string | null = null): SubSession | null {
  const verifying = worker.kind === "verify" && !!worker.cardId;
  const id = worker.kind === "card" || verifying ? worker.cardId : worker.kind === "topic" ? worker.topicId : null;
  if (!id) return null;
  const merge = cardMerge(worker, merges);
  // 专题没有「完成」（契约修正 b5c2e100）：会话停下了（本机报 done）、异常退出了都算已暂停，在子会话里说「继续」。
  const topicStopped = worker.kind === "topic" && (worker.state === "done" || worker.session?.status === "done");
  return {
    id, kind: worker.kind === "topic" ? "topic" : "card", title: worker.title,
    ...(verifying ? { state: "running" as const, waiting: null } : topicStopped ? { state: "waiting" as const, waiting: null } : subState(worker, merge)),
    queueReason: worker.state === "queued" && worker.reason ? QUEUE[worker.reason] : null,
    holdUntil: worker.state === "queued" && worker.reason === "quota" ? worker.holdUntil : null,
    role: worker.role, sessionId: worker.session?.id ?? null, deviceId: worker.session ? deviceId : null, autoStart: false, updatedAt: at(worker), merge,
  };
}

const ORDER: Record<SubSession["state"], number> = { waiting: 0, failed: 1, running: 2, queued: 3, done: 4 };
/** 树上的顺序：等你的、没过的在前，然后在跑的、排着的，完成的最后；同一格按先后。 */
export const sortSubSessions = (list: SubSession[]) => [...list].sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.updatedAt.localeCompare(b.updatedAt));

/** 按公司时区比日子（结束时间是 UTC，公司今天是 +8 的日子）。 */
const sameDay = (iso: string, today: string) => calendarDate(iso) === today;

/** 契约的汇总：waiting 含没过的；doneToday 今天验收通过的；needsYou 等你里归这件 Task 的条数。 */
export function summarize(list: SubSession[], needsYou: number, today: string): HomeTask["summary"] {
  return {
    running: list.filter((entry) => entry.state === "running").length,
    waiting: list.filter((entry) => entry.state === "waiting" || entry.state === "failed").length,
    queued: list.filter((entry) => entry.state === "queued").length,
    done: list.filter((entry) => entry.state === "done").length,
    doneToday: list.filter((entry) => entry.state === "done" && sameDay(entry.updatedAt, today)).length,
    needsYou,
  };
}

/**
 * 首页 Task 一行的现状（设计 5.4.4）：按紧急程度「等你 1 · 进行中 2 · 已排队 1 · 今天完成 3」，是 0 的不写，最多三段；
 * 规划员在拆，最前面是「拆卡中」；还没开过子会话是「未开始」；本人确认完成是「已完成」。
 * needsYou 单拿出来：首页那一行它用计数样式（圆点加数字），后面跟淡色的其余几段。
 */
export function statusParts(task: Pick<HomeTask, "summary" | "planning" | "completedAt" | "subSessions">): { needsYou: number; rest: string[] } {
  if (task.completedAt) return { needsYou: 0, rest: ["已完成"] };
  const running = task.subSessions.filter((sub) => sub.state === "running" || sub.state === "failed").length;
  const { queued, doneToday, needsYou } = task.summary;
  const rest = [task.planning ? "拆卡中" : null, running ? `进行中 ${running}` : null, queued ? `已排队 ${queued}` : null, doneToday ? `今天完成 ${doneToday}` : null]
    .filter((part): part is string => !!part).slice(0, needsYou ? 2 : 3);
  return { needsYou, rest: needsYou || rest.length ? rest : ["未开始"] };
}
export function statusLine(task: Pick<HomeTask, "summary" | "planning" | "completedAt" | "subSessions">): string {
  const { needsYou, rest } = statusParts(task);
  return [needsYou ? `等你 ${needsYou}` : null, ...rest].filter(Boolean).join(" · ");
}

/** 「今天」行和首页页头的日期（5.6）：「11 月 7 日 周六」。today 是公司时区的 YYYY-MM-DD，没有就按这台电脑的钟。 */
export function todayLabel(today: string | null): string {
  const date = today ?? calendarDate(new Date().toISOString());
  const weekday = "日一二三四五六"[new Date(`${date}T00:00:00Z`).getUTCDay()];
  return `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日 周${weekday}`;
}

const short = (text: string, max = 28) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function deriveWorkHome({ plan, workers, boards, notices, proposals, merges, deviceId, sessions = [] }: {
  plan: THomePlanResponse | null;
  workers: Worker[];
  boards: Record<string, { plan: { status: string } | null; cards?: CardItem[]; drafts?: unknown[] } | undefined>;
  notices: NoticeSources | null;
  proposals: RoleProposalView[];
  merges: MergeIssue[];
  /** 这台电脑的本机程序 id（配对了才有）。 */
  deviceId: string | null;
  /** 这台电脑上的本机会话（看板上之前验收过的卡，合回看它的工作树）。 */
  sessions?: TLocalSessionSummary[];
}): WorkHomeData {
  const tasks = plan?.tasks ?? [];
  const today = plan?.today ?? calendarDate(new Date().toISOString());
  const known = new Set(tasks.map((task) => task.taskId));
  // 云端在验收时只列验收员那一条：卡本身也在列表里时以卡为准。
  const cardIds = new Set(workers.filter((worker) => worker.kind === "card").map((worker) => worker.cardId));
  const subs = (filter: (worker: Worker) => boolean) => workers.filter(filter).filter((worker) => !(worker.kind === "verify" && cardIds.has(worker.cardId)))
    .map((worker) => toSubSession(worker, merges, deviceId)).filter((entry): entry is SubSession => !!entry);
  const taskSubs = new Map(tasks.map((task) => {
    const live = subs((worker) => worker.taskId === task.taskId);
    const seen = new Set(live.map((sub) => sub.id));
    const past = (boards[task.taskId]?.cards ?? []).filter((card) => !seen.has(card.id)).map((card) => boardSub(card, sessions, merges, deviceId)).filter((entry): entry is SubSession => !!entry);
    return [task.taskId, sortSubSessions([...live, ...past])];
  }));
  const other = sortSubSessions(subs((worker) => !worker.taskId || !known.has(worker.taskId)));
  const all = [...[...taskSubs.values()].flat(), ...other];
  const waiting = sortWaiting([
    ...workerWaiting(workers, deviceId),
    ...tasks.flatMap((task) => mergeWaiting(taskSubs.get(task.taskId) ?? [], task, merges)), ...mergeWaiting(other, null, merges), ...orphanMerges(merges, all),
    ...planStartWaiting(tasks, boards), ...noticeWaiting(notices), ...proposalWaiting(proposals), ...monthWaiting(plan),
  ]);
  // Task 行的小字（设计 5.4.2）：预算、加预算、管线最近一句结论都还没有数据时，写这个 Mission 下一个验收时间点「11/20 验收」。
  const gateOf = (missionId: string) => {
    const dates = (plan?.gates ?? []).filter((gate) => gate.missionId === missionId).map((gate) => gate.date).sort();
    const date = dates.find((value) => value >= (plan?.today ?? "")) ?? dates[dates.length - 1];
    return date ? `${date.slice(5).replace("-", "/")} 验收` : null;
  };
  const missions: HomeMission[] = (plan?.missions ?? []).map((mission) => ({
    missionId: mission.missionId,
    title: mission.title,
    period: plan!.period,
    tasks: tasks.filter((task) => task.missionId === mission.missionId).map((task): HomeTask => {
      const subSessions = taskSubs.get(task.taskId) ?? [];
      const board = boards[task.taskId];
      const planning = workers.some((worker) => worker.kind === "plan" && worker.taskId === task.taskId && worker.state !== "done")
        || board?.plan?.status === "queued" || board?.plan?.status === "running";
      return {
        taskId: task.taskId, missionId: mission.missionId, name: task.name, subtitle: gateOf(mission.missionId),
        summary: summarize(subSessions, waiting.filter((item) => item.taskId === task.taskId).length, today),
        pipeline: { conversationId: null, scope: `plan-task:${task.taskId}` }, planning,
        // 计划里只有交付状态没有时间；这里只用来判「交付了」（Task 打勾、子会话收起）。
        completedAt: task.deliverable?.status === "delivered" ? `${today}T00:00:00.000Z` : null,
        subSessions,
        items: ownItems((plan?.activities ?? []).map((activity) => activity.item).filter((item) => item.planTaskId === task.taskId)),
      };
    }),
  }));
  return {
    // 本月按今天算：本月没有 Mission 时计划回退到上个月（fallbackFrom），那些 Mission 前面加「10 月 · 」。
    period: today.slice(0, 7),
    missions,
    other: { subSessions: other, items: ownItems(plan?.unplaced ?? []) },
    waiting,
  };
}

/** 等你批准写要做的事（「要运行命令」），等你回复写问的是什么；受阻、合回照标记。 */
export function askTitle(worker: Worker): string {
  if (worker.mark === "approval") return worker.ask ? (worker.ask.command ? "要运行命令" : worker.ask.text) : MARK_LABEL.approval;
  if (worker.mark === "reply") {
    const question = worker.session?.pendingQuestion?.questions[0];
    return question ? question.question : MARK_LABEL.reply;
  }
  return MARK_LABEL[worker.mark!];
}

/** 没过（第一次）不在这里：改法自动送回执行员重做，不打扰你；连续两次没过（受阻）才等你拍板。已暂停在子会话里说「继续」，也不在这里。 */
const WORKER_KIND = { approval: "approval", reply: "question", blocked: "verdict" } as const satisfies Record<string, TSubSessionWaiting>;

function workerWaiting(workers: Worker[], deviceId: string | null): WaitingItem[] {
  return workers.flatMap((worker): WaitingItem[] => {
    const who = worker.kind === "plan" ? "拆卡" : worker.kind === "verify" ? `验收「${worker.title}」` : worker.title;
    const source = [who, worker.taskName].filter(Boolean).join(" · ");
    const sessionId = worker.session?.id ?? null;
    const base = { taskId: worker.taskId, sessionId, deviceId: sessionId ? deviceId : null, at: worker.startedAt };
    const kind = worker.mark && worker.state === "doing" ? WORKER_KIND[worker.mark as keyof typeof WORKER_KIND] : undefined;
    if (!kind) return [];
    // 受阻在 Task 管线里拍板（按这个改 / 我去看看 / 仍然通过）；批准、回答在子会话里（规划员的在 Task 管线）。
    const open = kind === "verdict" && worker.taskId ? { kind: "task" as const, id: worker.taskId }
      : worker.kind === "topic" && worker.topicId ? { kind: "topic" as const, id: worker.topicId }
      : (worker.kind === "card" || worker.kind === "verify") && worker.cardId ? { kind: "card" as const, id: worker.cardId }
      : worker.taskId ? { kind: "task" as const, id: worker.taskId } : { kind: "href" as const, href: HOME_HREF };
    return [{ id: `worker:${worker.key}`, kind, title: askTitle(worker), source, open, ...base, ...fields("inline_local") }];
  });
}

/** 验收过了没合回的子会话：等你合（合不回的写原因）。 */
function mergeWaiting(subs: SubSession[], task: { taskId: string; name: string } | null, merges: MergeIssue[]): WaitingItem[] {
  return subs.filter((sub) => sub.waiting === "merge").map((sub) => {
    const issue = merges.find((entry) => entry.cardId === sub.id);
    return {
      id: `merge:${sub.id}`, kind: "merge", title: issue ? "合并不了" : `合进 ${sub.merge?.baseBranch ?? "原分支"}`,
      source: issue ? `${sub.title} · ${short(issue.text, 40)}` : [sub.title, task?.name].filter(Boolean).join(" · "),
      open: { kind: "card", id: sub.id }, taskId: task?.taskId ?? null, sessionId: sub.sessionId, deviceId: sub.deviceId, at: sub.merge?.at ?? sub.updatedAt, ...fields("inline_local"),
    };
  });
}

/** 合不回、但树上找不到那张卡的（卡不在本月的 Task 下）：照样等你合。 */
function orphanMerges(merges: MergeIssue[], subs: SubSession[]): WaitingItem[] {
  const shown = new Set(subs.map((sub) => sub.id));
  return merges.filter((issue) => !issue.cardId || !shown.has(issue.cardId)).map((issue) => ({
    id: `merge:${issue.sessionId}`, kind: "merge", title: "合并不了", source: `${issue.title} · ${short(issue.text, 40)}`,
    open: issue.cardId ? { kind: "card", id: issue.cardId } : { kind: "href", href: HOME_HREF }, taskId: null, sessionId: issue.sessionId, deviceId: null, at: null, ...fields("inline_local"),
  }));
}

const NONE = { taskId: null, sessionId: null, deviceId: null } as const;

/** 契约 9.6 加的几项（回退路径）：截止、电脑名、对方、月份先不填；answer 照能不能就地答。 */
const fields = (answer: TWaitingAnswer) => ({ answer, dueAt: null, deviceName: null, person: null, month: null });

function noticeWaiting(notices: NoticeSources | null): WaitingItem[] {
  if (!notices) return [];
  const unread = notices.notifications.filter((item) => !item.readAt);
  const meetings = unread.filter((item) => item.kind === "meeting_card_pending").map((item): WaitingItem => ({
    id: `notice:${item.id}`, kind: "meeting", title: item.subject ?? item.text, source: item.source ?? "会议记录待确认",
    open: { kind: "meeting", id: item.objectId }, at: item.createdAt, notificationId: item.id, ...NONE, ...fields("open"),
  }));
  const rounds = notices.rounds.filter((round) => round.todo).map((round): WaitingItem => {
    const mine = round.cards.find((card) => card.mine && card.contentVisible !== false);
    return {
      id: `round:${round.roundId}`, kind: "mission_card", title: round.todo!, source: `${round.battlefieldName} · Mission Card`,
      open: mine ? { kind: "mission_card", id: mine.cardId } : { kind: "mission_card", id: round.roundId, round: true }, at: round.openedAt, ...NONE, ...fields("open"),
    };
  });
  return [...meetings, ...rounds];
}

function proposalWaiting(proposals: RoleProposalView[]): WaitingItem[] {
  return proposals.map((proposal) => ({
    id: `proposal:${proposal.id}`, kind: "role", title: `${proposal.role.name}的${FIELD_LABEL[proposal.field]}改一句`,
    source: "岗位修改建议", open: { kind: "role", id: proposal.id }, at: proposal.createdAt, ...NONE, ...fields("inline"),
  }));
}

/** 计划等你开工（9.6）：规划员出了派活单、还没开工的 Task。就地「开始」= 接受草稿登记开工。 */
function planStartWaiting(tasks: { taskId: string; name: string }[], boards: Record<string, { drafts?: unknown[] } | undefined>): WaitingItem[] {
  return tasks.filter((task) => boards[task.taskId]?.drafts?.length).map((task) => ({
    id: `plan_start:${task.taskId}`, kind: "plan_start", title: `${task.name}：这样开工？`, source: `${boards[task.taskId]!.drafts!.length} 步`,
    open: { kind: "task", id: task.taskId }, taskId: task.taskId, sessionId: null, deviceId: null, at: null, ...fields("inline"),
  }));
}

/**
 * 空月份（5.4.4）：本月还没有 Mission（计划回退到上个月，或计划里没有本月的）时，「等你」里一行「11 月待敲定」，点了进月份页；
 * 「今天」行行尾的月份 chip 也从这一条来。云端给了月份那几条（复盘、待敲定、延续）就用云端的。
 */
export function monthWaiting(plan: THomePlanResponse | null): WaitingItem[] {
  if (!plan) return [];
  const period = plan.today.slice(0, 7);
  if (!plan.fallbackFrom && plan.missions.length && plan.period === period) return [];
  return [{
    id: `month:${period}:finalize`, kind: "month", title: `${monthLabel(period)}待敲定`, source: null, open: { kind: "month", id: period },
    ...NONE, at: null, ...fields("open"), month: { step: "finalize", period },
  }];
}

/** 「等你」的顺序（9.6）：卡住正在跑的活的（批准、回答、额度）在前，再是有截止的（早的在前），其余按时间新的在前。 */
const BLOCKING = new Set<WaitingItem["kind"]>(["approval", "question", "quota"]);
export function sortWaiting(items: WaitingItem[]): WaitingItem[] {
  const rank = (item: WaitingItem) => (BLOCKING.has(item.kind) ? 0 : item.dueAt ? 1 : 2);
  return [...items].sort((a, b) => rank(a) - rank(b)
    || (rank(a) === 1 ? a.dueAt!.localeCompare(b.dueAt!) : (b.at ?? "").localeCompare(a.at ?? "")));
}

/** 本人自己做的执行事项（9.10：没有岗位、不交给 Agent 的），挂在 Task 下；退回的不列，做完的照样列（Task 还在树上）。 */
function ownItems(items: TTaskView[]): THomeItem[] {
  return items.filter((item) => !isAgentCard(item) && item.status !== "returned").map((item) => ({
    id: item.id, title: item.title, status: item.status === "done" ? "done" : item.status === "in_progress" ? "in_progress" : "not_started",
    dueDate: item.dueDate, awaitingAcceptance: item.awaitingAcceptance, updatedAt: item.updatedAt,
  }));
}


// ── Task 管线里的验收行（契约 TaskFeedItem；B 的 /feed 没上时由看板上的卡拼）──

/**
 * 过了（含本人「仍然通过」）、受阻、约定都达到。过了的从看板上的卡拼（worker 列表只带今天完成的，隔天也要在）；受阻的卡还在做，从 worker 列表拼，
 * 已经送回（returnedAt）的不再问。合回后被推翻开的返工卡（rework_opened）要云端记谁推翻了谁，这里拼不出来，不出。
 * 第一次没过不出：改法自动送回重做，不打扰你。criteria 是看板的标准（没有标准时是完成定义那一条）。
 */
export function deriveFeed({ cards, workers, criteria, merges, sessions = [] }: {
  cards: CardItem[]; workers: Worker[]; criteria: string[]; merges: MergeIssue[]; sessions?: TLocalSessionSummary[];
}): FeedItem[] {
  const items: FeedItem[] = [];
  const met = new Map<number, string>();
  for (const card of cards) {
    const handback = card.card?.handback;
    if (!isAgentCard(card) || !handback?.finishedAt || !passed(handback)) continue;
    const merge = mergeOf({ cardId: card.id, at: handback.finishedAt, ws: cardSession(sessions, card.id)?.workspace ?? null, git: handback.git }, merges);
    items.push({ kind: "card_passed", id: `passed:${handback.id}`, at: handback.finishedAt, cardId: card.id, title: card.title, met: handback.met, total: handback.total, merge });
    const index = card.card?.criterion?.index;
    if (index) met.set(index, [met.get(index) ?? "", handback.finishedAt].sort().pop()!);
  }
  for (const worker of workers) {
    const handback = worker.item?.card?.handback;
    if (worker.kind !== "card" || !worker.cardId || !handback?.finishedAt || handback.returnedAt) continue;
    if (worker.state === "doing" && worker.mark === "blocked") {
      items.push({ kind: "card_blocked", id: `blocked:${handback.id}`, at: handback.finishedAt, cardId: worker.cardId, title: worker.title, handbackId: handback.id, fix: handback.returnText });
    }
  }
  if (criteria.length && criteria.every((_, i) => met.has(i + 1))) {
    const last = [...met.values()].sort().pop()!;
    items.push({ kind: "criteria_met", id: `criteria:${last}`, at: `${last}~`, met: criteria.length, total: criteria.length });
  }
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

// ── 后台任务（契约 BackgroundItem）──

const LIVE = new Set<TLocalSessionSummary["status"]>(["starting", "running", "waiting_permission", "queued", "idle"]);
/** 规划员、验收员：交完收工（done）是完成；退出了（停下、强停、本机程序重启）是停了。 */
const sessionState = (status: TLocalSessionSummary["status"]): BackgroundItem["state"] =>
  status === "queued" ? "queued" : status === "done" ? "done" : status === "exited" ? "stopped" : status === "failed" ? "failed" : "running";
const verifyTitle = (title: string) => `验收「${title.replace(/^验收[:：]\s*/, "")}」`;

/**
 * 这台电脑上本机程序报的：规划员（拆卡）、验收员（验收「卡」）两种会话，和各会话里 Claude Code 开的子 agent、后台命令。
 * id 和云端同一套（plan:<会话>、verify:<会话>、bg:<会话>:<task_id>），合并时这里的为准（实时）。卡的会话只带卡 id，Task 由 taskOfCard 查。
 */
export function localBackground({ sessions, deviceId, canStop, today, taskOfCard, taskOfTopic = () => null }: {
  sessions: TLocalSessionSummary[];
  deviceId: string | null;
  canStop: boolean;
  /** 公司时区的今天：结束了的只列今天结束的（契约：进行中的，加今天结束的）。 */
  today: string;
  taskOfCard: (cardId: string) => string | null;
  taskOfTopic?: (topicId: string) => string | null;
}): BackgroundItem[] {
  const recent = (item: BackgroundItem) => item.state === "running" || item.state === "queued" || !item.finishedAt || calendarDate(item.finishedAt) === today;
  return sessions.flatMap((session): BackgroundItem[] => {
    const { subject } = session;
    const cardId = subject.cardId ?? null;
    const topicId = subject.topicId ?? null;
    const taskId = subject.taskId ?? (cardId ? taskOfCard(cardId) : topicId ? taskOfTopic(topicId) : null);
    const where = { sessionId: session.id, deviceId, taskId, cardId, topicId };
    const own: BackgroundItem[] = subject.kind === "plan" || subject.kind === "verify" ? [{
      id: `${subject.kind}:${session.id}`, kind: subject.kind, title: subject.kind === "plan" ? "拆卡" : verifyTitle(session.title),
      state: session.hold ? "queued" : sessionState(session.status), startedAt: session.createdAt, finishedAt: LIVE.has(session.status) ? null : session.updatedAt,
      stoppable: canStop && LIVE.has(session.status), itemId: null, holdUntil: session.hold?.until ?? null, ...where,
    }] : [];
    const children = (session.background ?? []).map((item): BackgroundItem => ({
      id: `bg:${session.id}:${item.id}`, kind: item.kind, title: item.title, state: item.state, startedAt: item.startedAt, finishedAt: item.finishedAt,
      stoppable: canStop && item.stoppable, itemId: item.id, holdUntil: null, ...where,
    }));
    return [...own, ...children].filter(recent);
  });
}

/** 云端知道、这台电脑上没有会话的规划员和验收员（别的电脑上的、登记了还没开的拆卡）。B 的 /background 没上时用。 */
export function workerBackground(workers: Worker[]): BackgroundItem[] {
  return workers.filter((worker) => (worker.kind === "plan" || worker.kind === "verify") && !worker.session).map((worker): BackgroundItem => ({
    id: worker.key, kind: worker.kind as "plan" | "verify", title: worker.kind === "plan" ? "拆卡" : verifyTitle(worker.title),
    state: worker.state === "done" ? "done" : worker.state === "queued" ? "queued" : "running", startedAt: worker.startedAt, finishedAt: worker.endedAt,
    stoppable: false, sessionId: null, itemId: null, deviceId: null, taskId: worker.taskId, cardId: worker.kind === "verify" ? worker.cardId : null, topicId: null,
    holdUntil: worker.state === "queued" && worker.reason === "quota" ? worker.holdUntil : null,
  }));
}

/** 云端的和这台电脑上的合在一起：同一个 id 以这台电脑为准（状态、能不能停）；这台电脑不知道挂在哪的（专题、之前的卡），用云端的。 */
export function mergeBackground(cloud: BackgroundItem[], local: BackgroundItem[]): BackgroundItem[] {
  const byId = new Map(cloud.map((item) => [item.id, item]));
  return [
    ...cloud.filter((item) => !local.some((mine) => mine.id === item.id)),
    ...local.map((item) => {
      const there = byId.get(item.id);
      return there ? { ...item, taskId: item.taskId ?? there.taskId, cardId: item.cardId ?? there.cardId, topicId: item.topicId ?? there.topicId } : item;
    }),
  ];
}

export function inScope(items: BackgroundItem[], scope: BackgroundScope): BackgroundItem[] {
  if (scope === "main") return items;
  const [kind, id] = scope.split(/:(.*)/s) as [string, string];
  return items.filter((item) => (kind === "task" ? item.taskId === id : kind === "card" ? item.cardId === id : item.topicId === id));
}

/** 进行中（含已排队，排在后面）和已完成两组；失败、停了的算已完成那组。 */
export function groupBackground(items: BackgroundItem[]): { running: BackgroundItem[]; finished: BackgroundItem[] } {
  const rank = (item: BackgroundItem) => (item.state === "running" ? 0 : 1);
  return {
    running: items.filter((item) => item.state === "running" || item.state === "queued").sort((a, b) => rank(a) - rank(b) || (a.startedAt ?? "").localeCompare(b.startedAt ?? "")),
    finished: items.filter((item) => item.state === "done" || item.state === "failed" || item.state === "stopped").sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? "")),
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
 * 「自动」只在管线之间选（第 4.1 条）：消息里提到哪件 Task 的名字或标准里的词，就发给那件 Task；一件都没提到、或提到好几件，交给伙伴。
 * B 的 POST /api/me/route 没上时用这个，规则相同。
 */
export function routeText(text: string, tasks: { taskId: string; name: string; criteria: string[]; doneDefinition?: string | null }[]): RouteTarget {
  const hits = tasks.filter((task) => keywords(task).some((word) => text.includes(word)));
  return hits.length === 1 ? { taskId: hits[0]!.taskId } : "main";
}
