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
  TLocalBackgroundItem, TLocalCreateSessionRequest, TLocalEffort, TLocalFolder, TLocalMergeResponse, TLocalModelProfile, TLocalPermissionRequestView, TLocalPlanEntry, TLocalQuestionRequestView,
  TLocalProjectFolder, TLocalSessionDraft, TLocalSessionEvent, TLocalSessionStatus, TLocalSessionSummary, TLocalTool, TLocalToolUpsert, TLocalUsage, TLocalWorkspace,
  TLocalSource, TLocalSourceModel, TLocalSourcePlan, TLocalSourcePreset, TLocalSourceRegion,
} from "@warmap/contracts";
import { LocalRunnerError, type EventWatch, type LocalRunner } from "./runner";
import { createMockEdits } from "./mockChanges";

type Step = (s: MockSession) => void | "wait";
type MockSession = {
  summary: TLocalSessionSummary;
  log: TLocalSessionEvent[];
  listeners: Set<(event: TLocalSessionEvent) => void>;
  /** 在看草稿的（watch 带了 onDraft）。 */
  drafters: Set<(draft: TLocalSessionDraft) => void>;
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
  /** 不在工作树里做的会话：执行方改了的文件（第 71、72 条，mockChanges）。 */
  edits?: ReturnType<typeof createMockEdits>;
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

/** 这次会怎么跑（同本机的 previewRun）：别名（opus、sonnet、haiku）写成「Opus 5.5」这种，网关模型去掉厂商前缀原样写，没定模型是订阅默认的 Opus。 */
const ALIAS: Record<string, string> = { opus: "Opus 5.5", sonnet: "Sonnet 5.5", haiku: "Haiku 5.5" };
/**
 * 给人看的模型名，照本机程序的 modelDisplayName（apps/local/src/models.ts，网页不能引本机的源码，这里照它的规则写）：
 * 去掉「厂商/」前缀和 [1m]，claude-opus-5-5 →「Opus 5.5」、claude-sonnet-4-20250514 →「Sonnet 4」；别名写这台电脑上跑出来的那一版（假的：ALIAS）；
 * 别的原样（去掉前缀），如 wangsu/deepseek-v4.1-flash → deepseek-v4.1-flash。
 */
export function mockDisplayName(model: string): string {
  const bare = model.slice(model.lastIndexOf("/") + 1).replace(/\[1m\]$/i, "").toLowerCase();
  const full = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(bare);
  if (full) return `${full[1]![0]!.toUpperCase()}${full[1]!.slice(1)} ${full[2]}${full[3] ? `.${full[3]}` : ""}`;
  if (ALIAS[bare]) return ALIAS[bare]!;
  return model.slice(model.lastIndexOf("/") + 1).slice(0, 60);
}
const runFor = (profile: TLocalModelProfile, mode: "auto" | "set" | "unlimited" = "auto", effort: TLocalEffort | null = null) => ({
  mode, model: profile.model, effort, multiAgent: false, source: profile.source, sourceLabel: profile.label,
  modelName: profile.catalog ? profile.label : profile.model ? mockDisplayName(profile.model) : "Opus 5.5", actual: null,
  harness: profile.agent, ...(profile.origin ? { origin: profile.origin } : {}),
});

/** Claude Code 握手报的五档（D 契约 c97b38c5）。 */
const CLAUDE_EFFORTS: TLocalEffort[] = ["low", "medium", "high", "xhigh", "max"];

const CLAUDE_ORIGIN = { provider: "claude-subscription", label: "Claude 订阅", via: null };
const MODELS: TLocalModelProfile[] = [
  { id: "subscription", label: "订阅 · 默认", source: "subscription", agent: "claude-code", baseUrl: null, model: null, smallModel: null, webSearch: true, hasKey: false, isDefault: true, efforts: [...CLAUDE_EFFORTS], defaultEffort: null,
    origin: CLAUDE_ORIGIN, modelName: "自动" },
  { id: "sub-haiku", label: "订阅 · Haiku", source: "subscription", agent: "claude-code", baseUrl: null, model: "haiku", smallModel: null, webSearch: true, hasKey: false, isDefault: false, efforts: [...CLAUDE_EFFORTS], defaultEffort: null,
    origin: CLAUDE_ORIGIN, modelName: "Haiku 5.5" },
  // 网关模型本机不传思考程度（36 条）。
  { id: "tokenhub-deepseek", label: "TokenHub · DeepSeek", source: "gateway", agent: "claude-code", baseUrl: "https://tokenhub.example/anthropic", model: "deepseek-v4.1-flash", smallModel: null, webSearch: true, hasKey: true, isDefault: false, efforts: [], defaultEffort: null,
    origin: { provider: "tokenhub", label: "TokenHub", via: null }, modelName: "deepseek-v4.1-flash" },
];

/** 连接页连上 TokenHub 后本机建的（th- 开头）。 */
const tokenHubModel = (model: string, name: string): TLocalModelProfile => ({
  id: `th-${model.replace(/[^A-Za-z0-9_-]/g, "_")}`, label: name, source: "gateway", agent: "claude-code", baseUrl: "https://tokenhub.example/api/anthropic", model, smallModel: null,
  webSearch: true, hasKey: true, isDefault: false, efforts: [], defaultEffort: null, catalog: false, origin: { provider: "tokenhub", label: "TokenHub", via: null }, modelName: name,
});
const TOKENHUB_MODELS = [tokenHubModel("wangsu/claude-opus-5-5", "Opus 5.5"), tokenHubModel("wangsu/deepseek-v4.1-flash", "deepseek-v4.1-flash")];

/** 添加来源的预设厂商（同契约 LocalSourcePreset 列的 9 家；这一版只接 Claude Code）。 */
const both = { plans: ["api", "coding_plan"] as TLocalSourcePlan[], regions: ["cn", "intl"] as TLocalSourceRegion[] };
export const SOURCE_PRESETS: TLocalSourcePreset[] = [
  { id: "anthropic", name: "Anthropic", plans: ["api"], regions: [], agents: ["claude-code"] },
  { id: "tokenhub", name: "TokenHub", plans: ["api"], regions: [], agents: ["claude-code"] },
  { id: "kimi", name: "Kimi", ...both, agents: ["claude-code"] },
  { id: "glm", name: "智谱 GLM", ...both, agents: ["claude-code"] },
  { id: "deepseek", name: "DeepSeek", plans: ["api"], regions: [], agents: ["claude-code"] },
  { id: "qwen", name: "通义千问", ...both, agents: ["claude-code"] },
  { id: "minimax", name: "MiniMax", ...both, agents: ["claude-code"] },
  { id: "volcengine", name: "火山方舟", plans: ["api", "coding_plan"], regions: [], agents: ["claude-code"] },
  { id: "openrouter", name: "OpenRouter", plans: ["api"], regions: [], agents: ["claude-code"] },
];
/** 假的模型表：按量 API 读到的、编程套餐的预设表都用它（本机建议先勾的排前面）。 */
const SOURCE_MODELS: Record<string, TLocalSourceModel[]> = {
  anthropic: [{ id: "claude-opus-5-5", name: "Opus 5.5" }, { id: "claude-sonnet-5-5", name: "Sonnet 5.5" }, { id: "claude-haiku-4-5", name: "Haiku 4.5" }, { id: "claude-opus-5-1", name: "Opus 5.1" }, { id: "claude-sonnet-4-5", name: "Sonnet 4.5" }],
  kimi: [{ id: "kimi-k2.5", name: "kimi-k2.5" }, { id: "kimi-k2-turbo", name: "kimi-k2-turbo" }, { id: "kimi-k2-0905", name: "kimi-k2-0905" }],
  glm: [{ id: "glm-5", name: "glm-5" }, { id: "glm-4.6", name: "glm-4.6" }, { id: "glm-4.5-air", name: "glm-4.5-air" }],
  deepseek: [{ id: "deepseek-v4.1", name: "deepseek-v4.1" }, { id: "deepseek-v4.1-flash", name: "deepseek-v4.1-flash" }],
  qwen: [{ id: "qwen3.5-coder-plus", name: "qwen3.5-coder-plus" }, { id: "qwen3-max", name: "qwen3-max" }],
  minimax: [{ id: "MiniMax-M3", name: "MiniMax-M3" }, { id: "MiniMax-M2.5", name: "MiniMax-M2.5" }],
  volcengine: [{ id: "doubao-seed-2-code", name: "doubao-seed-2-code" }, { id: "kimi-k2.5", name: "kimi-k2.5" }],
  openrouter: [{ id: "anthropic/claude-opus-5-5", name: "Opus 5.5" }, { id: "z-ai/glm-5", name: "glm-5" }, { id: "moonshotai/kimi-k2.5", name: "kimi-k2.5" }],
};
const PLAN_NAME: Record<TLocalSourcePlan, string> = { api: "API", coding_plan: "编程套餐" };
/** 按 Key 的开头认厂商（假的规则，真的在本机程序里）。 */
function recognizeKey(apiKey: string): { presetId: string; plan: TLocalSourcePlan; region: TLocalSourceRegion | null } | null {
  if (apiKey.startsWith("sk-ant-")) return { presetId: "anthropic", plan: "api", region: null };
  if (apiKey.startsWith("sk-or-")) return { presetId: "openrouter", plan: "api", region: null };
  if (apiKey.startsWith("sk-sp-")) return { presetId: "qwen", plan: "coding_plan", region: "cn" };
  return null;
}

/**
 * Claude 订阅的模型目录（设计 17.2 第 40 条，D 契约 584eb5e9）：Claude Code 握手回的模型每个一条，只读（catalog），id 是 cc- 开头；
 * 不能选思考的 efforts 为空（Haiku 4.5）。排在本人配的后面（真的本机程序里「自动」在最上面，目录已经筛过）。
 */
const claudeModel = (id: string, model: string, name: string, efforts: TLocalEffort[]): TLocalModelProfile => ({
  id, label: name, source: "subscription", agent: "claude-code", baseUrl: null, model, smallModel: null, webSearch: true, hasKey: false, isDefault: false,
  efforts, defaultEffort: null, catalog: true, origin: CLAUDE_ORIGIN, modelName: name,
});
const CLAUDE_MODELS: TLocalModelProfile[] = [
  claudeModel("cc-opus", "opus", "Opus 5.5", [...CLAUDE_EFFORTS]),
  claudeModel("cc-sonnet", "sonnet", "Sonnet 5.5", [...CLAUDE_EFFORTS]),
  claudeModel("cc-claude-fable-5-2", "claude-fable-5-2", "Fable 5.2", [...CLAUDE_EFFORTS]),
  claudeModel("cc-claude-haiku-4-5", "claude-haiku-4-5", "Haiku 4.5", []),
];

/**
 * Codex 订阅的模型目录（设计 17.2 第 38 条，D 契约 b28c1f12）：登录着才有，只读（catalog）；每个模型自己的几档，gpt-6.1-sol 多一档 ultra。
 */
const CODEX_ORIGIN = { provider: "codex", label: "Codex 订阅", via: null };
const CODEX_MODELS: TLocalModelProfile[] = [
  { id: "codex-gpt-6_1-sol", label: "GPT-6.1-Sol", source: "subscription", agent: "codex", baseUrl: null, model: "gpt-6.1-sol", smallModel: null, webSearch: true, hasKey: false, isDefault: false,
    efforts: [...CLAUDE_EFFORTS, "ultra"], defaultEffort: "low", catalog: true, origin: CODEX_ORIGIN, modelName: "GPT-6.1-Sol" },
  { id: "codex-gpt-5_5", label: "GPT-5.5", source: "subscription", agent: "codex", baseUrl: null, model: "gpt-5.5", smallModel: null, webSearch: true, hasKey: false, isDefault: false,
    efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium", catalog: true, origin: CODEX_ORIGIN, modelName: "GPT-5.5" },
];

/** onPlanned：规划员拆完时调（假装本机把 card_plan 同步上去了）。 */
/** 假的「查一次连没连上」：地址里带 401 是钥匙不对，带 down 是连不上，其余连上、有 6 个工具。 */
function probeTool(tool: TLocalTool): Pick<TLocalTool, "state" | "toolCount" | "error" | "checkedAt"> {
  const checkedAt = new Date().toISOString();
  if (/401/.test(tool.url)) return { state: "unauthorized", toolCount: null, error: "钥匙不对（401）", checkedAt };
  if (/down/.test(tool.url)) return { state: "unreachable", toolCount: null, error: "连不上这个地址", checkedAt };
  return { state: "ready", toolCount: 6, error: null, checkedAt };
}

/** 照契约存一个工具：不收命令；钥匙不传保留、空串删掉；地址改了又没给新钥匙，旧钥匙作废。存完查一次。 */
function upsertTool(tools: TLocalTool[], id: string, body: TLocalToolUpsert): TLocalTool {
  if ("command" in body || "args" in body) throw new LocalRunnerError("validation", "只收 HTTP 地址", 400);
  if (!/^https?:\/\//.test(body.url)) throw new LocalRunnerError("validation", "地址要以 http:// 或 https:// 开头", 400);
  const old = tools.find((tool) => tool.id === id);
  if (!old && tools.length >= 20) throw new LocalRunnerError("validation", "最多 20 个工具", 400);
  const hasKey = body.apiKey !== undefined ? body.apiKey !== "" : Boolean(old?.hasKey && old.url === body.url);
  const next: TLocalTool = { id, name: body.name, preset: body.preset, url: body.url, keyHeader: body.keyHeader ?? null, hasKey, state: "unknown", toolCount: null, error: null, checkedAt: null, addedAt: old?.addedAt ?? new Date().toISOString() };
  Object.assign(next, probeTool(next));
  if (old) Object.assign(old, next); else tools.push(next);
  return old ?? next;
}

/** codex：Codex 登没登录（默认没登录，连接页点「连接」走一遍登录）。 */
export type MockOptions = { stepMs?: number; paired?: boolean; onPlanned?: (taskId: string) => void; codex?: "logged_in" | "logged_out" };

export function createMockRunner({ stepMs = 900, paired = true, onPlanned, codex = "logged_out" }: MockOptions = {}): LocalRunner {
  let token = paired ? "mock-token-0000000000000000000000" : "";
  let codexIn = codex === "logged_in";
  let codexSetup: { phase: "idle" | "waiting_browser"; startedAt: string | null } = { phase: "idle", startedAt: null };
  let tokenHub: TLocalModelProfile[] = [];
  let sources: TLocalSource[] = [];
  let sourceProfiles: TLocalModelProfile[] = [];
  const models = () => [...MODELS, ...tokenHub, ...sourceProfiles, ...CLAUDE_MODELS, ...(codexIn ? CODEX_MODELS : [])];
  /** 验一把 Key（假的）：带 bad 当成不认，带 offline 当成连不上，带 empty 当成列不出模型。 */
  const vet = (apiKey: string, name: string) => {
    if (apiKey.includes("bad")) throw new LocalRunnerError("source_key_rejected", "Key 不对", 422);
    if (apiKey.includes("offline")) throw new LocalRunnerError("source_unreachable", `连不上${name}`, 502);
    if (apiKey.includes("empty")) throw new LocalRunnerError("source_no_models", "这个 Key 没有能用的模型", 422);
  };
  const tokenHubSource = (): TLocalSource[] => (tokenHub.length ? [{ id: "tokenhub", presetId: "tokenhub", name: "TokenHub", plan: "api", region: null, baseUrl: "https://tokenhub.example/api/anthropic",
    formats: ["anthropic"], agents: ["claude-code"], models: tokenHub.map((model) => ({ id: model.model ?? model.id, name: model.modelName ?? model.label })), verified: true, addedAt: now() }] : []);
  const sessions = new Map<string, MockSession>();
  const projects = new Map<string, TLocalProjectFolder>();
  const bindAll = (projectId: string, list: TLocalFolder[], name?: string): TLocalProjectFolder => {
    const refs = list.map((folder) => ({ id: folder.id, path: folder.path, label: folder.label }));
    const bound = { projectId, name: name ?? projects.get(projectId)?.name ?? null, folder: refs[0] ?? null, folders: refs, updatedAt: now() };
    projects.set(projectId, bound);
    return bound;
  };
  /** 只给一个（folderId 那条路）：换掉第一个，其余的不动；它本来在其余的里面时挪到第一个；null 全部解绑。 */
  const bind = (projectId: string, folder: TLocalFolder | null, name?: string): TLocalProjectFolder => {
    const rest = (projects.get(projectId)?.folders ?? []).slice(1).filter((entry) => entry.id !== folder?.id).flatMap((entry) => folders.filter((known) => known.id === entry.id));
    return bindAll(projectId, folder ? [folder, ...rest] : [], name);
  };
  const folders: TLocalFolder[] = [{ id: "f1", path: "C:\\work\\tianshu", label: "tianshu", addedAt: new Date().toISOString() }];
  const tools: TLocalTool[] = [{ id: "kb", name: "知识库", preset: "custom", url: "https://mcp.example.com/kb", keyHeader: null, hasKey: true, state: "ready", toolCount: 6, error: null, checkedAt: new Date().toISOString(), addedAt: new Date().toISOString() }];
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
  /** 推一条草稿（全文）；空串是清掉。 */
  const draftTo = (s: MockSession, text: string) => { for (const send of s.drafters) send({ type: "draft", sessionId: s.summary.id, text }); };
  /**
   * 执行方说一段话：有在看草稿的就先按草稿一点点推（每 80ms 一条到目前为止的全文，同真本机），说完再发 assistant_text，然后 done；
   * 没人看草稿（测试）直接发。推草稿期间占着 s.timer，停下、强停时清掉。
   */
  const speak = (s: MockSession, text: string, done: () => void) => {
    if (!s.drafters.size) { emit(s, { type: "assistant_text", text }); done(); return; }
    let shown = 0;
    const tick = () => {
      shown = Math.min(text.length, shown + 6);
      draftTo(s, text.slice(0, shown));
      if (shown < text.length) { s.timer = setTimeout(tick, 80); return; }
      s.timer = null;
      emit(s, { type: "assistant_text", text });
      done();
    };
    tick();
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
  /** 上下文用了多少（17.2 第 42 条）：摘要和事件流一起更新。 */
  const CONTEXT_MAX = 200_000;
  const reportContext = (s: MockSession, usedTokens: number) => {
    s.summary = { ...s.summary, context: { usedTokens, maxTokens: CONTEXT_MAX, at: now() } };
    emit(s, { type: "context_usage", usedTokens, maxTokens: CONTEXT_MAX });
  };
  const turnEnd = (s: MockSession, text: string | null, errorKind?: "interrupted") => {
    // 每轮做完涨一截；快满了执行方自己压缩一次。
    const grown = (s.summary.context?.usedTokens ?? 96_000) + 70_000;
    if (grown > CONTEXT_MAX * 0.95) { emit(s, { type: "notice", level: "info", code: "context_compacted", text: "压缩了上下文" }); reportContext(s, 42_000); } else reportContext(s, grown);
    const usage = { ...ZERO, inputTokens: 1200, outputTokens: 320, costUsd: 0.004 };
    s.summary = { ...s.summary, usage: { ...s.summary.usage, inputTokens: s.summary.usage.inputTokens + 1200, outputTokens: s.summary.usage.outputTokens + 320, costUsd: (s.summary.usage.costUsd ?? 0) + 0.004 } };
    emit(s, { type: "turn_end", isError: false, text, durationMs: stepMs * 4, usage, ...(errorKind ? { errorKind } : {}) });
  };

  /** 真的执行方回答是 Markdown（17.2 第 41 条按 Markdown 排），假的也带一点：粗体、列表、行内代码、代码块、表格。 */
  const ANSWER_TEXT = ["好，按你说的改，**两处**：", "", "- 删掉旧的安装说明", "- `README.md` 里的链接换到新说明", "", "```bash", "git rm docs/install-old.md", "```", "", "| 文件 | 改动 |", "| --- | --- |", "| README.md | 换链接 |", "| docs/install-old.md | 删掉 |"].join("\n");
  /** 假的「本会话改过的文件」（17.2 第 41 条）：一个 Markdown、一个代码文件、一张图、一个删掉了的。 */
  const FILE_ROOT = "C:/work/tianshu";
  const FILES: Record<string, { kind: "markdown" | "text" | "image"; mimeType: string; content: string; sources: ("tool" | "git")[] }> = {
    "交回说明.md": { kind: "markdown", mimeType: "text/markdown", sources: ["tool"], content: ["# 交回说明", "", "改了 **两处**，测试都过。", "", "- `README.md` 的链接换到新说明", "- 旧的安装说明删掉了"].join("\n") },
    "README.md": { kind: "markdown", mimeType: "text/markdown", sources: ["tool", "git"], content: ["# tianshu", "", "安装见 [安装说明](docs/install.md)。"].join("\n") },
    "apps/web/src/app/manifest.ts": { kind: "text", mimeType: "text/plain", sources: ["git"], content: ["export default function manifest() {", "  return { name: \"天枢\" };", "}"].join("\n") },
    "apps/web/public/icon.png": { kind: "image", mimeType: "image/png", sources: ["git"],
      content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" },
  };
  const script: Step[] = [
    (s) => { reportActual(s); setStatus(s, "running"); noteWorkspace(s); emit(s, { type: "agent_info", agent: "claude-code", version: "2.1.318", model: s.summary.modelLabel, permissionMode: "manual" }); },
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
    (s) => { setStatus(s, "running"); speak(s, ANSWER_TEXT, () => { plan(s, 2); advance(s); }); return "wait"; },
    (s) => { tool(s, "Write", "写 交回说明.md"); emit(s, { type: "artifact", artifactId: `a${++seqId}`, title: "交回说明", fileName: "交回说明.md", size: 2048, sha256: "0".repeat(64) }); },
    (s) => {
      plan(s, 3);
      const ws = s.summary.workspace;
      finishBackground(s, "done");
      let turnFiles: ReturnType<ReturnType<typeof createMockEdits>["apply"]> = [];
      if (ws?.kind !== "worktree" && !s.edits) {
        s.edits = createMockEdits();
        tool(s, "Edit", "改 周报.md");
        turnFiles = s.edits.apply();
      }
      emit(s, { type: "handback", summary: "改完了，测试都过。", criteria: [{ index: 1, result: "met", evidence: "测试 12/12 通过" }, { index: 2, result: "met", evidence: "交回说明.md" }], outputKeys: [],
        ...(ws?.kind === "worktree" ? { commit: sha(`${s.summary.id}:handback`) } : {}) });
      if (turnFiles.length) emit(s, { type: "turn_files" as TLocalSessionEvent["type"], files: turnFiles });
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
  // 执行方报上来实际跑的模型（以它为准）。
  const reportActual = (s: MockSession) => { if (s.summary.run) s.summary = { ...s.summary, run: { ...s.summary.run, actual: { model: s.summary.run.model ?? "opus", modelName: s.summary.run.modelName ?? "Opus 5.5", at: now() } } }; };
  const started = (s: MockSession, mode: string) => { reportActual(s); setStatus(s, "running"); emit(s, { type: "agent_info", agent: "claude-code", version: "2.1.318", model: s.summary.modelLabel, permissionMode: mode }); };
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

  /** 交回以后本人再说一句：第二轮删一个文件、改 Word、Excel 和老格式的表，一轮末尾报这一轮改了哪些。 */
  const editRound = (s: MockSession) => {
    setStatus(s, "running");
    s.timer = setTimeout(() => {
      s.timer = null;
      tool(s, "Bash", "运行 Remove-Item 旧安排.md");
      tool(s, "Bash", "运行 python 改合同和报表.py");
      const turnFiles = s.edits!.apply();
      emit(s, { type: "assistant_text", text: "旧安排.md 删了，合同的付款期限和报表也改好了。" });
      emit(s, { type: "turn_files" as TLocalSessionEvent["type"], files: turnFiles });
      turnEnd(s, "改好了。");
      setStatus(s, "idle");
    }, stepMs * 2);
  };
  const summaryOf = (s: MockSession) => ({ ...s.summary });
  const listen = (s: MockSession, fn: (event: TLocalSessionEvent) => void) => { s.listeners.add(fn); return () => s.listeners.delete(fn); };

  return {
    kind: "mock",
    clientMessageIds: true,
    health: async () => ({ app: "tianshu-local", version: "0.1.0-mock", protocol: 2, platform: "win32", tokenValid: Boolean(token), slots: slots() }),
    startPairing: async () => ({ pairingId: "mock-pairing", code: "4821", expiresAt: new Date(Date.now() + 120_000).toISOString() }),
    pairingStatus: async () => { token = "mock-token-0000000000000000000000"; return { status: "approved", token }; },
    unpair: async () => { token = ""; },
    status: async () => ({
      deviceId: "00000000-0000-4000-8000-000000000001", version: "0.1.0-mock",
      agents: [{ kind: "claude-code", installed: true, version: "2.1.318", path: null, loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", loginExpiresAt: null, minimumVersion: "2.1.300", compatible: true, setup: { phase: "idle", startedAt: null, loginUrl: null, error: null } },
        { kind: "codex", installed: true, version: "0.159.2", path: null, loggedIn: codexIn, authMethod: codexIn ? "chatgpt" : null, subscriptionType: codexIn ? "pro" : null, loginExpiresAt: null, minimumVersion: "0.159.0", compatible: true,
          setup: { ...codexSetup, loginUrl: codexSetup.phase === "waiting_browser" ? "https://auth.openai.com/oauth/authorize?mock" : null, error: null } }],
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
        ...(codexIn ? [{ id: "codex", name: "Codex", kind: "subscription" as const, remainingPercent: 64, amounts: [], resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
          plan: "pro", blockedUntil: null, extraUsage: null, updatedAt: now(), error: null, windows: [{ kind: "session" as const, model: null, usedPercent: 36, state: "ok" as const, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString() }] }] : []),
        { id: "tokenhub:mock", name: "TokenHub", kind: "daily_spend", remainingPercent: null, amounts: [{ amount: 12.4, currency: "CNY", estimated: false }],
          monthAmounts: [{ amount: 186, currency: "CNY", estimated: false }], windows: [], resetsAt: null, blockedUntil: null, plan: null, extraUsage: null, updatedAt: now(), error: null },
      ],
      tools: (["claude-code", "codex", "gh", "lark-cli"] as const).map((kind) => ({ kind, state: "ready" as const, version: null, account: null, checkedAt: now() })),
    }),
    // Codex 登录（D 契约 b28c1f12）：本机替本人开浏览器，等一会儿算登好了；Claude Code 照旧什么都不做。
    login: async (agent = "claude-code") => {
      if (agent !== "codex" || codexIn) return;
      codexSetup = { phase: "waiting_browser", startedAt: now() };
      setTimeout(() => { codexIn = true; codexSetup = { phase: "idle", startedAt: null }; }, stepMs * 2);
    },
    linkCloud: async (body) => { linked = true; return { linked, apiBaseUrl: body.apiBaseUrl, personName: body.personName ?? null, personId: body.personId ?? null, outbox: { pending: 0, lastSyncedAt: null, lastError: null } }; },
    patchSettings: async (patch) => {
      if (patch.includePersonalConfigByDefault !== undefined) includePersonal = patch.includePersonalConfigByDefault;
      if (patch.maxConcurrent !== undefined) { maxConcurrent = patch.maxConcurrent; promote(); }
      if (patch.autoMerge !== undefined) autoMerge = patch.autoMerge;
      return { includePersonalConfigByDefault: includePersonal, allowedOrigins: [], paused: Boolean(patch.paused), maxConcurrent, autoMerge };
    },
    listModels: async () => models(),
    // 连 TokenHub：Key 里带 bad 当成 Key 不对，带 offline 当成连不上，带 empty 当成没有能用的模型，别的连上两个模型
    connectTokenHub: async (apiKey) => {
      await new Promise((resolve) => setTimeout(resolve, stepMs));
      if (apiKey.includes("bad")) throw new LocalRunnerError("tokenhub_key_rejected", "Key 不对", 422);
      if (apiKey.includes("offline")) throw new LocalRunnerError("tokenhub_unreachable", "连不上 TokenHub", 502);
      if (apiKey.includes("empty")) throw new LocalRunnerError("tokenhub_no_models", "这个 Key 没有能用的模型", 422);
      tokenHub = TOKENHUB_MODELS;
      return models();
    },
    disconnectTokenHub: async () => { tokenHub = []; },
    listSources: async () => ({ presets: SOURCE_PRESETS, sources: [...tokenHubSource(), ...sources] }),
    checkSource: async (body) => {
      await new Promise((resolve) => setTimeout(resolve, stepMs / 2));
      if (body.presetId === null || (!body.presetId && body.baseUrl)) return { recognized: null, candidates: [], models: [], verified: false };
      const known = body.presetId ? null : recognizeKey(body.apiKey);
      const presetId = body.presetId ?? known?.presetId ?? null;
      if (!presetId) return { recognized: null, candidates: body.apiKey.startsWith("sk-") ? ["deepseek", "kimi", "qwen", "glm", "minimax"] : [], models: [], verified: false };
      const preset = SOURCE_PRESETS.find((entry) => entry.id === presetId);
      if (!preset) throw new LocalRunnerError("validation", "没有这家", 400);
      const plan = body.plan ?? known?.plan ?? preset.plans[0]!;
      const region = preset.regions.length ? body.region ?? known?.region ?? "cn" : null;
      if (plan === "api") vet(body.apiKey, preset.name);
      return { recognized: { presetId, plan, region }, candidates: [], models: SOURCE_MODELS[presetId] ?? TOKENHUB_MODELS.map((model) => ({ id: model.model!, name: model.modelName! })), verified: plan === "api" };
    },
    addSource: async (body) => {
      await new Promise((resolve) => setTimeout(resolve, stepMs / 2));
      const preset = body.presetId ? SOURCE_PRESETS.find((entry) => entry.id === body.presetId) ?? null : null;
      if (body.presetId && !preset) throw new LocalRunnerError("validation", "没有这家", 400);
      const plan = body.plan ?? preset?.plans[0] ?? "api";
      if (plan === "api" && preset) vet(body.apiKey, preset.name);
      if (body.presetId === "tokenhub") {
        tokenHub = TOKENHUB_MODELS.filter((model) => body.models.includes(model.model!));
        return { source: tokenHubSource()[0]!, profiles: models() };
      }
      const region = preset?.regions.length ? body.region ?? "cn" : null;
      const id = preset ? [preset.id, plan, region].filter(Boolean).join("-") : `custom-${(body.name ?? "来源").replace(/\s+/g, "-")}`;
      const list = preset ? SOURCE_MODELS[preset.id] ?? [] : [];
      const name = preset ? (preset.id === "anthropic" ? "Anthropic 官方 API" : `${preset.name} ${PLAN_NAME[plan]}`) : body.name ?? "自定义";
      const picked = body.models.map((model) => list.find((entry) => entry.id === model) ?? { id: model, name: model.replace(/^[^/]+\//, "") });
      const source: TLocalSource = { id, presetId: preset?.id ?? null, name, plan, region, baseUrl: body.baseUrl ?? `https://${preset?.id ?? "custom"}.example/anthropic`,
        formats: ["anthropic"], agents: ["claude-code"], models: picked, verified: plan === "api" && !!preset, addedAt: now() };
      sources = [...sources.filter((entry) => entry.id !== id), source];
      sourceProfiles = [...sourceProfiles.filter((profile) => profile.sourceId !== id), ...picked.map((model): TLocalModelProfile => ({
        id: `src-${id}-${model.id.replace(/[^A-Za-z0-9_-]/g, "_")}`, label: model.name, source: "gateway", agent: "claude-code", baseUrl: source.baseUrl, model: model.id, smallModel: null,
        webSearch: false, hasKey: true, isDefault: false, efforts: [], defaultEffort: null, catalog: false, origin: { provider: preset?.id ?? "custom", label: name, via: null }, modelName: model.name, sourceId: id,
      }))];
      return { source, profiles: models() };
    },
    deleteSource: async (id) => {
      if (id === "tokenhub") { tokenHub = []; return; }
      sources = sources.filter((entry) => entry.id !== id);
      sourceProfiles = sourceProfiles.filter((profile) => profile.sourceId !== id);
    },
    putModel: async (id, body) => ({ id, label: body.label, source: body.source, agent: "claude-code", baseUrl: body.baseUrl ?? null, model: body.model, smallModel: body.smallModel ?? null, webSearch: body.webSearch ?? false, hasKey: Boolean(body.apiKey), isDefault: Boolean(body.isDefault) }),
    listTools: async () => tools.map((tool) => ({ ...tool })),
    putTool: async (id, body) => { const tool = upsertTool(tools, id, body); return { ...tool }; },
    removeTool: async (id) => { const i = tools.findIndex((tool) => tool.id === id); if (i >= 0) tools.splice(i, 1); },
    checkTool: async (id) => {
      const tool = tools.find((entry) => entry.id === id);
      if (!tool) throw new LocalRunnerError("not_found", "没有这个工具", 404);
      return { ...Object.assign(tool, probeTool(tool)) };
    },
    listFolders: async () => folders,
    // 选文件夹（17.2 第 32 条）：假程序不弹窗，直接加一个；带项目时一步绑上。
    pickFolder: async (body = {}) => {
      const folder = { id: `f${folders.length + 1}`, path: `C:\\work\\project-${folders.length + 1}`, label: `project-${folders.length + 1}`, addedAt: now() };
      folders.push(folder);
      return { folder, ...(body.projectId ? { project: bind(body.projectId, folder, body.projectName) } : {}) };
    },
    // 新建文件夹：照本机的规矩查名字，重名（不分大小写）409，建在桌面，带项目时一步绑上。
    createFolder: async (body) => {
      const name = body.name.trim();
      if (!name || /[\\/:*?"<>|]/.test(name) || /[. ]$/.test(name)) throw new LocalRunnerError("validation", "名字里不能有 \\ / : * ? \" < > |，也不能以点或空格结尾", 400);
      if (folders.some((entry) => entry.label.toLowerCase() === name.toLowerCase())) throw new LocalRunnerError("conflict", "桌面上已经有同名的文件夹", 409);
      const folder = { id: `f${folders.length + 1}`, path: `C:\\Users\\me\\Desktop\\${name}`, label: name, addedAt: now() };
      folders.push(folder);
      return { folder, ...(body.projectId ? { project: bind(body.projectId, folder, body.projectName) } : {}) };
    },
    // 删掉一个允许的文件夹：它从绑着它的项目里一起拿掉（拿掉的是第一个时，剩下的第一个成了工作目录）。
    removeFolder: async (id) => {
      const i = folders.findIndex((f) => f.id === id);
      if (i >= 0) folders.splice(i, 1);
      for (const [projectId, entry] of projects) {
        if (entry.folders?.some((ref) => ref.id === id)) bindAll(projectId, entry.folders.flatMap((ref) => folders.filter((known) => known.id === ref.id)), entry.name ?? undefined);
      }
    },
    listProjects: async () => [...projects.values()],
    putProjectFolder: async (projectId, body) => {
      if (body.folderIds) {
        const list = body.folderIds.map((id) => folders.find((entry) => entry.id === id));
        if (list.some((entry) => !entry)) throw new LocalRunnerError("not_found", "没有这个文件夹，先选文件夹", 404);
        return bindAll(projectId, list as TLocalFolder[], body.name);
      }
      const folder = body.folderId ? folders.find((entry) => entry.id === body.folderId) : null;
      if (body.folderId && !folder) throw new LocalRunnerError("not_found", "没有这个文件夹，先选文件夹", 404);
      return bind(projectId, folder ?? null, body.name);
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
    sendMessage: async (id, text, kind, attachments, given) => {
      const s = must(id);
      const was = s.summary.status;
      // 回执（17.4）：假程序收下即送达，下一步读到。网页给了编号就用它的（先画的那句按它换成真的）。
      const messageId = given ?? crypto.randomUUID();
      const receipts = () => { emit(s, { type: "receipt", messageId, state: "delivered" }); setTimeout(() => emit(s, { type: "receipt", messageId, state: "read" }), stepMs); };
      if (kind === "review") {
        // 评审会：并行挑刺、合成「分歧和建议」存成一版（假程序只吐事件）。
        emit(s, { type: "user_message", text: text || "开评审会", source: "web", messageId });
        receipts();
        setTimeout(() => { emit(s, { type: "assistant_text", text: "几位挑刺的看完了，合成好了。" }); emit(s, { type: "version", number: 99, kind: "review", label: "评审", note: null }); }, stepMs * 3);
        return { delivery: was === "running" ? "next_step" : "new_turn", messageId };
      }
      emit(s, { type: "user_message", text, source: "web", messageId, ...(attachments?.length ? { attachments: attachments.map((file) => ({ name: file.fileName, path: file.fileName, size: file.size })) } : {}) });
      receipts();
      s.paused = false;
      if (s.summary.pendingQuestion) {
        emit(s, { type: "question_resolved", requestId: s.summary.pendingQuestion.requestId, choices: null, text: null });
        s.summary = { ...s.summary, pendingQuestion: undefined };
      }
      if (was === "running") { emit(s, { type: "notice", level: "info", code: "interjection_next_step", text: "下一步生效" }); return { delivery: "next_step", messageId }; }
      // 交回以后再说一句：演第二轮改文件（第 71 条：删一个、改几个）。
      if (s.edits?.pending() && s.cursor >= s.script.length) { editRound(s); return { delivery: "new_turn", messageId }; }
      advance(s);
      return { delivery: was === "exited" || was === "done" ? "resumed" : "new_turn", messageId };
    },
    interrupt: async (id) => {
      const s = must(id);
      if (s.timer) { clearTimeout(s.timer); s.timer = null; }
      draftTo(s, "");
      s.paused = true;
      turnEnd(s, null, "interrupted");
      setStatus(s, "idle");
      return summaryOf(s);
    },
    kill: async (id) => {
      const s = must(id);
      if (s.timer) { clearTimeout(s.timer); s.timer = null; }
      draftTo(s, "");
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
      // 先出计划：批了就转成自动接着做（和本机一样报一条 permission_mode）。
      if (body.decision === "allow" && s.summary.permissionMode === "plan") {
        s.summary = { ...s.summary, permissionMode: "auto" };
        emit(s, { type: "permission_mode", mode: "auto", by: "plan_approved" });
      }
      advance(s);
      return summaryOf(s);
    },
    // 换模型（17.2 第 32 条）：同一个来源、或会话没在跑时当场换（now）；跨来源又正在跑，等这一轮做完（after_turn，摘要带 pendingModel，假程序隔几步换上）。
    // 只带 effort 是同一个模型换思考程度（Claude Code 当场换）；只换模型时原来的思考程度新模型也支持就留着，不然回到自动（36 条）。
    setSessionModel: async (id, body) => {
      const s = must(id);
      const current = models().find((entry) => entry.id === s.summary.modelProfileId);
      const model = body.modelProfileId === undefined ? current : models().find((entry) => entry.id === body.modelProfileId);
      if (!model) throw new LocalRunnerError("validation", "没有这个模型", 400);
      // 换执行方（D 契约 5a217add）：modelProfileId 是另一家的就是换；规划员、验收员只能用 Claude Code。
      const crossing = model.agent !== s.summary.agent;
      if (crossing && model.agent === "codex" && (s.summary.subject.kind === "plan" || s.summary.subject.kind === "verify")) throw new LocalRunnerError("validation", "规划员、验收员只能用 Claude Code", 400);
      const wanted = body.effort === undefined ? s.summary.effort ?? null : body.effort;
      if (body.effort && !model.efforts?.includes(body.effort)) throw new LocalRunnerError("validation", "这个模型没有这一档", 400);
      const effort = wanted && model.efforts?.includes(wanted) ? wanted : null;
      const apply = () => {
        const { pendingModel: _done, effort: _old, ...rest } = s.summary;
        const was = s.summary.agent;
        s.summary = { ...rest, agent: model.agent, modelProfileId: model.id, modelLabel: model.label, run: runFor(model, "auto", effort), ...(effort ? { effort } : {}) };
        if (model.agent !== was) {
          emit(s, { type: "notice", level: "info", code: "harness_changed", text: `换成 ${model.agent === "codex" ? "Codex" : "Claude Code"} · ${runFor(model).modelName}${effort ? ` · 思考 ${effort}` : ""}` });
          // 新的那家没有现在这一档（「先出计划」换到 Codex）：改成「每次都问」。
          if (s.summary.permissionMode === "plan" && model.agent === "codex") { s.summary = { ...s.summary, permissionMode: "default" }; emit(s, { type: "permission_mode", mode: "default", by: "harness_changed" }); }
        } else if (model !== current) emit(s, { type: "notice", level: "info", code: "model_changed", text: `换成 ${runFor(model).modelName}` });
      };
      // Codex：模型和思考程度都是开一轮时带，在跑这一轮时等它做完（after_turn）；Claude Code 跨来源才要等。
      const later = crossing || (s.summary.agent === "codex" ? model !== current || effort !== (s.summary.effort ?? null) : current?.source !== model.source);
      if (OCCUPYING.has(s.summary.status) && later) {
        s.summary = { ...s.summary, pendingModel: { modelProfileId: model.id, modelLabel: runFor(model).modelName, effort } };
        setTimeout(apply, stepMs * 4);
        return { applied: "after_turn", session: summaryOf(s) };
      }
      // 换执行方要等新的那家起来才回（真的要几秒）。
      if (crossing) await new Promise((resolve) => setTimeout(resolve, stepMs * 3));
      apply();
      return { applied: "now", session: summaryOf(s) };
    },
    listSessionFiles: async (id) => {
      const edits = must(id).edits;
      if (edits) return { root: FILE_ROOT, truncated: false, files: edits.list(FILE_ROOT) };
      const size = (file: { kind: string; content: string }) => (file.kind === "image" ? Math.floor(file.content.length * 0.75) : new TextEncoder().encode(file.content).length);
      return {
        root: FILE_ROOT, truncated: false,
        files: [
          ...Object.entries(FILES).map(([path, file]) => ({ path, absolutePath: `${FILE_ROOT}/${path}`, sources: file.sources, exists: true, size: size(file) })),
          { path: "docs/install-old.md", absolutePath: `${FILE_ROOT}/docs/install-old.md`, sources: ["git" as const], exists: false, size: null },
        ].sort((a, b) => a.path.localeCompare(b.path)),
      };
    },
    readSessionFile: async (id, body) => {
      must(id);
      const asked = body.path.replace(/\\/g, "/");
      if (asked.includes("../")) throw new LocalRunnerError("folder_not_allowed", "在本会话的文件夹外面", 403);
      const path = asked.toLowerCase().startsWith(`${FILE_ROOT.toLowerCase()}/`) ? asked.slice(FILE_ROOT.length + 1) : asked;
      const edits = must(id).edits;
      if (edits?.has(path)) {
        const content = edits.content(path);
        const markdown = path.endsWith(".md");
        if (content === null) return { path, absolutePath: `${FILE_ROOT}/${path}`, name: path.split("/").pop()!, size: 40_960, modifiedAt: now(), kind: "other" as const, mimeType: "application/octet-stream", encoding: "utf8" as const, content: null, truncated: false };
        return { path, absolutePath: `${FILE_ROOT}/${path}`, name: path.split("/").pop()!, size: new TextEncoder().encode(content).length, modifiedAt: now(), kind: markdown ? "markdown" as const : "text" as const, mimeType: markdown ? "text/markdown" : "text/plain", encoding: "utf8" as const, content, truncated: false };
      }
      const file = FILES[path];
      if (!file) throw new LocalRunnerError("not_found", "文件不存在", 404);
      return { path, absolutePath: `${FILE_ROOT}/${path}`, name: path.split("/").pop()!, size: file.kind === "image" ? Math.floor(file.content.length * 0.75) : new TextEncoder().encode(file.content).length,
        modifiedAt: now(), kind: file.kind, mimeType: file.mimeType, encoding: file.kind === "image" ? "base64" as const : "utf8" as const, content: file.content, truncated: false };
    },
    // 恢复（第 71、72 条）：一轮正在跑、卡在工作树里做的回 409；revision 对不上回 file_changed（临时）。
    restoreSessionFiles: async (id, body) => {
      const s = must(id);
      if (OCCUPYING.has(s.summary.status) || s.summary.workspace?.kind === "worktree" || !s.edits) throw new LocalRunnerError("conflict", "这一轮还在跑", 409);
      const result = s.edits.restoreFiles(body.paths);
      emit(s, { type: "files_restored", all: !body.paths, restored: result.restored, failed: result.failed });
      return result;
    },
    readFileChanges: async (id, body) => {
      const found = must(id).edits?.read(body.path, body.range);
      if (!found) throw new LocalRunnerError("not_found", "这个文件没改过", 404);
      return found;
    },
    restoreFileChanges: async (id, body) => {
      const s = must(id);
      if (OCCUPYING.has(s.summary.status)) throw new LocalRunnerError("conflict", "这一轮还在跑", 409);
      const outcome = s.edits?.restoreChanges(body.path, body.ids, body.revision) ?? "missing";
      if (outcome === "changed") throw new LocalRunnerError("file_changed" as "conflict", "文件又变了", 409);
      if (outcome === "converted") throw new LocalRunnerError("validation", "这种文件只能整个恢复", 400);
      if (outcome === "missing") throw new LocalRunnerError("not_found", "这个文件没改过", 404);
      emit(s, { type: "files_restored", all: false, restored: [body.path], failed: [] });
    },
    setPermissionMode: async (id, mode) => {
      const s = must(id);
      if (["done", "failed", "exited"].includes(s.summary.status)) throw new LocalRunnerError("conflict", "这个会话已经结束了", 409);
      s.summary = { ...s.summary, permissionMode: mode };
      emit(s, { type: "permission_mode", mode, by: "web" });
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
    previewRun: async (body) => runFor(models().find((entry) => entry.id === body.modelProfileId) ?? MODELS.find((entry) => entry.isDefault) ?? MODELS[0]!, body.taskBudget?.budget.mode, body.effort ?? null),
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
    watch: async (id: string, { after, onEvent, onDraft, onLink, signal }: EventWatch) => {
      const s = must(id);
      onLink?.(true);
      for (const event of s.log) if (event.seq > after) onEvent(event);
      const off = listen(s, onEvent);
      if (onDraft) s.drafters.add(onDraft);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => { off(); if (onDraft) s.drafters.delete(onDraft); resolve(); }, { once: true }));
    },
  };

  async function create(body: TLocalCreateSessionRequest): Promise<TLocalSessionSummary> {
    if (!token) throw new LocalRunnerError("unauthorized", "没配对", 401);
    const model = models().find((m) => m.id === body.modelProfileId) ?? MODELS[0]!;
    // 规划员只能用 Claude Code（D 契约 b28c1f12）。
    if (model.agent === "codex" && body.subject.kind === "plan") throw new LocalRunnerError("validation", "规划员只能用 Claude Code", 400);
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
      summary: { id, subject: body.subject, title: body.title, agent: model.agent, modelProfileId: model.id, modelLabel: model.label, cwd: body.cwd ?? "topics", status: full ? "queued" : "starting", permissionMode: body.permissionMode ?? "auto", run: runFor(model, "auto", body.effort ?? null), ...(body.effort ? { effort: body.effort } : {}), includePersonalConfig: Boolean(body.includePersonalConfig), createdAt: now(), updatedAt: now(), lastSeq: 0, pendingPermissions: 0, queuePosition: full ? slots().queued + 1 : null, usage: { ...ZERO }, ...(workspace && !waitingFor.length ? { workspace } : {}), ...(waitingFor.length ? { waitingFor } : {}),
        ...(workspace?.kind === "worktree" ? {} : { undo: /onedrive/i.test(body.cwd ?? "") ? { state: "touched_only" as const, reason: "sync_folder" as const } : { state: "ready" as const } }) },
      log: [], listeners: new Set(), drafters: new Set(), script: body.subject.kind === "plan" ? planner : body.subject.kind === "verify" ? verifier : script, cursor: 0, timer: null, pending: null, paused: false, denied: false, mergeTries: 0,
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