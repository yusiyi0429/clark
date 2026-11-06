/**
 * 把本机会话的事件流折成页面要画的样子：对话记录、计划条目、挂着的权限请求、花费、在等什么。
 * 纯函数，事件按 seq 只增；同一个 seq 来两次（重连补发）只算一次。
 */
import type { TLocalPermissionRequestView, TLocalPlanEntry, TLocalQuestionRequestView, TLocalSessionEvent, TLocalSessionStatus, TLocalUsage } from "./runner";

export type SessionEntry =
  | { kind: "user"; seq: number; at: string; text: string }
  | { kind: "assistant"; seq: number; at: string; text: string }
  | { kind: "step"; seq: number; at: string; toolUseId: string; title: string; done: boolean; isError: boolean }
  | { kind: "permission"; seq: number; at: string; request: TLocalPermissionRequestView; decision: "allow" | "deny" | null }
  | { kind: "artifact"; seq: number; at: string; title: string; fileName: string }
  | { kind: "handback"; seq: number; at: string; summary: string; met: number; total: number }
  | { kind: "notice"; seq: number; at: string; level: "info" | "warn" | "error"; text: string };

/** 卡身上的标记里由本机报的三种（第 3 节）。 */
export type LocalWait = "approval" | "reply" | "paused";

export type SessionView = {
  lastSeq: number;
  status: TLocalSessionStatus | null;
  startedAt: string | null;
  agentVersion: string | null;
  plan: TLocalPlanEntry[];
  entries: SessionEntry[];
  pending: TLocalPermissionRequestView[];
  usage: TLocalUsage;
  lastActivity: { at: string; text: string } | null;
  /** 最近一轮是被停下的。 */
  interrupted: boolean;
  /** 最近一次交回之后没再说过话。 */
  handedBack: boolean;
  /** 卡在哪做（本机开工时的 workspace 提示：分支、从哪个提交开始、主文件夹没提交的改动没带进来）。 */
  place: string | null;
  /** 排队的原因（本机说的，例如不是 git 仓库的文件夹同时只做一张卡）；不排了为 null。 */
  queuedBecause: string | null;
  /** 执行方在问本人、还没答的那次提问。 */
  question: TLocalQuestionRequestView | null;
};

/** 对话里记下的那一行「问：…」；还没答时对话最后是选项框，这一行不重复画（SessionTranscript）。 */
export const questionNotice = (request: TLocalQuestionRequestView) => `问：${request.questions.map((entry) => entry.question).join(" ")}`;

export const EMPTY_VIEW: SessionView = {
  lastSeq: 0, status: null, startedAt: null, agentVersion: null, plan: [], entries: [], pending: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null },
  lastActivity: null, interrupted: false, handedBack: false, place: null, queuedBecause: null, question: null,
};

const addUsage = (a: TLocalUsage, b: TLocalUsage): TLocalUsage => ({
  inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
});

export function foldEvent(view: SessionView, event: TLocalSessionEvent): SessionView {
  if (event.seq <= view.lastSeq) return view;
  const next: SessionView = { ...view, lastSeq: event.seq, startedAt: view.startedAt ?? event.at };
  const base = { seq: event.seq, at: event.at };
  switch (event.type) {
    case "status":
      next.status = event.status;
      next.queuedBecause = event.status === "queued" ? event.reason ?? null : null;
      if (event.status === "running") next.interrupted = false;
      if (event.status === "failed") next.entries = [...view.entries, { kind: "notice", ...base, level: "error", text: event.reason ?? "执行方异常退出" }];
      return next;
    // 后台任务（子 agent、后台命令）不进对话记录：右栏读会话摘要里的 background。
    case "background":
      return next;
    case "agent_info":
      next.agentVersion = event.version;
      return next;
    case "user_message":
      next.entries = [...view.entries, { kind: "user", ...base, text: event.text }];
      next.handedBack = false;
      return next;
    case "assistant_text":
      next.entries = [...view.entries, { kind: "assistant", ...base, text: event.text }];
      next.lastActivity = { at: event.at, text: event.text };
      return next;
    case "tool_call":
      next.entries = [...view.entries, { kind: "step", ...base, toolUseId: event.toolUseId, title: event.title, done: false, isError: false }];
      next.lastActivity = { at: event.at, text: event.title };
      return next;
    case "tool_result":
      next.entries = view.entries.map((entry) => entry.kind === "step" && entry.toolUseId === event.toolUseId ? { ...entry, done: true, isError: event.isError } : entry);
      return next;
    case "plan":
      next.plan = event.entries;
      return next;
    case "permission_request":
      next.entries = [...view.entries, { kind: "permission", ...base, request: event.request, decision: null }];
      next.pending = [...view.pending.filter((item) => item.requestId !== event.request.requestId), event.request];
      next.lastActivity = { at: event.at, text: event.request.title };
      return next;
    case "permission_resolved":
      next.entries = view.entries.map((entry) => entry.kind === "permission" && entry.request.requestId === event.requestId ? { ...entry, decision: event.decision } : entry);
      next.pending = view.pending.filter((item) => item.requestId !== event.requestId);
      return next;
    case "turn_end":
      next.usage = addUsage(view.usage, event.usage);
      next.interrupted = event.errorKind === "interrupted";
      if (event.isError && event.errorKind !== "interrupted") next.entries = [...view.entries, { kind: "notice", ...base, level: "error", text: event.text ?? "这一轮出错了" }];
      return next;
    case "artifact":
      next.entries = [...view.entries, { kind: "artifact", ...base, title: event.title, fileName: event.fileName }];
      return next;
    case "handback":
      next.entries = [...view.entries, { kind: "handback", ...base, summary: event.summary, met: event.criteria.filter((c) => c.result === "met").length, total: event.criteria.length }];
      next.handedBack = true;
      next.lastActivity = { at: event.at, text: event.summary };
      return next;
    case "notice":
      if (event.code === "interjection_next_step") return next;
      if (event.code === "workspace") next.place = event.text;
      next.entries = [...view.entries, { kind: "notice", ...base, level: event.level, text: event.text }];
      return next;
    case "version":
      next.entries = [...view.entries, { kind: "notice", ...base, level: "info", text: `存了${event.label ?? `第 ${event.number} 版`}` }];
      next.lastActivity = { at: event.at, text: `存了${event.label ?? `第 ${event.number} 版`}` };
      return next;
    case "question":
      next.question = event.request;
      next.entries = [...view.entries, { kind: "notice", ...base, level: "info", text: questionNotice(event.request) }];
      next.lastActivity = { at: event.at, text: event.request.questions[0]!.question };
      return next;
    case "question_resolved":
      if (view.question?.requestId === event.requestId) next.question = null;
      if (event.choices || event.text) {
        const said = [...(event.choices ?? []).flat(), event.text].filter(Boolean).join("、");
        next.entries = [...view.entries, { kind: "notice", ...base, level: "info", text: `答：${said}` }];
      }
      return next;
    case "verdict": {
      // 本机验收员的结论（验收会话和被验的卡的会话各一条）。
      const text = `验收${event.passed ? "过了" : event.blocked ? "没过，受阻" : "没过"}：${event.summary}`;
      next.entries = [...view.entries, { kind: "notice", ...base, level: event.passed ? "info" : "warn", text }];
      next.lastActivity = { at: event.at, text };
      return next;
    }
  }
}

export const foldEvents = (events: TLocalSessionEvent[], view: SessionView = EMPTY_VIEW) => events.reduce(foldEvent, view);

/** 本机报的标记：有权限请求没答 → 等你批准；本人点了停下（或强停、异常退出）→ 已暂停；一轮停下等人说话 → 等你回复。交回了就不算等。 */
export function localWait(view: SessionView): LocalWait | null {
  if (view.pending.length || view.status === "waiting_permission") return "approval";
  if (view.status === "exited" || view.status === "failed") return view.handedBack ? null : "paused";
  if (view.status === "idle") return view.handedBack ? null : view.interrupted ? "paused" : "reply";
  return null;
}

/** 「第 3/6 步」：正在做的那条；都做完了算最后一步。 */
export function planStep(plan: TLocalPlanEntry[]): { step: number; total: number; text: string } | null {
  if (!plan.length) return null;
  const current = plan.findIndex((entry) => entry.status === "in_progress");
  const index = current >= 0 ? current : Math.max(0, plan.filter((entry) => entry.status === "completed").length - 1);
  return { step: index + 1, total: plan.length, text: plan[index]!.content };
}

export const running = (status: TLocalSessionStatus | null) => status === "starting" || status === "running" || status === "waiting_permission";
