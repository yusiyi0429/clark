/**
 * 把本机会话的事件流折成页面要画的样子：对话记录、计划条目、挂着的权限请求、花费、在等什么。
 * 纯函数，事件按 seq 只增；同一个 seq 来两次（重连补发）只算一次。
 */
import type { TLocalPermissionMode, TLocalPermissionRequestView, TLocalPlanEntry, TLocalQuestionRequestView, TLocalSessionEvent, TLocalSessionStatus, TLocalUsage } from "./runner";
import type { TurnFile } from "./fileChanges";

export type SessionEntry =
  /**
   * messageId、receipt：本人这句话的编号和回执（17.4，本机补发的话没有编号也没有回执）。
   * local：网页先画的、事件流里还没来的那句（useSessionSend）：sending 发送中，unsent 没发出去（给「重发」，同一个编号）。
   */
  | { kind: "user"; seq: number; at: string; text: string; attachments?: { name: string; size: number }[]; messageId?: string; receipt?: "delivered" | "read" | "failed"; local?: "sending" | "unsent";
      /** 开工那句（派活时交给会话的交代，user_message 的 source = initial）：按 Markdown 画。 */
      initial?: true }
  | { kind: "assistant"; seq: number; at: string; text: string }
  | { kind: "step"; seq: number; at: string; toolUseId: string; title: string; done: boolean; isError: boolean }
  /** voided：本机程序重启时作废的（不是本人拒的），那一步行尾写「已作废」。 */
  | { kind: "permission"; seq: number; at: string; request: TLocalPermissionRequestView; decision: "allow" | "deny" | null; voided?: true }
  | { kind: "artifact"; seq: number; at: string; title: string; fileName: string }
  | { kind: "handback"; seq: number; at: string; summary: string; met: number; total: number }
  | { kind: "notice"; seq: number; at: string; level: "info" | "warn" | "error"; text: string; code?: string }
  /** 这一轮改了哪些文件（第 72 条，一轮结束的事件；临时）：对话里这一轮末尾那一行。 */
  | { kind: "files"; seq: number; at: string; files: TurnFile[] };

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
  /** 换过的权限模式（事件 permission_mode：本人在网页上换的、计划批了转成自动、换了执行方）；没换过为 null，看会话摘要里的。 */
  permissionMode: TLocalPermissionMode | null;
  /** 上下文用了多少（事件 context_usage，17.2 第 42 条）；还没报过为 null，看会话摘要里的 context。maxTokens 读不到为 null。 */
  context: { usedTokens: number; maxTokens: number | null; at: string } | null;
};

/** 「16.6 万」：token 数按万写，留一位小数。 */
const wan = (tokens: number) => `${Number((tokens / 10_000).toFixed(1))} 万`;
/**
 * 上下文用了多少（17.2 第 42 条，输入框下面的小圆环）：百分比取整，到 80% 是警告色，悬停写「16.6 万 / 20 万」。
 * 还没报过、读不到这个模型的上限（maxTokens 为 null）时为 null，不画。
 */
export function contextUsage(context: { usedTokens: number; maxTokens: number | null } | null | undefined): { percent: number; warn: boolean; tip: string } | null {
  if (!context?.maxTokens) return null;
  const percent = Math.min(100, Math.round((context.usedTokens / context.maxTokens) * 100));
  return { percent, warn: percent >= 80, tip: `${wan(context.usedTokens)} / ${wan(context.maxTokens)}` };
}

/** 对话里记下的那一行「问：…」；还没答时对话最后是选项框，这一行不重复画（SessionTranscript）。 */
export const questionNotice = (request: TLocalQuestionRequestView) => `问：${request.questions.map((entry) => entry.question).join(" ")}`;

export const EMPTY_VIEW: SessionView = {
  lastSeq: 0, status: null, startedAt: null, agentVersion: null, plan: [], entries: [], pending: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null },
  lastActivity: null, interrupted: false, handedBack: false, place: null, queuedBecause: null, question: null, permissionMode: null, context: null,
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
  // 一轮结束的事件还没进契约（第 72 条）：先认临时的名字，契约到了挪进下面的 switch。
  if ((event.type as string) === "turn_files") {
    const files = (event as unknown as { files: TurnFile[] }).files;
    if (files.length) next.entries = [...view.entries, { kind: "files", ...base, files }];
    return next;
  }
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
    // 本人恢复了文件（11/11）：怎么在对话里显示由网页的「恢复」那一笔定，先不进对话记录
    case "files_restored":
      return next;
    case "agent_info":
      next.agentVersion = event.version;
      return next;
    case "permission_mode":
      next.permissionMode = event.mode;
      return next;
    case "context_usage":
      next.context = { usedTokens: event.usedTokens, maxTokens: event.maxTokens, at: event.at };
      return next;
    case "user_message":
      next.entries = [...view.entries, { kind: "user", ...base, text: event.text, ...(event.attachments?.length ? { attachments: event.attachments.map(({ name, size }) => ({ name, size })) } : {}),
        ...(event.messageId ? { messageId: event.messageId } : {}), ...(event.source === "initial" ? { initial: true as const } : {}) }];
      next.handedBack = false;
      return next;
    // 回执挂到同编号的那句话上：delivered → read，或 delivered → failed。
    case "receipt":
      next.entries = view.entries.map((entry) => entry.kind === "user" && entry.messageId === event.messageId ? { ...entry, receipt: event.state } : entry);
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
      next.entries = view.entries.map((entry) => entry.kind === "permission" && entry.request.requestId === event.requestId ? { ...entry, decision: event.decision, ...(event.voided ? { voided: true as const } : {}) } : entry);
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
      next.entries = [...view.entries, { kind: "notice", ...base, level: event.level, text: event.text, ...(event.code ? { code: event.code } : {}) }];
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
      const text = `验收${event.passed ? "过了" : event.blocked ? "未通过，受阻" : "未通过"}：${event.summary}`;
      next.entries = [...view.entries, { kind: "notice", ...base, level: event.passed ? "info" : "warn", text }];
      next.lastActivity = { at: event.at, text };
      return next;
    }
  }
}

export const foldEvents = (events: TLocalSessionEvent[], view: SessionView = EMPTY_VIEW) => events.reduce(foldEvent, view);

/** 本机报的标记：有权限请求没答 → 等你批准；本人点了停下（或强停、异常退出）→ 已暂停；一轮停下等人说话 → 等你回复。交回了就不算等；交完收工（done）不等。 */
export function localWait(view: SessionView): LocalWait | null {
  // 会话停了、退了还挂着的批准是失效的（第 54 条）。
  if (view.status === "waiting_permission" || (view.pending.length && running(view.status))) return "approval";
  if (view.status === "done") return null;
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
