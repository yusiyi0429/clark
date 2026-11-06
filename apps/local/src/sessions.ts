import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  LocalCardPlan, LocalVerdict,
  type TLocalAgentKind, type TLocalCardPlan, type TLocalCreateSessionRequest, type TLocalHandbackCriterion, type TLocalPermissionRequestView, type TLocalRole,
  type TLocalSendMessageRequest, type TLocalSendMessageResponse, type TLocalSessionKind, type TLocalSessionStatus, type TLocalSlots, type TLocalSessionSubject,
  type TLocalSessionSummary, type TLocalSyncItem, type TLocalTopicVersionKind, type TLocalUsage, type TLocalVerdict, type TLocalVerdictCriterion,
} from "@warmap/contracts";
import { readJson, writeJsonAtomic, nowIso } from "./store.js";
import type { EventLog, EventBody } from "./eventLog.js";
import type { AgentAdapter, AgentRun } from "./agents/types.js";
import type { ModelProfiles } from "./models.js";
import { isInside, type Folders } from "./folders.js";
import type { Outbox } from "./outbox.js";
import { SESSION_MCP_NAME, sessionToolNames } from "./sessionMcp.js";
import { criticAgents, returnText, reviewMessage, systemPrompt } from "./rolePrompt.js";
import { ensureFeishuPlugin, larkSkills } from "./agents/feishuPlugin.js";
import type { VerifyBrief } from "./cloud.js";

/** 云端天枢 MCP 在会话里的名字：和本人在 Claude Code 里配的天枢 MCP 同名，工具名一致。 */
const CLOUD_MCP_NAME = "tianshu";
/**
 * 云端天枢 MCP 里预先放行的只读工具（不弹权限请求）：读 Task 上下文（get_task_context，规划员、验收员、执行都用）；
 * 联网搜索（web_search，博查，钥匙留在服务器）只在岗位有搜索时放行。其余工具（写进展、建事项等）每次调用都要网页批准。
 */
const CLOUD_MCP_CONTEXT_TOOL = "get_task_context";
const CLOUD_MCP_SEARCH_TOOL = "web_search";
/** 规划员、验收员只读：改东西的工具都不给；子 agent 也不给，免得绕过去改。 */
const READ_ONLY_KINDS: TLocalSessionKind[] = ["plan", "verify"];
const WRITE_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash", "PowerShell", "Agent", "Task"];
/** 排队先后：验收员（短，而且卡着交付）→ 规划员 → 执行；同一档先来先跑。 */
const PRIORITY: Record<TLocalSessionKind, number> = { verify: 0, plan: 1, card: 2, topic: 2 };
/** 验收交代取不到（没连天枢、断网、天枢出错）时多久再试一次。 */
const BRIEF_RETRY_MS = 15_000;
/** 验收员一轮做完没交结论时，本机提醒它一次。 */
const VERIFY_NUDGE = "还没交结论：请逐条判完，用 submit_verdict 交一次。";

interface SessionRecord {
  id: string;
  subject: TLocalSessionSubject;
  title: string;
  agent: TLocalAgentKind;
  modelProfileId: string;
  modelLabel: string;
  cwd: string;
  includePersonalConfig: boolean;
  createdAt: string;
  updatedAt: string;
  status: TLocalSessionStatus;
  usage: TLocalUsage;
  /** 同步给云端的条目序号（幂等键的最后一段）。 */
  syncSeq: number;
  /** 本会话的本机 MCP（交产出物、证据、交回）回连本机程序时出示的密钥。 */
  mcpSecret: string;
  /** 交过的产出和证据：编号（A1、E1）给执行方点名用，key 是它们的同步条目幂等键；产出物带 artifactId（同一个文件再交是新一版）。 */
  outputs: { ref: string; key: string; title: string; artifactId?: string }[];
  /** 专题：最近一版的号（开工时取交代里的 latestVersion）。 */
  versionNumber: number;
  /** 专题：本会话最近存的正文一版（提纲、草稿；评审会读它，评审版不算）。 */
  lastVersion: { number: number; path: string } | null;
  /** 岗位（开工时的快照）和专题评审会的挑刺岗位。 */
  role: TLocalRole | null;
  critics: TLocalRole[];
  /** 排队时存着的第一句话；真开始时送出并清空。不为 null 说明这件还没开始过。 */
  queuedMessage: string | null;
  /** 进队的先后（先来先跑；一批里同一毫秒进的也分得清）。 */
  queueOrder: number;
  /** 验收员：是哪个执行会话交回后起的（结论也报给它）。 */
  parentId: string | null;
  /** 验收员：还在等天枢的验收交代（交回送到天枢后才取得到）。 */
  briefPending: boolean;
  /** 验收员：交回那一刻卡的完成标准（交代里给的），逐条判。 */
  criteria: string[];
  /** 验收员：这次交回之前这张卡连续没过几次。 */
  failStreak: number;
  /** 规划员交过几次计划；验收员交过几次结论（只许一次）。 */
  submitted: number;
  /** 验收员：一轮做完没交结论时提醒过没有（只提醒一次）。 */
  nudged: boolean;
}

/** 不合契约时给执行方看的一句（哪个字段、哪里不对）。 */
function schemaProblem(schema: TSchema, value: unknown): string | null {
  if (Value.Check(schema, value)) return null;
  const e = [...Value.Errors(schema, value)][0];
  return e ? `${e.path || "/"} ${e.message}` : "格式不对";
}
const textOrNull = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export class SessionError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "folder_not_allowed" | "validation", message: string) { super(message); }
}

export interface SessionDeps {
  dataDir: string;
  log: EventLog;
  adapters: Partial<Record<TLocalAgentKind, AgentAdapter>>;
  models: ModelProfiles;
  folders: Folders;
  outbox: Outbox;
  deviceId: string;
  /** 本机程序实际监听的端口（本会话 MCP 回连用）。 */
  port: () => number;
  /** 关联了云端时会话挂天枢 MCP（经本机程序转发，令牌不进会话）。 */
  cloudLinked?: () => Promise<boolean>;
  /** 托盘或网页暂停后，不开新会话、不续接旧会话。 */
  paused?: () => boolean;
  /** 同时最多跑几个（本机设置 maxConcurrent）。 */
  maxConcurrent?: () => number;
  /** 本人已装的技能目录（找 lark-* 飞书技能，岗位要飞书时挂给会话）。 */
  skillsDir?: string;
  /** 向天枢取一次交回的验收交代（没有就不自动验收）。 */
  verifyBrief?: (handbackKey: string) => Promise<VerifyBrief>;
  onChange?: () => void;
}

const ARTIFACT_TYPES: Record<string, string> = {
  ".md": "text/markdown", ".markdown": "text/markdown", ".html": "text/html", ".htm": "text/html", ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".txt": "text/plain",
};
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_VERSION_CHARS = 200_000;
const zeroUsage = (): TLocalUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
const LIVE: TLocalSessionStatus[] = ["starting", "running", "waiting_permission", "idle"];
/** 占着位置的状态：一轮做完在等本人回复的（idle）不占，排队的不占。 */
const OCCUPYING: TLocalSessionStatus[] = ["starting", "running", "waiting_permission"];
const CANCELLED_WHILE_STARTING = "启动途中已被强停";

export class SessionManager {
  private readonly records = new Map<string, SessionRecord>();
  private readonly runs = new Map<string, AgentRun>();
  private readonly pending = new Map<string, Map<string, TLocalPermissionRequestView>>();
  private readonly killed = new Set<string>();
  /** 正在拉起（含续接握手）的会话：同一个会话同时只许有一次启动。 */
  private readonly starting = new Map<string, Promise<AgentRun>>();
  /** 启动途中被强停的会话：启动一完成就杀掉。 */
  private readonly cancelled = new Set<string>();
  /**
   * 正在第一次拉起、还没登记的会话：Claude Code 启动途中（握手回复之前）就连本会话 MCP，这时也要认得出它的密钥，
   * 否则第一次连接 401、它转去找 OAuth 再碰 403，整场会话都没有本会话 MCP（11/06 真跑 haiku 时碰到）。
   */
  private readonly launching = new Map<string, SessionRecord>();
  /** 上次报给云端的排队位置（位置变了才重报）。 */
  private readonly sentPosition = new Map<string, number>();
  private queueSeq = 0;
  /** 读回上次的会话时（本机程序还没开始监听）和关机时不从队里接；启动好后由 app 调 pump。 */
  private holdQueue = true;
  /** 验收员交完结论、本机让它退出的会话（退出时记「验收完了」）。 */
  private readonly finished = new Set<string>();
  /** 等验收交代时最近一次告诉网页的原因（变了才再说）。 */
  private readonly waitNotes = new Map<string, string>();
  private pulling: Promise<void> | null = null;
  private pullAgain = false;
  private briefTimer: NodeJS.Timeout | null = null;
  private readonly dir: string;

  constructor(private readonly d: SessionDeps) {
    this.dir = join(d.dataDir, "sessions");
    mkdirSync(this.dir, { recursive: true });
    for (const id of readdirSync(this.dir)) {
      const rec = readJson<SessionRecord | null>(join(this.dir, id, "session.json"), null);
      if (!rec) continue;
      rec.outputs ??= [];
      Reflect.deleteProperty(rec, "handedBack"); // 旧版本记录里的字段，交回已不按它算
      rec.versionNumber ??= 0;
      rec.lastVersion ??= null;
      rec.role ??= null;
      rec.critics ??= [];
      rec.queuedMessage ??= null;
      rec.queueOrder ??= 0;
      rec.parentId ??= null;
      rec.briefPending ??= false;
      rec.criteria ??= [];
      rec.failStreak ??= 0;
      rec.submitted ??= 0;
      rec.nudged ??= false;
      this.queueSeq = Math.max(this.queueSeq, rec.queueOrder);
      this.records.set(rec.id, rec);
      // 本机程序重启时，上次的进程都已不在。排着的照原样排着；刚从队里拉起、还没开始的放回队里（位置不变）。
      if (rec.status === "starting" && rec.queuedMessage !== null) this.setStatus(rec, "queued", { reason: "本机程序重启，照原样排着" });
      else if (LIVE.includes(rec.status)) this.setStatus(rec, "exited", { reason: "本机程序重启，会话已停；再发一句话会接着做" });
    }
    this.holdQueue = false;
  }

  private save(rec: SessionRecord) {
    rec.updatedAt = nowIso();
    writeJsonAtomic(join(this.dir, rec.id, "session.json"), rec);
  }

  private summary(rec: SessionRecord): TLocalSessionSummary {
    const {
      mcpSecret: _s, syncSeq: _q, outputs: _o, versionNumber: _v, lastVersion: _l, role: _r, critics: _c, queuedMessage: _m, queueOrder: _n,
      parentId: _p, briefPending: _b, criteria: _cr, failStreak: _f, submitted: _sb, nudged: _nd, ...rest
    } = rec;
    return { ...rest, lastSeq: this.d.log.lastSeq(rec.id), pendingPermissions: this.pending.get(rec.id)?.size ?? 0, queuePosition: this.queuePosition(rec) };
  }

  list(): TLocalSessionSummary[] {
    return [...this.records.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((r) => this.summary(r));
  }

  get(id: string): { session: TLocalSessionSummary; pendingPermissions: TLocalPermissionRequestView[] } {
    const rec = this.must(id);
    return { session: this.summary(rec), pendingPermissions: [...(this.pending.get(id)?.values() ?? [])] };
  }

  /** 本会话 MCP 按卡或专题给不同的工具。 */
  kindOf(id: string): TLocalSessionKind {
    const rec = this.records.get(id) ?? this.launching.get(id);
    if (!rec) throw new SessionError("not_found", "没有这个会话");
    return rec.subject.kind;
  }

  /** 排队时是第几个（验收员、规划员排前面，同一档先来先跑）；没在排队为 null。 */
  private queuePosition(rec: SessionRecord): number | null {
    if (rec.status !== "queued") return null;
    return this.queue().indexOf(rec) + 1;
  }

  private queue(): SessionRecord[] {
    return [...this.records.values()].filter((r) => r.status === "queued")
      .sort((a, b) => PRIORITY[a.subject.kind] - PRIORITY[b.subject.kind] || a.queueOrder - b.queueOrder);
  }

  /** 排着、而且能开始的（等验收交代的验收员先跳过）。 */
  private ready(): SessionRecord[] {
    return this.queue().filter((r) => !r.briefPending);
  }

  private max(): number {
    return this.d.maxConcurrent?.() ?? 3;
  }

  /** 资源栏的「本机 ▮▮▯」。 */
  slots(): TLocalSlots {
    return { max: this.max(), running: this.activeCount(), queued: this.queue().length };
  }

  /** 占着位置的会话数（含正在第一次拉起、还没登记的）。 */
  activeCount(): number {
    return [...this.records.values()].filter((r) => OCCUPYING.includes(r.status)).length + this.launching.size;
  }

  /**
   * 有空位就从队头接上，直到占满或队空（暂停、关机时不接）。先改成 starting 再拉起，所以同一轮里不会多接。
   * 会话让出位置（一轮做完、结束、失败、排队时取消）、调大上限、托盘恢复、本机程序启动后都会调它。
   */
  pump(): void {
    if (this.holdQueue || this.d.paused?.()) return;
    for (let next = this.ready()[0]; next && this.activeCount() < this.max(); next = this.ready()[0]) {
      this.setStatus(next, "starting");
      void this.launchQueued(next);
    }
  }

  private async launchQueued(rec: SessionRecord): Promise<void> {
    const p = this.startRun(rec, false);
    this.starting.set(rec.id, p);
    try {
      await p;
    } catch (e) {
      const cancelled = e instanceof SessionError && e.message === CANCELLED_WHILE_STARTING;
      this.setStatus(rec, cancelled ? "exited" : "failed", { reason: cancelled ? "已强停" : `没开起来：${e instanceof Error ? e.message : String(e)}` });
      return;
    } finally {
      this.starting.delete(rec.id);
    }
    const text = rec.queuedMessage ?? "";
    rec.queuedMessage = null;
    this.emit(rec, { type: "user_message", text, source: "initial" });
    this.runs.get(rec.id)!.send(text);
    this.setStatus(rec, "running");
  }

  /** 队里还在排的，位置变了就给云端重报一条 queued。 */
  private syncQueuePositions() {
    this.queue().forEach((rec, i) => {
      if (this.sentPosition.get(rec.id) !== i + 1) this.syncStatus(rec);
    });
  }

  private syncStatus(rec: SessionRecord) {
    const queuePosition = this.queuePosition(rec);
    if (queuePosition === null) this.sentPosition.delete(rec.id);
    else this.sentPosition.set(rec.id, queuePosition);
    this.sync(rec, { type: "status", data: { status: rec.status, title: rec.title, agent: rec.agent, modelLabel: rec.modelLabel, ...(queuePosition ? { queuePosition } : {}) } });
  }

  private must(id: string): SessionRecord {
    const rec = this.records.get(id);
    if (!rec) throw new SessionError("not_found", "没有这个会话");
    return rec;
  }

  private emit(rec: SessionRecord, body: EventBody) {
    return this.d.log.append(rec.id, body);
  }

  /** 排进发件箱，返回这一条的幂等键。 */
  private sync(rec: SessionRecord, item: Omit<TLocalSyncItem, "key" | "sessionId" | "subject" | "occurredAt">): string {
    rec.syncSeq += 1;
    this.save(rec);
    const key = `${this.d.deviceId}:${rec.id}:${rec.syncSeq}`;
    this.d.outbox.enqueue({ key, sessionId: rec.id, subject: rec.subject, occurredAt: nowIso(), ...item } as TLocalSyncItem);
    return key;
  }

  private setStatus(rec: SessionRecord, status: TLocalSessionStatus, extra: { exitCode?: number | null; reason?: string } = {}) {
    if (rec.status === status && !extra.reason) return;
    const left = rec.status === "queued" && status !== "queued";
    rec.status = status;
    this.save(rec);
    this.emit(rec, { type: "status", status, ...extra });
    this.syncStatus(rec);
    if (left) this.syncQueuePositions();
    this.d.onChange?.();
    if (!OCCUPYING.includes(status)) this.pump();
  }

  async create(req: TLocalCreateSessionRequest, defaults: { includePersonalConfig: boolean }): Promise<TLocalSessionSummary> {
    const { subject } = req;
    if (subject.kind === "verify") throw new SessionError("validation", "验收员由本机在执行方交回后自己起，网页不能开");
    if (subject.handbackKey) throw new SessionError("validation", "handbackKey 由本机填");
    if (subject.kind === "card" && !subject.cardId) throw new SessionError("validation", "卡的会话要带 cardId");
    if (subject.kind === "topic" && !subject.topicId) throw new SessionError("validation", "专题的会话要带 topicId");
    if (subject.kind === "plan" && !subject.taskId) throw new SessionError("validation", "规划员的会话要带 taskId");
    if (subject.kind !== "topic" && req.critics?.length) throw new SessionError("validation", "挑刺岗位只给专题的评审会用");
    let cwd: string;
    if (req.cwd) {
      cwd = resolve(req.cwd);
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new SessionError("validation", "工作目录不存在");
      // 按磁盘上的实际大小写：Claude Code 排除本人全局记忆（claudeMdExcludes）是按路径大小写匹配的。
      cwd = realpathSync.native(cwd);
      if (!this.d.folders.isAllowed(cwd)) throw new SessionError("folder_not_allowed", "这个目录不在本人允许的文件夹里");
    } else if (subject.kind === "topic") {
      cwd = this.d.folders.ownDir("topics", subject.topicId!);
    } else if (subject.kind === "plan") {
      cwd = this.d.folders.ownDir("plans", subject.taskId!);
    } else {
      throw new SessionError("validation", "卡的会话要指定工作目录");
    }
    const model = await this.d.models.resolve(req.modelProfileId);
    if (!model) throw new SessionError("validation", "没有这个模型配置");
    if (model.source === "gateway" && !model.apiKey) throw new SessionError("validation", `「${model.label}」还没填钥匙`);
    const agent = req.agent ?? "claude-code";
    if (this.d.paused?.()) throw new SessionError("conflict", "本机程序已暂停，先在托盘里恢复");
    const now = nowIso();
    const rec: SessionRecord = {
      id: randomUUID(), subject, title: req.title, agent, modelProfileId: model.profileId, modelLabel: model.label, cwd,
      includePersonalConfig: req.includePersonalConfig ?? defaults.includePersonalConfig,
      createdAt: now, updatedAt: now, status: "starting", usage: zeroUsage(), syncSeq: 0, mcpSecret: randomBytes(24).toString("hex"),
      outputs: [], versionNumber: subject.kind === "topic" ? req.versionBase ?? 0 : 0, lastVersion: null,
      role: req.role ?? null, critics: req.critics ?? [], queuedMessage: null, queueOrder: 0,
      parentId: null, briefPending: false, criteria: [], failStreak: 0, submitted: 0, nudged: false,
    };
    // 满了（或前面还有人在排）就进队，先来先跑；有空位时 pump 接上。
    if (this.ready().length || this.activeCount() >= this.max()) {
      rec.queuedMessage = req.firstMessage;
      rec.queueOrder = ++this.queueSeq;
      this.records.set(rec.id, rec);
      this.setStatus(rec, "queued");
      return this.summary(rec);
    }
    // 起不来（没装、太旧、没实现）直接抛给调用方，不留记录
    this.launching.set(rec.id, rec);
    try {
      await this.startRun(rec, false);
      this.records.set(rec.id, rec);
    } finally {
      this.launching.delete(rec.id);
    }
    this.save(rec);
    this.emit(rec, { type: "status", status: "starting" });
    this.emit(rec, { type: "user_message", text: req.firstMessage, source: "initial" });
    this.runs.get(rec.id)!.send(req.firstMessage);
    this.setStatus(rec, "running");
    return this.summary(rec);
  }

  /**
   * 本会话的 MCP 配置文件：本会话 MCP（交产出物、证据、交回）；关联了云端时再挂天枢 MCP（/mcp/me，搜索等）。
   * 密钥和令牌不写进文件也不进命令行：文件里写 ${变量名}，Claude Code 启动时从子进程环境变量展开（11/06 实测）。
   */
  private async writeMcpConfig(rec: SessionRecord, tools: { cloud: boolean; search: boolean }): Promise<{ path: string; env: Record<string, string>; allowedTools: string[] }> {
    const env: Record<string, string> = { TIANSHU_SESSION_SECRET: rec.mcpSecret };
    const local = `http://127.0.0.1:${this.d.port()}/internal/sessions/${rec.id}`;
    const secretHeader = { "x-tianshu-session-secret": "${TIANSHU_SESSION_SECRET}" };
    const servers: Record<string, unknown> = {
      [SESSION_MCP_NAME]: {
        type: "http",
        url: `${local}/mcp`,
        headers: secretHeader,
      },
    };
    const allowedTools = sessionToolNames(rec.subject.kind);
    if (tools.cloud) {
      // 天枢 MCP 经本机程序转发（/internal/sessions/:id/cloud-mcp），云端令牌留在本机程序里，会话和它跑的命令都拿不到。
      servers[CLOUD_MCP_NAME] = { type: "http", url: `${local}/cloud-mcp`, headers: secretHeader };
      allowedTools.push(`mcp__${CLOUD_MCP_NAME}__${CLOUD_MCP_CONTEXT_TOOL}`);
      if (tools.search) allowedTools.push(`mcp__${CLOUD_MCP_NAME}__${CLOUD_MCP_SEARCH_TOOL}`);
    }
    const path = join(this.dir, rec.id, "mcp.json");
    writeJsonAtomic(path, { mcpServers: servers });
    return { path, env, allowedTools };
  }

  private async startRun(rec: SessionRecord, resume: boolean): Promise<AgentRun> {
    const adapter = this.d.adapters[rec.agent];
    if (!adapter) throw new SessionError("validation", `不支持的执行方 ${rec.agent}`);
    if (this.d.paused?.()) throw new SessionError("conflict", "本机程序已暂停，先在托盘里恢复");
    // 续接时也重查：允许的文件夹可能已被本人移除。
    if (!this.d.folders.isAllowed(rec.cwd)) throw new SessionError("folder_not_allowed", "这个会话的目录已不在允许的文件夹里");
    const model = await this.d.models.resolve(rec.modelProfileId);
    if (!model) throw new SessionError("validation", "这个会话用的模型配置已被删除");
    mkdirSync(join(this.dir, rec.id), { recursive: true });
    // 每次拉起换一个本会话密钥，进程退出即作废：会话里跑的命令就算读到它，也只在这一次进程活着时有用。
    rec.mcpSecret = randomBytes(24).toString("hex");
    if (this.records.has(rec.id)) this.save(rec);
    // 岗位的工具名单决定挂什么、给什么（ADR 0037）；没配岗位时照旧全给。
    const has = (t: TLocalRole["tools"][number]) => !rec.role || rec.role.tools.includes(t);
    const linked = Boolean(await this.d.cloudLinked?.());
    const tools = { cloud: linked && (has("tianshu") || has("web_search")), search: has("web_search") };
    const mcp = await this.writeMcpConfig(rec, tools);
    // 带个人配置时本人自己的技能照常加载，不另挂插件；干净会话挂一个只在本会话生效的插件。
    const skillsDir = rec.role?.tools.includes("feishu") ? this.d.skillsDir : undefined;
    const plugin = skillsDir && !rec.includePersonalConfig ? ensureFeishuPlugin(this.d.dataDir, skillsDir) : null;
    const feishu = plugin ? "plugin" : skillsDir && rec.includePersonalConfig && larkSkills(skillsDir).length ? "personal" : null;
    // 工作规矩、岗位、挑刺子 agent 写在本机程序的数据目录，经参数交给 Claude Code，不往本人的仓库写文件。
    const dir = join(this.dir, rec.id);
    const systemPromptPath = join(dir, "system.md");
    writeFileSync(systemPromptPath, systemPrompt(rec.subject.kind, rec.role, rec.critics, feishu));
    let agentsPath: string | null = null;
    if (rec.subject.kind === "topic" && rec.critics.length) {
      agentsPath = join(dir, "agents.json");
      // 主岗位名单里没有 web_search 时整场都禁了它（disallowedTools），挑刺子 agent 也就不给。
      writeJsonAtomic(agentsPath, criticAgents(rec.critics, tools.cloud && tools.search ? `mcp__${CLOUD_MCP_NAME}__${CLOUD_MCP_SEARCH_TOOL}` : null));
    }
    const disallowedTools = [
      ...(has("web_search") ? [] : ["WebSearch", `mcp__${CLOUD_MCP_NAME}__${CLOUD_MCP_SEARCH_TOOL}`]),
      ...(READ_ONLY_KINDS.includes(rec.subject.kind) ? WRITE_TOOLS : []),
    ];
    const run = await adapter.start({
      sessionId: rec.id, cwd: rec.cwd, resume, model, includePersonalConfig: rec.includePersonalConfig,
      mcpConfigPath: mcp.path, mcpEnv: mcp.env, allowedTools: mcp.allowedTools,
      disallowedTools,
      systemPromptPath, agentsPath, pluginDirs: plugin ? [plugin] : [],
      // 每次现查：会话途中本人移除了文件夹，之后的请求（包括工作目录里的）就算越界。
      allowedRoots: () => [...(this.d.folders.isAllowed(rec.cwd) ? [rec.cwd] : []), ...this.d.folders.list().map((f) => f.path)],
    });
    if (this.cancelled.delete(rec.id)) {
      await run.kill();
      throw new SessionError("conflict", CANCELLED_WHILE_STARTING);
    }
    this.runs.set(rec.id, run);
    this.pending.set(rec.id, new Map());
    run.onEvent((e) => this.onAgentEvent(rec, e));
    run.onExit((code) => this.onExit(rec, run, code));
    return run;
  }

  private onAgentEvent(rec: SessionRecord, e: EventBody) {
    this.emit(rec, e);
    switch (e.type) {
      case "permission_request":
        this.pending.get(rec.id)?.set(e.request.requestId, e.request);
        this.setStatus(rec, "waiting_permission");
        break;
      case "permission_resolved":
        this.pending.get(rec.id)?.delete(e.requestId);
        if (!this.pending.get(rec.id)?.size && rec.status === "waiting_permission") this.setStatus(rec, "running");
        break;
      case "plan":
        this.sync(rec, { type: "plan", data: { entries: e.entries.slice(0, 100), progress: e.progress } });
        break;
      case "turn_end": {
        const u = rec.usage;
        rec.usage = {
          inputTokens: u.inputTokens + e.usage.inputTokens, outputTokens: u.outputTokens + e.usage.outputTokens,
          cacheReadTokens: u.cacheReadTokens + e.usage.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens + e.usage.cacheWriteTokens,
          costUsd: e.usage.costUsd === null || u.costUsd === null ? null : u.costUsd + e.usage.costUsd,
        };
        this.sync(rec, { type: "cost", data: { modelLabel: rec.modelLabel, usage: e.usage } });
        for (const id of this.pending.get(rec.id)?.keys() ?? []) {
          this.emit(rec, { type: "permission_resolved", requestId: id, decision: "deny", message: "这一轮已结束", allowForSession: false });
        }
        this.pending.get(rec.id)?.clear();
        const run = this.runs.get(rec.id);
        if (rec.subject.kind === "verify" && !rec.submitted && !rec.nudged && !e.isError && run) {
          // 验收员一轮做完却没交结论：提醒一次，状态保持进行中（不让出位置，免得刚让出去又占回来）。
          rec.nudged = true;
          this.save(rec);
          this.emit(rec, { type: "notice", level: "info", code: "verify_nudge", text: VERIFY_NUDGE });
          run.send(VERIFY_NUDGE);
          break;
        }
        this.setStatus(rec, "idle");
        if (rec.subject.kind === "verify" && rec.submitted && run) {
          // 交完结论就收工：让 Claude Code 自己退出，不留空闲进程。本人想问它，说一句会续上。
          this.finished.add(rec.id);
          run.close();
        }
        break;
      }
      default:
        break;
    }
  }

  private onExit(rec: SessionRecord, run: AgentRun, code: number | null) {
    if (this.runs.get(rec.id) !== run) return;
    this.runs.delete(rec.id);
    for (const id of this.pending.get(rec.id)?.keys() ?? []) {
      this.emit(rec, { type: "permission_resolved", requestId: id, decision: "deny", message: "进程已结束", allowForSession: false });
    }
    this.pending.delete(rec.id);
    const killed = this.killed.delete(rec.id);
    const finished = this.finished.delete(rec.id);
    rec.mcpSecret = "";
    this.setStatus(rec, killed || finished || code === 0 ? "exited" : "failed", { exitCode: code, reason: killed ? "已强停" : finished ? "验收完了" : undefined });
    this.d.log.evict(rec.id);
  }

  async sendMessage(id: string, req: TLocalSendMessageRequest): Promise<TLocalSendMessageResponse> {
    const rec = this.must(id);
    if (rec.status === "queued") throw new SessionError("conflict", "还在等空位，开始后再说");
    if (rec.queuedMessage !== null && !this.starting.has(id)) throw new SessionError("conflict", "这件还没开始过（排队时取消了或没开起来），要做就重新开工");
    let text: string;
    if (req.kind === "review") {
      if (rec.subject.kind !== "topic" || !rec.critics.length) throw new SessionError("validation", "评审会只给开工时带了挑刺岗位的专题用");
      text = reviewMessage(rec.critics, rec.lastVersion, req.text);
    } else {
      if (!req.text) throw new SessionError("validation", "说一句要有内容");
      text = req.text;
    }
    let run = this.runs.get(id);
    let resumed = false;
    if (!run) {
      const inflight = this.starting.get(id);
      if (inflight) run = await inflight;
      else {
        const p = this.startRun(rec, true);
        this.starting.set(id, p);
        try { run = await p; } finally { this.starting.delete(id); }
        resumed = true;
      }
    }
    const delivery: TLocalSendMessageResponse["delivery"] = resumed ? "resumed" : rec.status === "idle" ? "new_turn" : "next_step";
    this.emit(rec, { type: "user_message", text, source: "web" });
    run.send(text);
    if (delivery === "next_step") this.emit(rec, { type: "notice", level: "info", code: "interjection_next_step", text: "已送达，会在它下一步之前生效" });
    else this.setStatus(rec, "running");
    return { delivery };
  }

  /** 还在排的：停下、强停都是取消，让它出队（不留进程，不能再续）。 */
  private cancelQueued(rec: SessionRecord): boolean {
    if (rec.status !== "queued") return false;
    this.setStatus(rec, "exited", { reason: "排队时取消了，没开始" });
    return true;
  }

  async interrupt(id: string): Promise<TLocalSessionSummary> {
    const rec = this.must(id);
    if (this.cancelQueued(rec)) return this.summary(rec);
    const run = this.runs.get(id);
    if (run && rec.status !== "idle") await run.interrupt();
    return this.summary(rec);
  }

  decide(id: string, requestId: string, d: { decision: "allow" | "deny"; message?: string; allowForSession?: boolean }): TLocalSessionSummary {
    const rec = this.must(id);
    const run = this.runs.get(id);
    const view = this.pending.get(id)?.get(requestId);
    if (!run || !view) throw new SessionError("conflict", "这条权限请求已经处理过或已失效");
    const allowForSession = d.decision === "allow" && Boolean(d.allowForSession) && view.canAllowForSession;
    run.respondPermission(requestId, { allow: d.decision === "allow", message: d.message, allowForSession });
    this.onAgentEvent(rec, { type: "permission_resolved", requestId, decision: d.decision, ...(d.message ? { message: d.message } : {}), allowForSession });
    return this.summary(rec);
  }

  async kill(id: string): Promise<TLocalSessionSummary> {
    const rec = this.must(id);
    if (this.cancelQueued(rec)) return this.summary(rec);
    const run = this.runs.get(id);
    if (run) {
      this.killed.add(id);
      await run.kill();
    } else if (this.starting.has(id)) {
      this.cancelled.add(id);
      await this.starting.get(id)!.catch(() => undefined);
    }
    return this.summary(rec);
  }

  /** 托盘「暂停全部」：所有进行中的会话都停下（会话保留）。 */
  async interruptAll(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((id) => this.interrupt(id).catch(() => undefined)));
  }

  async shutdown(): Promise<void> {
    // 关机时进程一个个退出会让出位置，这时不能再从队里接新的：排着的留到下次启动。
    this.holdQueue = true;
    if (this.briefTimer) clearTimeout(this.briefTimer);
    this.briefTimer = null;
    await Promise.all([...this.runs.keys()].map((id) => this.kill(id).catch(() => undefined)));
  }

  // ───────── 本会话 MCP 回报（产出物、证据、交回） ─────────

  verifySecret(id: string, secret: string | undefined): boolean {
    const rec = this.records.get(id) ?? this.launching.get(id);
    if (!rec || !secret || !rec.mcpSecret) return false;
    const a = Buffer.from(secret);
    const b = Buffer.from(rec.mcpSecret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  addArtifact(id: string, input: { path: string; title?: string }): string {
    const rec = this.must(id);
    const file = resolve(rec.cwd, input.path);
    if (!isInside(rec.cwd, file)) throw new SessionError("folder_not_allowed", "产出物必须在本会话的工作目录里");
    const ext = extname(file).toLowerCase();
    const mimeType = ARTIFACT_TYPES[ext];
    if (!mimeType) throw new SessionError("validation", `不支持的产出物类型 ${ext || "（无扩展名）"}，只收 md、html、pdf、docx、txt`);
    if (!existsSync(file) || !statSync(file).isFile()) throw new SessionError("not_found", "文件不存在");
    const size = statSync(file).size;
    if (size > MAX_ARTIFACT_BYTES) throw new SessionError("validation", "产出物超过 10 MB");
    const content = readFileSync(file);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const fileName = basename(file).slice(-200);
    // 同名再交是同一个产出物的新一版。
    const artifactId = createHash("sha256").update(`${rec.id}:${fileName}`).digest("hex").slice(0, 24);
    const title = (input.title?.trim() || fileName).slice(0, 200);
    this.emit(rec, { type: "artifact", artifactId, title, fileName, size, sha256 });
    const key = this.sync(rec, { type: "artifact", data: { artifactId, title, fileName, mimeType, size, sha256, contentBase64: content.toString("base64") } });
    const ref = this.remember(rec, "A", key, title, artifactId);
    return `已交：${title}（${Math.ceil(size / 1024)} KB），编号 ${ref}`;
  }

  addEvidence(id: string, input: { kind: "note" | "log" | "link" | "diff_summary"; title: string; text?: string; url?: string }): string {
    const rec = this.must(id);
    const title = input.title.trim().slice(0, 200);
    if (!title) throw new SessionError("validation", "证据要有标题");
    if (input.url !== undefined && (!/^https?:\/\//.test(input.url) || input.url.length > 2000)) throw new SessionError("validation", "链接只收 2000 字以内的 http(s) 地址");
    const key = this.sync(rec, { type: "evidence", data: { kind: input.kind, title, ...(input.text ? { text: input.text.slice(0, 8000) } : {}), ...(input.url ? { url: input.url } : {}) } });
    const ref = this.remember(rec, "E", key, title);
    this.emit(rec, { type: "notice", level: "info", code: "evidence_added", text: `交了一条证据：${title.slice(0, 80)}` });
    return `已记下这条证据，编号 ${ref}`;
  }

  private remember(rec: SessionRecord, prefix: "A" | "E", key: string, title: string, artifactId?: string): string {
    const ref = `${prefix}${rec.outputs.filter((o) => o.ref.startsWith(prefix)).length + 1}`;
    rec.outputs.push({ ref, key, title, ...(artifactId ? { artifactId } : {}) });
    this.save(rec);
    return ref;
  }

  /**
   * 交回：outputs 是点名的编号（A1、E1）；不点名就是本会话交过的全部，同一个文件交过几次只算最新一版。
   * 验收没过、改完再交回时，没改的产出也照样在里面（原来只算上一次交回以后的，会漏掉）。
   */
  handBack(id: string, input: { summary: string; criteria: TLocalHandbackCriterion[]; outputs?: string[] }): string {
    const rec = this.must(id);
    if (rec.subject.kind !== "card") throw new SessionError("validation", "专题不用交回，用 save_version 存版本");
    let picked: SessionRecord["outputs"];
    if (input.outputs) {
      const unknown = input.outputs.filter((r) => !rec.outputs.some((o) => o.ref === r.trim().toUpperCase()));
      if (unknown.length) throw new SessionError("validation", `没有这些编号：${unknown.join("、")}。可用的：${rec.outputs.map((o) => o.ref).join("、") || "（还没交过产出和证据）"}`);
      picked = rec.outputs.filter((o) => input.outputs!.some((r) => r.trim().toUpperCase() === o.ref));
    } else {
      const latest = new Map(rec.outputs.filter((o) => o.artifactId).map((o) => [o.artifactId!, o.ref]));
      picked = rec.outputs.filter((o) => !o.artifactId || latest.get(o.artifactId) === o.ref);
    }
    const summary = input.summary.slice(0, 4000);
    const criteria = input.criteria.slice(0, 50);
    const outputKeys = picked.slice(0, 100).map((o) => o.key);
    this.emit(rec, { type: "handback", summary, criteria, outputKeys });
    const key = this.sync(rec, { type: "handback", data: { summary, criteria, outputKeys } });
    this.queueVerify(rec, key);
    return `已交回（用了 ${picked.map((o) => o.ref).join("、") || "0 份产出和证据"}），本机接着起验收员验收`;
  }

  // ───────── 验收员：交回后本机自己起（不经云端） ─────────

  /** 先排着；等交回被天枢收下、取到验收交代，再按验收员的岗位档位挑模型开始。 */
  private queueVerify(card: SessionRecord, handbackKey: string) {
    const now = nowIso();
    const rec: SessionRecord = {
      id: randomUUID(), subject: { kind: "verify", cardId: card.subject.cardId!, handbackKey }, title: `验收：${card.title}`.slice(0, 120),
      agent: card.agent, modelProfileId: card.modelProfileId, modelLabel: card.modelLabel, cwd: card.cwd, includePersonalConfig: false,
      createdAt: now, updatedAt: now, status: "queued", usage: zeroUsage(), syncSeq: 0, mcpSecret: "", outputs: [], versionNumber: 0, lastVersion: null,
      role: null, critics: [], queuedMessage: null, queueOrder: ++this.queueSeq,
      parentId: card.id, briefPending: true, criteria: [], failStreak: 0, submitted: 0, nudged: false,
    };
    this.records.set(rec.id, rec);
    this.setStatus(rec, "queued", { reason: "等交回送到天枢，取验收交代" });
    void this.pullBriefs();
  }

  /** 给等交代的验收员取交代：交回送到天枢以后、连上天枢时、本机程序启动后都会调；同时只跑一遍，跑着时又被叫就再跑一遍。 */
  pullBriefs(): Promise<void> {
    if (this.pulling) {
      this.pullAgain = true;
      return this.pulling;
    }
    this.pulling = (async () => {
      do {
        this.pullAgain = false;
        await this.pullOnce().catch(() => undefined);
      } while (this.pullAgain);
    })().finally(() => { this.pulling = null; });
    return this.pulling;
  }

  private async pullOnce(): Promise<void> {
    const fetchBrief = this.d.verifyBrief;
    if (!fetchBrief || this.holdQueue) return;
    for (const rec of this.queue().filter((r) => r.briefPending)) {
      const key = rec.subject.handbackKey!;
      if (this.d.outbox.has(key)) {
        this.waitNote(rec, (await this.d.cloudLinked?.()) ? "等交回送到天枢，再取验收交代" : "本机还没连上天枢，连上后开始验收");
        continue;
      }
      let got: VerifyBrief;
      try {
        got = await fetchBrief(key);
      } catch (e) {
        this.waitNote(rec, `取验收交代没成（${e instanceof Error ? e.message : String(e)}），稍后再试`);
        continue;
      }
      if (rec.status !== "queued" || !rec.briefPending) continue; // 等的时候被取消了
      if (got.kind === "not_linked") {
        this.waitNote(rec, "本机还没连上天枢，连上后开始验收");
        continue;
      }
      if (got.kind !== "ok") {
        rec.briefPending = false;
        this.waitNotes.delete(rec.id);
        if (got.kind === "gone") this.setStatus(rec, "failed", { reason: "天枢上没有这次交回（可能被拒收了），没法验收" });
        else this.setStatus(rec, "exited", { reason: "这次交回天枢上已经有结论，不用再验" });
        continue;
      }
      const { brief } = got;
      const model = await this.d.models.resolve(this.d.models.forTier(brief.role?.modelTier ?? "normal"));
      if (rec.status !== "queued" || !rec.briefPending) continue;
      // 交代、模型一次填好再标成能开始：中间不能有 await，免得别处的 pump 拿着空的第一句话、执行方的模型先开了它。
      Object.assign(rec, { briefPending: false, queuedMessage: brief.markdown, criteria: brief.criteria, failStreak: brief.failStreak, role: brief.role });
      if (model) Object.assign(rec, { modelProfileId: model.profileId, modelLabel: model.label });
      this.waitNotes.delete(rec.id);
      this.save(rec);
      this.syncStatus(rec);
      this.d.onChange?.();
    }
    this.pump();
    if (this.queue().some((r) => r.briefPending) && !this.briefTimer && !this.holdQueue) {
      this.briefTimer = setTimeout(() => { this.briefTimer = null; void this.pullBriefs(); }, BRIEF_RETRY_MS);
      this.briefTimer.unref?.();
    }
  }

  private waitNote(rec: SessionRecord, text: string) {
    if (this.waitNotes.get(rec.id) === text) return;
    this.waitNotes.set(rec.id, text);
    this.emit(rec, { type: "notice", level: "info", code: "verify_waiting", text });
  }

  /** 验收员交结论：每条完成标准判一次，经发件箱报给天枢；验收会话和被验的卡的会话里各记一条结论事件（只给网页显示；改法由云端写进那次交回后，网页按交回送回一次）。 */
  submitVerdict(id: string, input: { summary: string; criteria: unknown[]; beyondScope?: unknown }): string {
    const rec = this.must(id);
    if (rec.subject.kind !== "verify") throw new SessionError("validation", "只有验收员交结论");
    if (rec.submitted) throw new SessionError("conflict", "这次交回已经交过结论了，不能再交");
    const n = rec.criteria.length;
    const judged = input.criteria.map((c: any) => ({
      index: c?.index, verdict: c?.verdict, reason: String(c?.reason ?? "").trim(), evidence: textOrNull(c?.evidence), fix: textOrNull(c?.fix),
    })) as TLocalVerdictCriterion[];
    judged.sort((a, b) => a.index - b.index);
    const seen = judged.map((c) => c.index);
    const outside = seen.filter((i) => !Number.isInteger(i) || i < 1 || i > n);
    if (outside.length) throw new SessionError("validation", `没有第 ${outside.join("、")} 条（完成标准共 ${n} 条）`);
    const twice = seen.filter((i, k) => seen.indexOf(i) !== k);
    if (twice.length) throw new SessionError("validation", `第 ${[...new Set(twice)].join("、")} 条判了不止一次`);
    const missing = Array.from({ length: n }, (_, k) => k + 1).filter((i) => !seen.includes(i));
    if (missing.length) throw new SessionError("validation", `第 ${missing.join("、")} 条还没判（完成标准共 ${n} 条）`);
    const verdict: TLocalVerdict = {
      passed: judged.every((c) => c.verdict === "met"), summary: input.summary.trim(), criteria: judged,
      beyondScope: Array.isArray(input.beyondScope) ? input.beyondScope.map((s) => String(s).trim()).filter(Boolean) : [],
      modelLabel: rec.modelLabel, roleId: rec.role?.id ?? null, roleVersion: rec.role?.version ?? null,
    };
    const problem = schemaProblem(LocalVerdict, verdict);
    if (problem) throw new SessionError("validation", `结论不合格：${problem}`);
    rec.submitted = 1;
    this.sync(rec, { type: "verdict", data: verdict });
    const failStreak = verdict.passed ? 0 : rec.failStreak + 1;
    const blocked = failStreak >= 2;
    const event = {
      type: "verdict" as const, handbackKey: rec.subject.handbackKey!, passed: verdict.passed, summary: verdict.summary, criteria: judged,
      beyondScope: verdict.beyondScope, failStreak, blocked, returnText: verdict.passed ? null : returnText(rec.criteria, judged),
    };
    this.emit(rec, event);
    const card = rec.parentId ? this.records.get(rec.parentId) : undefined;
    if (card) this.emit(card, event);
    if (verdict.passed) return "结论已交：过了。";
    return blocked ? `结论已交：没过（连续第 ${failStreak} 次），停在受阻等本人。` : "结论已交：没过，改法会送回执行方。";
  }

  // ───────── 规划员 ─────────

  /** 规划员交计划和派活单草稿：改了再交是新的一次（revision +1），天枢以最新一次为准。 */
  proposePlan(id: string, input: { summary: string; steps?: unknown; risks?: unknown; cards: unknown[] }): string {
    const rec = this.must(id);
    if (rec.subject.kind !== "plan") throw new SessionError("validation", "只有规划员交计划");
    const list = (v: unknown) => (Array.isArray(v) ? v : []);
    const plan: TLocalCardPlan = {
      revision: rec.submitted + 1,
      summary: input.summary.trim(),
      steps: list(input.steps).map((s: any) => ({ title: String(s?.title ?? "").trim(), detail: textOrNull(s?.detail) })),
      risks: list(input.risks).map((r) => String(r).trim()).filter(Boolean),
      cards: input.cards.map((c: any) => ({
        title: String(c?.title ?? "").trim(), brief: String(c?.brief ?? "").trim(), doneDefinition: String(c?.doneDefinition ?? "").trim(),
        criterionIndex: Number.isInteger(c?.criterionIndex) && c.criterionIndex >= 1 ? c.criterionIndex : null,
        role: textOrNull(c?.role), modelTier: c?.modelTier, why: textOrNull(c?.why),
      })),
      modelLabel: rec.modelLabel, roleId: rec.role?.id ?? null, roleVersion: rec.role?.version ?? null,
    };
    const problem = schemaProblem(LocalCardPlan, plan);
    if (problem) throw new SessionError("validation", `计划不合格：${problem}`);
    rec.submitted = plan.revision;
    this.sync(rec, { type: "card_plan", data: plan });
    this.emit(rec, { type: "notice", level: "info", code: "card_plan", text: `交了第 ${plan.revision} 次计划：${plan.cards.length} 件` });
    return `已交第 ${plan.revision} 次计划（${plan.cards.length} 件）。本人会在网页上看派活单，要改会告诉你，改完再交一次。`;
  }

  /** 专题存一版：读工作目录里的 Markdown，号接着这个专题已有的往下编。 */
  saveVersion(id: string, input: { path: string; kind: TLocalTopicVersionKind; label?: string; note?: string }): string {
    const rec = this.must(id);
    if (rec.subject.kind !== "topic") throw new SessionError("validation", "只有专题存版本；卡做完用 hand_back 交回");
    const file = resolve(rec.cwd, input.path);
    if (!isInside(rec.cwd, file)) throw new SessionError("folder_not_allowed", "版本文件必须在本会话的工作目录里");
    if (![".md", ".markdown", ".txt"].includes(extname(file).toLowerCase())) throw new SessionError("validation", "版本要存成 Markdown（.md）");
    if (!existsSync(file) || !statSync(file).isFile()) throw new SessionError("not_found", "文件不存在");
    const body = readFileSync(file, "utf8");
    if (!body.trim()) throw new SessionError("validation", "文件是空的");
    if (body.length > MAX_VERSION_CHARS) throw new SessionError("validation", `一版最多 ${MAX_VERSION_CHARS} 字`);
    const label = input.label?.trim().slice(0, 20) || null;
    const note = input.note?.trim().slice(0, 200) || null;
    // 号从开工时的 versionBase 和本机同一个专题别的会话已存到的号里取大的往下编：交代里的 latestVersion 可能还没算上本机刚存、云端还没收到的版本。
    const topicId = rec.subject.topicId;
    const sameTopic = [...this.records.values()].filter((r) => r.subject.kind === "topic" && r.subject.topicId === topicId);
    rec.versionNumber = Math.max(rec.versionNumber, ...sameTopic.map((r) => r.versionNumber)) + 1;
    const number = rec.versionNumber;
    // 评审会读的「最近一版」是正文（提纲、草稿），不是上一次评审会存的分歧和建议。
    if (input.kind !== "review") rec.lastVersion = { number, path: input.path };
    this.emit(rec, { type: "version", number, kind: input.kind, label, note });
    this.sync(rec, { type: "topic_version", data: { number, kind: input.kind, label, note, body } });
    return `已存第 ${number} 版${label ? `（${label}）` : ""}`;
  }

  /** 专题第 number 版已存进飞书：报回地址。 */
  setFeishuUrl(id: string, input: { number: number; url: string }): string {
    const rec = this.must(id);
    if (rec.subject.kind !== "topic") throw new SessionError("validation", "只有专题的版本能存进飞书");
    if (input.number < 1 || input.number > rec.versionNumber) throw new SessionError("validation", `没有第 ${input.number} 版（现在最新是第 ${rec.versionNumber} 版）`);
    const url = input.url.trim();
    if (!/^https:\/\//.test(url) || url.length > 2000) throw new SessionError("validation", "飞书地址要是 https 开头");
    this.sync(rec, { type: "topic_version_feishu", data: { number: input.number, feishuUrl: url } });
    this.emit(rec, { type: "notice", level: "info", code: "version_saved_to_feishu", text: `第 ${input.number} 版已存进飞书` });
    return `已记下第 ${input.number} 版的飞书地址`;
  }
}
