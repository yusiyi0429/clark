/**
 * 橙点就意味着有能点的框（设计 17.2 第 54 条）：左栏的点、子会话页头的标签、首页「等你」只从这一处算——
 * 这个会话现在有没有等本人处理的框：批准、提问、受阻要拿主意、等你合回。有才是橙点；别的（停了、本人没看过）是蓝点或不画。
 *
 * 两份数据并成一个：
 * - 批准、提问以跑它的那台电脑为准。在这台电脑上的会话看本机（会话还活着才算：停了、退了还挂着的批准是失效的，对话里收成「已失效」）；
 *   别的电脑上的照云端（那台电脑报上来的）。
 * - 受阻、等你补只有云端知道（连续两次验收没过；验收员判了有几条要本人补）；这台电脑上的会话又在跑了（补了一句、按改法在改）时不算在等本人。
 * - 合回看本机的工作树（没合、本机报 needsMerge），本机没有这个会话时照云端；本人点了「先不合」的记在这台浏览器上，不再算等你。
 */
import type { TLocalSessionStatus } from "@warmap/contracts";
import type { TLocalSessionSummary } from "@/lib/local/runner";
import type { SessionView } from "@/lib/local/sessionView";
import { sortWaiting } from "./derive";
import type { SubSession, WaitingItem, WorkHomeData } from "./types";

export type Attention = NonNullable<SubSession["waiting"]>;
export const ATTENTION_LABEL: Record<Attention, string> = { approval: "等你批准", question: "在问你", verdict: "等你拿主意", needs_person: "等你补", merge: "等你合回" };

/** 本机这一个会话现在的样子：状态、挂着几个批准、有没有在问、工作树合没合回（later：本人点了先不合；不在工作树里做为 null）。 */
export type LocalAsk = { status: TLocalSessionStatus | null; pending: number; question: boolean; merge: "needs" | "merged" | "later" | null };

/** 批准只在会话还在跑时算数：本机重启、会话停了，挂着的批准已经没人等了。 */
const ALIVE = new Set<TLocalSessionStatus>(["starting", "running", "waiting_permission"]);
/** 提问在会话结束（退出、失败、交完收工）后作废。 */
const ENDED = new Set<TLocalSessionStatus>(["exited", "failed", "done"]);

/** 本机这个会话自己在等本人的框（批准、提问），没有为 null。 */
export function localAsk(local: LocalAsk): "approval" | "question" | null {
  if (local.status === "waiting_permission" || (local.pending > 0 && local.status !== null && ALIVE.has(local.status))) return "approval";
  if (local.question && !(local.status && ENDED.has(local.status))) return "question";
  return null;
}

/** 这个会话现在等本人处理的框。cloud：云端说的（SubSession.waiting）；local：这台电脑上有这个会话时它的样子，没有为 null。先批准、提问，再受阻，再合回。 */
export function attentionOf(cloud: Attention | null, local: LocalAsk | null): Attention | null {
  if (!local) return cloud;
  const here = localAsk(local);
  if (here) return here;
  // 受阻、等你补（主循环第 61 条）都只有云端知道，执行方又在跑了（补了一句、按改法在改）时不算在等本人。
  if ((cloud === "verdict" || cloud === "needs_person") && !(local.status && ALIVE.has(local.status))) return cloud;
  if (local.merge === "needs" || (cloud === "merge" && local.merge === null)) return "merge";
  return null;
}

/** 「先不合」（这台浏览器记着，按会话）：合回的框收起，不再算等你；合成了、换了会话自然不再相关。 */
const LATER_KEY = "tianshu-merge-later-v1";
const readLater = (): string[] => { try { return JSON.parse(localStorage.getItem(LATER_KEY) ?? "[]") as string[]; } catch { return []; } };
export const isMergeLater = (sessionId: string) => readLater().includes(sessionId);
export const markMergeLater = (sessionId: string) => {
  try { localStorage.setItem(LATER_KEY, JSON.stringify([...readLater().filter((id) => id !== sessionId), sessionId].slice(-50))); } catch { /* 下次再问 */ }
};

const mergeOf = (session: Pick<TLocalSessionSummary, "id" | "workspace">): LocalAsk["merge"] => {
  const ws = session.workspace;
  if (ws?.kind !== "worktree") return null;
  if (ws.mergedCommit) return "merged";
  if (!ws.needsMerge) return null;
  return isMergeLater(session.id) ? "later" : "needs";
};

/** 本机会话的摘要（左栏、等你用，不连事件流）。 */
export const summaryAsk = (session: TLocalSessionSummary): LocalAsk => ({
  status: session.status, pending: session.pendingPermissions, question: !!session.pendingQuestion, merge: mergeOf(session),
});

/** 打开着的子会话：连上事件流以后以事件流为准（答过、作废了就是没有），还没连上照摘要。 */
export const viewAsk = (view: SessionView, session: TLocalSessionSummary): LocalAsk => (view.lastSeq
  ? { status: view.status ?? session.status, pending: view.pending.length, question: !!view.question, merge: mergeOf(session) }
  : summaryAsk(session));

/** 子会话在这台电脑上的那个会话：先按 sessionId，再按卡、专题找最近的。 */
export function localSessionOf(sub: Pick<SubSession, "id" | "kind" | "sessionId">, sessions: readonly TLocalSessionSummary[]): TLocalSessionSummary | null {
  const byId = sub.sessionId ? sessions.find((session) => session.id === sub.sessionId) : undefined;
  if (byId) return byId;
  return sessions.filter((session) => (sub.kind === "card" ? session.subject.cardId === sub.id : session.subject.topicId === sub.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

/** 一个子会话照上面的规矩改过：等什么、在哪一格（批准、提问作废了：还在跑的是进行中，停了的是已停下）。 */
export function withAttention(sub: SubSession, sessions: readonly TLocalSessionSummary[]): SubSession {
  const session = localSessionOf(sub, sessions);
  if (!session) return sub;
  const waiting = attentionOf(sub.waiting, summaryAsk(session));
  if (waiting === sub.waiting) return sub;
  if (waiting) return { ...sub, state: "waiting", waiting };
  return { ...sub, waiting: null, state: sub.state === "waiting" && ALIVE.has(session.status) ? "running" : sub.state };
}

/**
 * 自由子会话（本人 11/19）做完一轮没能合回：只有本机知道（云端的合回结果只收卡的），照卡的样子在「等你」里加一条；没在等合回的为 null。
 */
function topicMerge(sub: SubSession, sessions: readonly TLocalSessionSummary[], projectId: string | null): WaitingItem | null {
  if (sub.kind !== "topic" || sub.waiting !== "merge") return null;
  const session = localSessionOf(sub, sessions);
  const ws = session?.workspace;
  if (!session || ws?.kind !== "worktree" || !ws.needsMerge) return null;
  return {
    id: `merge:topic:${sub.id}`, kind: "merge", title: "没能自动合回", source: `${sub.title} · ${ws.needsMerge.message}`, at: session.updatedAt,
    open: { kind: "topic", id: sub.id }, taskId: null, projectId, sessionId: session.id, deviceId: sub.deviceId, deviceName: null, letter: sub.letter,
    dueAt: null, answer: "inline_local", person: null, month: null, question: null, permission: null,
  };
}

/**
 * 首页数据整份照这台电脑上的会话改一遍：左栏的子会话点、项目的「等你」、首页「等你」里的批准、提问和自由子会话的合回。
 * 「等你」里这台电脑上的会话已经没在等的批准、提问拿掉（项目上的 needsYou 跟着减），没能合回的自由子会话加一条（跟着加）。
 */
export function withLocalAttention(data: WorkHomeData, sessions: readonly TLocalSessionSummary[]): WorkHomeData {
  if (!sessions.length) return data;
  const here = new Map(sessions.map((session) => [session.id, session]));
  const stale = (item: WorkHomeData["waiting"][number]) => {
    if ((item.kind !== "approval" && item.kind !== "question") || !item.sessionId) return false;
    const session = here.get(item.sessionId);
    return !!session && localAsk(summaryAsk(session)) !== item.kind;
  };
  const dropped = data.waiting.filter(stale);
  const added: WaitingItem[] = [];
  const fix = (subs: SubSession[], projectId: string | null) => {
    const next = subs.map((sub) => withAttention(sub, sessions));
    for (const sub of next) { const item = topicMerge(sub, sessions, projectId); if (item) added.push(item); }
    return next.every((sub, index) => sub === subs[index]) ? subs : next;
  };
  const projects = data.projects.map((project) => {
    const subSessions = fix(project.subSessions, project.projectId);
    const more = added.filter((item) => item.projectId === project.projectId).length - dropped.filter((item) => item.projectId === project.projectId).length;
    if (subSessions === project.subSessions && !more) return project;
    return { ...project, subSessions, summary: { ...project.summary, needsYou: Math.max(0, project.summary.needsYou + more) } };
  });
  const otherSubs = fix(data.other.subSessions, null);
  if (!dropped.length && !added.length && projects.every((project, index) => project === data.projects[index]) && otherSubs === data.other.subSessions) return data;
  const kept = dropped.length ? data.waiting.filter((item) => !stale(item)) : data.waiting;
  return { ...data, projects, other: { ...data.other, subSessions: otherSubs }, waiting: added.length ? sortWaiting([...kept, ...added]) : kept };
}
