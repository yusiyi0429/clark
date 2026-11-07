/**
 * 假本机程序：和真程序同一个接口（LocalRunner），按脚本吐事件——开工、三步计划、一次权限请求、一次提问、交回。
 * 同时跑的上限默认 3：满了的会话是 queued（排第几），有会话停下、做完一轮或退出就接上：验收员先、规划员次、执行的最后，同一种先来先跑（V2 设计 20.6、21.1）。
 * 规划员（plan）按三步拆完就退出；执行的交回以后本机自己接一个验收员（verify，只读）。
 * 卡的会话在哪做（ADR 0038）：第一个文件夹（C:\work\tianshu）当 git 仓库，每张卡一个工作树和分支，开工时说一句主文件夹没提交的改动没带进来；
 * 别的文件夹当不是 git 仓库，同一个文件夹同时只做一张卡，别的排队（status 带原因）。合回：第一次回「主文件夹有没提交的改动」，再点就合上。
 * 卡在批准之后问本人一个单选问题（pendingQuestion，状态 idle）；开工带 after 的卡等前面的卡在本机合回（waitingFor，没有工作树），合回了才开始。
 * 开发时设 NEXT_PUBLIC_LOCAL_RUNNER=mock 切到它；测试里直接 createMockRunner()。
 * 状态只在内存里：同一个页面会话内跨页面保留，刷新就没了。
 */
import type {
  TLocalBackgroundItem, TLocalCreateSessionRequest, TLocalFolder, TLocalMergeResponse, TLocalModelProfile, TLocalPermissionRequestView, TLocalPlanEntry, TLocalQuestionRequestView,
  TLocalProjectFolder, TLocalSessionEvent, TLocalSessionStatus, TLocalSessionSummary, TLocalUsage, TLocalWorkspace,
} from "@warmap/contracts";
import { LocalRunnerError, type EventWatch, type LocalRunner } from "./runner";

type Step = (s: MockSession) => void | "wait";
type MockSession = {
  summary: TLocalSessionSummary;
  log: TLocalSessionEvent[];
  listeners: Set<(event: TLocalSessionEvent) => void>;
  script: Step[];
  cursor: number;
  timer: ReturnType<typeof setTimeout> | null;
  pending: TLocalPermissionRequestView | null;
  /** 停下以后要等人说一句才接着走。 */
  paused: boolean;
  /** 上一个权限请求被拒了：那一步不执行。 */
  denied: boolean;
  /** 合回点了几次（假程序第一次回主文件夹不干净）。 */
  mergeTries: number;
  /** 等前面的卡时：都合回以后要开的工作树。 */
  waits?: { workspace: TLocalWorkspace | undefined };
};

const ZERO: TLocalUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
const PLAN = ["读交代和现有代码", "改代码并补测试", "跑测试、整理交回"];
const PLANNER = ["读 Task 和约定", "读本体里的上下文", "列计划和派活单"];
const VERIFIER = ["对照约定逐条看", "交验收结果"];
/** 排队先后：验收员 → 规划员 → 执行。 */
const RANK: Record<string, number> = { verify: 0, plan: 1 };
const FOLDER_BUSY = "这个文件夹不是 git 仓库，同时只做一张卡，等另一张这一轮做完";
const REPO = "C:\\work\\tianshu";
const sha = (seed: string) => Array.from({ length: 40 }, (_, i) => "0123456789abcdef"[(seed.charCodeAt(i % seed.length) + i * 7) % 16]).join("");

const MODELS: TLocalModelProfile[] = [
  { id: "subscription", label: "订阅 · 默认", source: "subscription", agent: "claude-code", baseUrl: null, model: null, smallModel: null, webSearch: true, hasKey: false, isDefault: true },
  { id: "sub-haiku", label: "订阅 · Haiku", source: "subscription", agent: "claude-code", baseUrl: null, model: "haiku", smallModel: null, webSearch: true, hasKey: false, isDefault: false },
  { id: "tokenhub-deepseek", label: "TokenHub · DeepSeek", source: "gateway", agent: "claude-code", baseUrl: "https://tokenhub.example/anthropic", model: "deepseek-v4.1-flash", smallModel: null, webSearch: true, hasKey: true, isDefault: false },
];

/** onPlanned：规划员拆完时调（假装本机把 card_plan 同步上去了）。 */
export type MockOptions = { stepMs?: number; paired?: boolean; onPlanned?: (taskId: string) => void };

export function createMockRunner({ stepMs = 900, paired = true, onPlanned }: MockOptions = {}): LocalRunner {
  let token = paired ? "mock-token-0000000000000000000000" : "";
  const sessions = new Map<string, MockSession>();
  const projects = new Map<string, TLocalProjectFolder>();
  const folders: TLocalFolder[] = [{ id: "f1", path: "C:\\work\\tianshu", label: "tianshu", addedAt: new Date().toISOString() }];
  let linked = false;
  let includePersonal = false;
  let maxConcurrent = 3;
  let autoMerge = true;
  let seqId = 0;
  /** 占着位置的：开工中、进行中、等你批准（一轮做完在等你回复的不占）。 */
  const OCCUPYING = new Set<TLocalSessionStatus>(["starting", "running", "waiting_permission"]);
  const slots = () => {
    const all = [...sessions.values()].map((s) => s.summary.status);
    return { max: maxConcurrent, running: all.filter((status) => OCCUPYING.has(status)).length, queued: all.filter((status) => status === "queued").length };
  };

  const now = () => new Date().toISOString();
  const must = (id: string) => {
    const s = sessions.get(id);
    if (!s) throw new LocalRunnerError("not_found", "没有这个会话", 404);
    return s;
  };
  const emit = (s: MockSession, event: Record<string, unknown> & { type: TLocalSessionEvent["type"] }) => {
    const full = { seq: s.log.length + 1, at: now(), sessionId: s.summary.id, ...event } as TLocalSessionEvent;
    s.log.push(full);
    s.summary = { ...s.summary, lastSeq: full.seq, updatedAt: full.at };
    for (const listener of s.listeners) listener(full);
  };
  const setStatus = (s: MockSession, status: TLocalSessionStatus, reason?: string) => {
    s.summary = { ...s.summary, status };
    emit(s, { type: "status", status, ...(reason ? { reason } : {}) });
    if (!OCCUPYING.has(status)) promote();
  };
  const rank = (s: MockSession) => RANK[s.summary.subject.kind] ?? 2;
  const queue = () => [...sessions.values()].filter((s) => s.summary.status === "queued")
    .sort((a, b) => rank(a) - rank(b) || a.summary.createdAt.localeCompare(b.summary.createdAt));
  const renumber = () => queue().forEach((s, i) => { s.summary = { ...s.summary, queuePosition: i + 1 }; });
  /** 不是 git 仓库的文件夹里已经有一张卡在做（同一个文件夹同时只做一张）。 */
  const folderBusy = (s: MockSession) => {
    const ws = s.summary.workspace;
    return ws?.kind === "folder" && [...sessions.values()].some((other) => other !== s && other.summary.workspace?.kind === "folder"
      && other.summary.workspace.folder === ws.folder && OCCUPYING.has(other.summary.status));
  };
  /** 有空位就按先后接上（文件夹被占着的、等前面的卡的跳过），其余的重新编号。 */
  const promote = () => {
    let free = maxConcurrent - slots().running;
    for (const s of queue()) {
      if (free > 0 && !folderBusy(s) && !s.summary.waitingFor) {
        free--;
        s.summary = { ...s.summary, queuePosition: null };
        setStatus(s, "starting");
        advance(s);
      }
    }
    renumber();
  };
  const plan = (s: MockSession, done: number, steps = PLAN) => emit(s, {
    type: "plan", entries: steps.map((content, i): TLocalPlanEntry => ({ content, status: i < done ? "completed" : i === done ? "in_progress" : "pending" })),
    progress: { done: Math.min(done, steps.length), total: steps.length, step: Math.min(done + 1, steps.length), current: steps[done] ?? null },
  });
  const tool = (s: MockSession, name: string, title: string) => {
    const toolUseId = `tu${++seqId}`;
    emit(s, { type: "tool_call", toolUseId, name, title, input: {} });
    emit(s, { type: "tool_result", toolUseId, isError: false, preview: "完成" });
  };
  /** 会话里的后台任务（子 agent、后台命令）：摘要里留一份，再报一条 background 事件（同本机程序，按 id 覆盖）。 */
  const background = (s: MockSession, item: TLocalBackgroundItem) => {
    s.summary = { ...s.summary, background: [...(s.summary.background ?? []).filter((entry) => entry.id !== item.id), item] };
    emit(s, { type: "background", item });
  };
  const finishBackground = (s: MockSession, state: "done" | "stopped") => {
    for (const item of s.summary.background ?? []) if (item.state === "running") background(s, { ...item, state, finishedAt: now(), stoppable: false });
  };
  const turnEnd = (s: MockSession, text: string | null, errorKind?: "interrupted") => {
    const usage = { ...ZERO, inputTokens: 1200, outputTokens: 320, costUsd: 0.004 };
    s.summary = { ...s.summary, usage: { ...s.summary.usage, inputTokens: s.summary.usage.inputTokens + 1200, outputTokens: s.summary.usage.outputTokens + 320, costUsd: (s.summary.usage.costUsd ?? 0) + 0.004 } };
    emit(s, { type: "turn_end", isError: false, text, durationMs: stepMs * 4, usage, ...(errorKind ? { errorKind } : {}) });
  };

  const script: Step[] = [
    (s) => { setStatus(s, "running"); noteWorkspace(s); emit(s, { type: "agent_info", agent: "claude-code", version: "2.1.318", model: s.summary.modelLabel, permissionMode: "manual" }); },
    (s) => { emit(s, { type: "assistant_text", text: "先读一下交代和相关代码，列个计划。" }); plan(s, 0); },
    (s) => { tool(s, "Read", "读 apps/web/src/app/manifest.ts"); plan(s, 1); background(s, { id: `agent-${++seqId}`, title: "读相关代码", kind: "subagent", state: "running", startedAt: now(), finishedAt: null, stoppable: true }); },
    (s) => {
      const request: TLocalPermissionRequestView = { requestId: `perm-${++seqId}`, toolName: "Bash", title: "运行 pnpm --filter @warmap/web test", input: { command: "pnpm --filter @warmap/web test" }, outsidePaths: [], canAllowForSession: true, requestedAt: now() };
      s.pending = request;
      s.summary = { ...s.summary, pendingPermissions: 1 };
      emit(s, { type: "permission_request", request });
      setStatus(s, "waiting_permission");
      return "wait";
    },
    (s) => {
      if (!s.denied) {
        tool(s, "Bash", "运行 pnpm --filter @warmap/web test");
        for (const item of s.summary.background ?? []) if (item.kind === "subagent" && item.state === "running") background(s, { ...item, state: "done", finishedAt: now(), stoppable: false });
        background(s, { id: `cmd-${++seqId}`, title: "pnpm --filter @warmap/web test --watch", kind: "command", state: "running", startedAt: now(), finishedAt: null, stoppable: true });
      }
      // 执行方问本人（AskUserQuestion）：会话转成 idle（等你回复），摘要带 pendingQuestion。
      const request: TLocalQuestionRequestView = { requestId: `q-${++seqId}`, askedAt: now(), questions: [{
        header: "安装说明", question: "旧的安装说明要不要一起删掉？", multiSelect: false,
        options: [{ label: "删掉", description: "只留新的安装说明" }, { label: "留着", description: "旧的放进附录" }],
      }] };
      s.summary = { ...s.summary, pendingQuestion: request };
      emit(s, { type: "question", request });
      setStatus(s, "idle");
      return "wait";
    },
    (s) => { setStatus(s, "running"); emit(s, { type: "assistant_text", text: "好，按你说的改。" }); plan(s, 2); },
    (s) => { tool(s, "Write", "写 交回说明.md"); emit(s, { type: "artifact", artifactId: `a${++seqId}`, title: "交回说明", fileName: "交回说明.md", size: 2048, sha256: "0".repeat(64) }); },
    (s) => {
      plan(s, 3);
      const ws = s.summary.workspace;
      finishBackground(s, "done");
      emit(s, { type: "handback", summary: "改完了，测试都过。", criteria: [{ index: 1, result: "met", evidence: "测试 12/12 通过" }, { index: 2, result: "met", evidence: "交回说明.md" }], outputKeys: [],
        ...(ws?.kind === "worktree" ? { commit: sha(`${s.summary.id}:handback`) } : {}) });
      turnEnd(s, "改完了，已交回。");
      const subject = s.summary.subject;
      if (subject.kind === "card" && subject.cardId)
        void create({ subject: { kind: "verify", cardId: subject.cardId }, title: `验收：${s.summary.title}`.slice(0, 120), modelProfileId: s.summary.modelProfileId, firstMessage: "逐条对照约定验收这次交回。" });
      setStatus(s, "idle");
      return "wait";
    },
  ];
  /** 开工时告诉网页卡在哪做（同本机程序）。 */
  const noteWorkspace = (s: MockSession) => {
    const ws = s.summary.workspace;
    if (ws?.kind === "worktree") emit(s, { type: "notice", level: "info", code: "workspace", text: `在工作树里做：分支 ${ws.branch}，从 ${ws.baseBranch} 的最新提交 ${ws.baseCommit.slice(0, 7)} 开始；主文件夹里没提交的改动没带进来` });
  };
  const started = (s: MockSession, mode: string) => { setStatus(s, "running"); emit(s, { type: "agent_info", agent: "claude-code", version: "2.1.318", model: s.summary.modelLabel, permissionMode: mode }); };
  const planner: Step[] = [
    (s) => started(s, "manual"),
    (s) => { emit(s, { type: "assistant_text", text: "先读 Task、约定和相关的近期事件。" }); plan(s, 0, PLANNER); },
    (s) => { tool(s, "mcp__tianshu__get_task_context", "读 Task 的上下文"); plan(s, 1, PLANNER); },
    (s) => { plan(s, 2, PLANNER); tool(s, "propose_plan", "交计划和派活单"); },
    (s) => {
      plan(s, 3, PLANNER);
      turnEnd(s, "拆好了，派活单交上去了。");
      const subject = s.summary.subject;
      if (subject.kind === "plan" && subject.taskId) onPlanned?.(subject.taskId);
      setStatus(s, "done");
      return "wait";
    },
  ];
  const verifier: Step[] = [
    (s) => started(s, "plan"),
    (s) => { emit(s, { type: "assistant_text", text: "逐条对照约定看交回的证据。" }); plan(s, 0, VERIFIER); },
    (s) => { plan(s, 1, VERIFIER); tool(s, "submit_verdict", "交验收结果"); },
    (s) => { plan(s, 2, VERIFIER); turnEnd(s, "2/2 达到。"); setStatus(s, "done"); afterVerdict(s); return "wait"; },
  ];

  /** 合回：主文件夹记上提交，工作树清掉；等这张卡的卡少等一张，都合回了就开工作树、排进队里。 */
  const mergeInto = (s: MockSession) => {
    const ws = s.summary.workspace;
    if (ws?.kind !== "worktree") return null;
    const commit = sha(`${s.summary.id}:merge`);
    s.summary = { ...s.summary, workspace: { kind: "worktree", folder: ws.folder, path: ws.path, branch: ws.branch, baseBranch: ws.baseBranch, baseCommit: ws.baseCommit, mergedCommit: commit } };
    emit(s, { type: "notice", level: "info", code: "merged", text: `已合回 ${ws.baseBranch}（${commit.slice(0, 7)}），工作树已清理，分支 ${ws.branch} 保留` });
    const cardId = s.summary.subject.cardId;
    for (const other of sessions.values()) {
      if (!cardId || !other.summary.waitingFor?.includes(cardId)) continue;
      const rest = other.summary.waitingFor.filter((entry) => entry !== cardId);
      other.summary = rest.length ? { ...other.summary, waitingFor: rest } : { ...other.summary, waitingFor: undefined, workspace: other.waits?.workspace };
    }
    promote();
    return commit;
  };
  /** 验收员交完（假的一律算过）：「验收过就合回」开着就合回那张卡，关着就记下要本人合。 */
  const afterVerdict = (verify: MockSession) => {
    const card = [...sessions.values()].find((other) => other.summary.subject.kind === "card" && other.summary.subject.cardId === verify.summary.subject.cardId);
    const ws = card?.summary.workspace;
    if (!card || ws?.kind !== "worktree" || ws.mergedCommit) return;
    if (autoMerge) { mergeInto(card); return; }
    card.summary = { ...card.summary, workspace: { ...ws, needsMerge: { reason: "auto_merge_off", message: "「验收过就合回」关着，等你合" } } };
  };

  const advance = (s: MockSession) => {
    if (s.timer || s.paused) return;
    s.timer = setTimeout(() => {
      s.timer = null;
      const step = s.script[s.cursor];
      if (!step) return;
      s.cursor++;
      if (step(s) !== "wait") advance(s);
    }, stepMs);
  };

  const summaryOf = (s: MockSession) => ({ ...s.summary });
  const listen = (s: MockSession, fn: (event: TLocalSessionEvent) => void) => { s.listeners.add(fn); return () => s.listeners.delete(fn); };

  return {
    kind: "mock",
    health: async () => ({ app: "tianshu-local", version: "0.1.0-mock", protocol: 1, platform: "win32", tokenValid: Boolean(token), slots: slots() }),
    startPairing: async () => ({ pairingId: "mock-pairing", code: "4821", expiresAt: new Date(Date.now() + 120_000).toISOString() }),
    pairingStatus: async () => { token = "mock-token-0000000000000000000000"; return { status: "approved", token }; },
    unpair: async () => { token = ""; },
    status: async () => ({
      deviceId: "00000000-0000-4000-8000-000000000001", version: "0.1.0-mock",
      agents: [{ kind: "claude-code", installed: true, version: "2.1.318", path: null, loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", loginExpiresAt: null, minimumVersion: "2.1.300", compatible: true, setup: { phase: "idle", startedAt: null, loginUrl: null, error: null } }],
      activeSessions: slots().running,
      slots: slots(),
      cloud: { linked, apiBaseUrl: linked ? location.origin : null, personName: null, personId: null, outbox: { pending: 0, lastSyncedAt: linked ? now() : null, lastError: null } },
      settings: { includePersonalConfigByDefault: includePersonal, allowedOrigins: [typeof location === "undefined" ? "" : location.origin], paused: false, maxConcurrent, autoMerge },
      // 用量：Claude 订阅 5 小时窗口用了八成多（右栏那一格出琥珀），本周四成；TokenHub 今天花了一点。
      quota: [
        { id: "claude", name: "Claude", kind: "subscription", remainingPercent: 17, amounts: [], resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
          plan: "max", blockedUntil: null, extraUsage: false, updatedAt: now(), error: null, windows: [
            { kind: "session", model: null, usedPercent: 83, state: "warning", resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
            { kind: "weekly_all", model: null, usedPercent: 40, state: "ok", resetsAt: new Date(Date.now() + 72 * 3_600_000).toISOString() },
          ] },
        { id: "tokenhub:mock", name: "TokenHub", kind: "daily_spend", remainingPercent: null, amounts: [{ amount: 12.4, currency: "CNY", estimated: false }],
          monthAmounts: [{ amount: 186, currency: "CNY", estimated: false }], windows: [], resetsAt: null, blockedUntil: null, plan: null, extraUsage: null, updatedAt: now(), error: null },
      ],
      tools: (["claude-code", "codex", "gh", "lark-cli"] as const).map((kind) => ({ kind, state: "ready" as const, version: null, account: null, checkedAt: now() })),
    }),
    login: async () => undefined,
    linkCloud: async (body) => { linked = true; return { linked, apiBaseUrl: body.apiBaseUrl, personName: body.personName ?? null, personId: body.personId ?? null, outbox: { pending: 0, lastSyncedAt: null, lastError: null } }; },
    patchSettings: async (patch) => {
      if (patch.includePersonalConfigByDefault !== undefined) includePersonal = patch.includePersonalConfigByDefault;
      if (patch.maxConcurrent !== undefined) { maxConcurrent = patch.maxConcurrent; promote(); }
      if (patch.autoMerge !== undefined) autoMerge = patch.autoMerge;
      return { includePersonalConfigByDefault: includePersonal, allowedOrigins: [], paused: Boolean(patch.paused), maxConcurrent, autoMerge };
    },
    listModels: async () => MODELS,
    putModel: async (id, body) => ({ id, label: body.label, source: body.source, agent: "claude-code", baseUrl: body.baseUrl ?? null, model: body.model, smallModel: body.smallModel ?? null, webSearch: body.webSearch ?? false, hasKey: Boolean(body.apiKey), isDefault: Boolean(body.isDefault) }),
    listFolders: async () => folders,
    pickFolder: async () => { const folder = { id: `f${folders.length + 1}`, path: `C:\\work\\project-${folders.length + 1}`, label: `project-${folders.length + 1}`, addedAt: now() }; folders.push(folder); return folder; },
    removeFolder: async (id) => { const i = folders.findIndex((f) => f.id === id); if (i >= 0) folders.splice(i, 1); },
    listProjects: async () => [...projects.values()],
    putProjectFolder: async (projectId, body) => {
      const folder = body.folderId ? folders.find((entry) => entry.id === body.folderId) : null;
      if (body.folderId && !folder) throw new LocalRunnerError("not_found", "没有这个文件夹，先选文件夹", 404);
      const bound = { projectId, name: body.name ?? projects.get(projectId)?.name ?? null, folder: folder ? { id: folder.id, path: folder.path, label: folder.label } : null, updatedAt: now() };
      projects.set(projectId, bound);
      return bound;
    },
    handoverCheck: async (projectId) => {
      const folder = projects.get(projectId)?.folder ?? null;
      return { projectId, checkedAt: now(), folder: folder ? { path: folder.path, label: folder.label } : null,
        git: folder ? { branch: "main", remotes: [{ name: "origin", url: "https://github.com/example/repo.git" }], uncommitted: [], uncommittedCount: 0, unpushed: [] } : null, recentFiles: null };
    },
    cloneProject: async (projectId, body) => {
      const label = body.name ?? body.repoUrl.replace(/.git$/, "").split(/[/:]/).pop() ?? "repo";
      const folder = { id: `f${folders.length + 1}`, path: `C:\work\${label}`, label, addedAt: now() };
      folders.push(folder);
      const bound = { projectId, name: null, folder: { id: folder.id, path: folder.path, label }, updatedAt: now() };
      projects.set(projectId, bound);
      return { project: bound, branch: body.branch ?? null, fellBack: false };
    },
    listSessions: async () => [...sessions.values()].map(summaryOf).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    createSession: async (body: TLocalCreateSessionRequest) => create(body),
    createSessionBatch: async (items) => Promise.all(items.map(async (body) => {
      try { return { ok: true as const, session: await create(body) }; }
      catch (error) { return { ok: false as const, error: { code: error instanceof LocalRunnerError && error.code !== "network" ? error.code : "internal", message: error instanceof Error ? error.message : "没开起来" } }; }
    })),
    getSession: async (id) => { const s = must(id); return { session: summaryOf(s), pendingPermissions: s.pending ? [s.pending] : [] }; },
    sendMessage: async (id, text, kind, attachments) => {
      const s = must(id);
      const was = s.summary.status;
      if (kind === "review") {
        // 评审会：并行挑刺、合成「分歧和建议」存成一版（假程序只吐事件）。
        emit(s, { type: "user_message", text: text || "开评审会", source: "web" });
        setTimeout(() => { emit(s, { type: "assistant_text", text: "几位挑刺的看完了，合成好了。" }); emit(s, { type: "version", number: 99, kind: "review", label: "评审", note: null }); }, stepMs * 3);
        return { delivery: was === "running" ? "next_step" : "new_turn" };
      }
      emit(s, { type: "user_message", text, source: "web" });
      s.paused = false;
      if (s.summary.pendingQuestion) {
        emit(s, { type: "question_resolved", requestId: s.summary.pendingQuestion.requestId, choices: null, text: null });
        s.summary = { ...s.summary, pendingQuestion: undefined };
      }
      if (was === "running") { emit(s, { type: "notice", level: "info", code: "interjection_next_step", text: "下一步生效" }); return { delivery: "next_step" }; }
      advance(s);
      return { delivery: was === "exited" || was === "done" ? "resumed" : "new_turn" };
    },
    interrupt: async (id) => {
      const s = must(id);
      if (s.timer) { clearTimeout(s.timer); s.timer = null; }
      s.paused = true;
      turnEnd(s, null, "interrupted");
      setStatus(s, "idle");
      return summaryOf(s);
    },
    kill: async (id) => {
      const s = must(id);
      if (s.timer) { clearTimeout(s.timer); s.timer = null; }
      s.paused = true;
      finishBackground(s, "stopped");
      setStatus(s, "exited", "强停");
      return summaryOf(s);
    },
    decidePermission: async (id, requestId, body) => {
      const s = must(id);
      if (!s.pending || s.pending.requestId !== requestId) throw new LocalRunnerError("not_found", "这个权限请求已经处理过了", 404);
      s.pending = null;
      s.summary = { ...s.summary, pendingPermissions: 0 };
      emit(s, { type: "permission_resolved", requestId, decision: body.decision, allowForSession: Boolean(body.allowForSession), ...(body.message ? { message: body.message } : {}) });
      setStatus(s, "running");
      s.denied = body.decision === "deny";
      advance(s);
      return summaryOf(s);
    },
    answerQuestion: async (id, requestId, body) => {
      const s = must(id);
      if (s.summary.pendingQuestion?.requestId !== requestId) throw new LocalRunnerError("conflict", "这个问题已经答过或作废了", 409);
      s.summary = { ...s.summary, pendingQuestion: undefined };
      emit(s, { type: "question_resolved", requestId, choices: body.choices, text: body.text ?? null });
      s.paused = false;
      advance(s);
      return summaryOf(s);
    },
    putBudget: async (body) => ({ taskId: body.taskId ?? null, sessionId: body.sessionId ?? null, budget: body.budget,
      spent: { hours: 0, weeklyPercent: null, money: null }, ratio: null, state: "ok", since: null, updatedAt: now() }),
    stopBackground: async (id, itemId) => {
      const s = must(id);
      const item = s.summary.background?.find((entry) => entry.id === itemId);
      if (!item || item.state !== "running") throw new LocalRunnerError("conflict", "这个后台任务已经不在跑了", 409);
      background(s, { ...item, state: "stopped", finishedAt: now(), stoppable: false });
      return summaryOf(s);
    },
    mergeSession: async (id): Promise<TLocalMergeResponse> => {
      const s = must(id);
      const ws = s.summary.workspace;
      if (ws?.kind !== "worktree") throw new LocalRunnerError("conflict", "这张卡不在工作树里做，没有分支可合", 409);
      if (ws.mergedCommit) throw new LocalRunnerError("conflict", "这张卡已经合回过了", 409);
      const busy = [...sessions.values()].some((other) => other.summary.subject.cardId === s.summary.subject.cardId && (other.summary.status === "queued" || OCCUPYING.has(other.summary.status)));
      if (busy) throw new LocalRunnerError("conflict", "卡或它的验收员还在跑，停下再合", 409);
      if (s.mergeTries++ === 0) return { merged: false, reason: "dirty", message: "主文件夹有没提交的改动", files: ["README.md", "apps/web/src/app/page.tsx"] };
      const commit = mergeInto(s)!;
      return { merged: true, commit, session: summaryOf(s) };
    },
    watch: async (id: string, { after, onEvent, onLink, signal }: EventWatch) => {
      const s = must(id);
      onLink?.(true);
      for (const event of s.log) if (event.seq > after) onEvent(event);
      const off = listen(s, onEvent);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => { off(); resolve(); }, { once: true }));
    },
  };

  async function create(body: TLocalCreateSessionRequest): Promise<TLocalSessionSummary> {
    if (!token) throw new LocalRunnerError("unauthorized", "没配对", 401);
    const model = MODELS.find((m) => m.id === body.modelProfileId) ?? MODELS[0]!;
    const id = crypto.randomUUID();
    const cardId = body.subject.kind === "card" ? body.subject.cardId : undefined;
    const slug = body.title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 30);
    const workspace: TLocalWorkspace | undefined = !cardId || !body.cwd ? undefined : body.cwd === REPO
      ? { kind: "worktree", folder: REPO, path: `C:\\Users\\me\\.tianshu-local\\worktrees\\${cardId}`, branch: `tianshu/${cardId.slice(0, 8)}${slug ? `-${slug}` : ""}`,
        baseBranch: "main", baseCommit: sha(`${cardId}:base`), mergedCommit: null }
      : { kind: "folder", folder: body.cwd };
    const busy = workspace?.kind === "folder" && [...sessions.values()].some((other) => other.summary.workspace?.kind === "folder" && other.summary.workspace.folder === workspace.folder && OCCUPYING.has(other.summary.status));
    // 前面的卡还没在本机合回的，先排着、不开工作树。
    const merged = new Set([...sessions.values()].flatMap((other) => (other.summary.workspace?.kind === "worktree" && other.summary.workspace.mergedCommit && other.summary.subject.cardId ? [other.summary.subject.cardId] : [])));
    const waitingFor = (body.after ?? []).filter((entry) => !merged.has(entry));
    const full = slots().running >= maxConcurrent || busy || waitingFor.length > 0;
    const s: MockSession = {
      summary: { id, subject: body.subject, title: body.title, agent: "claude-code", modelProfileId: model.id, modelLabel: model.label, cwd: body.cwd ?? "topics", status: full ? "queued" : "starting", includePersonalConfig: Boolean(body.includePersonalConfig), createdAt: now(), updatedAt: now(), lastSeq: 0, pendingPermissions: 0, queuePosition: full ? slots().queued + 1 : null, usage: { ...ZERO }, ...(workspace && !waitingFor.length ? { workspace } : {}), ...(waitingFor.length ? { waitingFor } : {}) },
      log: [], listeners: new Set(), script: body.subject.kind === "plan" ? planner : body.subject.kind === "verify" ? verifier : script, cursor: 0, timer: null, pending: null, paused: false, denied: false, mergeTries: 0,
      ...(waitingFor.length ? { waits: { workspace } } : {}),
    };
    sessions.set(id, s);
    if (full) renumber();
    emit(s, { type: "status", status: s.summary.status, ...(busy ? { reason: FOLDER_BUSY } : {}) });
    emit(s, { type: "user_message", text: body.firstMessage, source: "initial" });
    if (!full) advance(s);
    return summaryOf(s);
  }
}