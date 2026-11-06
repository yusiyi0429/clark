import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type {
  TLocalAgentKind, TLocalCreateSessionRequest, TLocalHandbackCriterion, TLocalPermissionRequestView, TLocalSendMessageResponse,
  TLocalSessionStatus, TLocalSessionSubject, TLocalSessionSummary, TLocalSyncItem, TLocalUsage,
} from "@warmap/contracts";
import { readJson, writeJsonAtomic, nowIso } from "./store.js";
import type { EventLog, EventBody } from "./eventLog.js";
import type { AgentAdapter, AgentRun } from "./agents/types.js";
import type { ModelProfiles } from "./models.js";
import { isInside, type Folders } from "./folders.js";
import type { Outbox } from "./outbox.js";
import { SESSION_MCP_NAME, SESSION_TOOL_NAMES } from "./sessionMcp.js";

/** 云端天枢 MCP 在会话里的名字：和本人在 Claude Code 里配的天枢 MCP 同名，工具名一致。 */
const CLOUD_MCP_NAME = "tianshu";
/**
 * 云端天枢 MCP 里预先放行的只读工具（不弹权限请求）。联网搜索改由天枢提供（/mcp/me 上的 web_search，博查，钥匙留在服务器），
 * 工具名等云端定了填进来。其余工具（写进展、建事项等）每次调用都要网页批准。
 */
const CLOUD_MCP_READONLY_TOOLS: string[] = [];

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
}

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
  onChange?: () => void;
}

const ARTIFACT_TYPES: Record<string, string> = {
  ".md": "text/markdown", ".markdown": "text/markdown", ".html": "text/html", ".htm": "text/html", ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".txt": "text/plain",
};
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const zeroUsage = (): TLocalUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
const LIVE: TLocalSessionStatus[] = ["starting", "running", "waiting_permission", "idle"];

export class SessionManager {
  private readonly records = new Map<string, SessionRecord>();
  private readonly runs = new Map<string, AgentRun>();
  private readonly pending = new Map<string, Map<string, TLocalPermissionRequestView>>();
  private readonly killed = new Set<string>();
  /** 正在拉起（含续接握手）的会话：同一个会话同时只许有一次启动。 */
  private readonly starting = new Map<string, Promise<AgentRun>>();
  /** 启动途中被强停的会话：启动一完成就杀掉。 */
  private readonly cancelled = new Set<string>();
  private readonly dir: string;

  constructor(private readonly d: SessionDeps) {
    this.dir = join(d.dataDir, "sessions");
    mkdirSync(this.dir, { recursive: true });
    for (const id of readdirSync(this.dir)) {
      const rec = readJson<SessionRecord | null>(join(this.dir, id, "session.json"), null);
      if (!rec) continue;
      this.records.set(rec.id, rec);
      // 本机程序重启时，上次的进程都已不在。
      if (LIVE.includes(rec.status)) this.setStatus(rec, "exited", { reason: "本机程序重启，会话已停；再发一句话会接着做" });
    }
  }

  private save(rec: SessionRecord) {
    rec.updatedAt = nowIso();
    writeJsonAtomic(join(this.dir, rec.id, "session.json"), rec);
  }

  private summary(rec: SessionRecord): TLocalSessionSummary {
    const { mcpSecret: _s, syncSeq: _q, ...rest } = rec;
    return { ...rest, lastSeq: this.d.log.lastSeq(rec.id), pendingPermissions: this.pending.get(rec.id)?.size ?? 0 };
  }

  list(): TLocalSessionSummary[] {
    return [...this.records.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((r) => this.summary(r));
  }

  get(id: string): { session: TLocalSessionSummary; pendingPermissions: TLocalPermissionRequestView[] } {
    const rec = this.must(id);
    return { session: this.summary(rec), pendingPermissions: [...(this.pending.get(id)?.values() ?? [])] };
  }

  activeCount(): number {
    return [...this.records.values()].filter((r) => r.status === "running" || r.status === "waiting_permission" || r.status === "starting").length;
  }

  private must(id: string): SessionRecord {
    const rec = this.records.get(id);
    if (!rec) throw new SessionError("not_found", "没有这个会话");
    return rec;
  }

  private emit(rec: SessionRecord, body: EventBody) {
    return this.d.log.append(rec.id, body);
  }

  private sync(rec: SessionRecord, item: Omit<TLocalSyncItem, "key" | "sessionId" | "subject" | "occurredAt">) {
    rec.syncSeq += 1;
    this.save(rec);
    this.d.outbox.enqueue({
      key: `${this.d.deviceId}:${rec.id}:${rec.syncSeq}`, sessionId: rec.id, subject: rec.subject, occurredAt: nowIso(), ...item,
    } as TLocalSyncItem);
  }

  private setStatus(rec: SessionRecord, status: TLocalSessionStatus, extra: { exitCode?: number | null; reason?: string } = {}) {
    if (rec.status === status && !extra.reason) return;
    rec.status = status;
    this.save(rec);
    this.emit(rec, { type: "status", status, ...extra });
    this.sync(rec, { type: "status", data: { status, title: rec.title, agent: rec.agent, modelLabel: rec.modelLabel } });
    this.d.onChange?.();
  }

  async create(req: TLocalCreateSessionRequest, defaults: { includePersonalConfig: boolean }): Promise<TLocalSessionSummary> {
    const { subject } = req;
    if (subject.kind === "card" && !subject.cardId) throw new SessionError("validation", "卡的会话要带 cardId");
    if (subject.kind === "topic" && !subject.topicId) throw new SessionError("validation", "专题的会话要带 topicId");
    let cwd: string;
    if (req.cwd) {
      cwd = resolve(req.cwd);
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new SessionError("validation", "工作目录不存在");
      // 按磁盘上的实际大小写：Claude Code 排除本人全局记忆（claudeMdExcludes）是按路径大小写匹配的。
      cwd = realpathSync.native(cwd);
      if (!this.d.folders.isAllowed(cwd)) throw new SessionError("folder_not_allowed", "这个目录不在本人允许的文件夹里");
    } else if (subject.kind === "topic") {
      cwd = this.d.folders.topicDir(subject.topicId!);
    } else {
      throw new SessionError("validation", "卡的会话要指定工作目录");
    }
    const model = await this.d.models.resolve(req.modelProfileId);
    if (!model) throw new SessionError("validation", "没有这个模型配置");
    if (model.source === "gateway" && !model.apiKey) throw new SessionError("validation", `「${model.label}」还没填钥匙`);
    const agent = req.agent ?? "claude-code";
    const now = nowIso();
    const rec: SessionRecord = {
      id: randomUUID(), subject, title: req.title, agent, modelProfileId: model.profileId, modelLabel: model.label, cwd,
      includePersonalConfig: req.includePersonalConfig ?? defaults.includePersonalConfig,
      createdAt: now, updatedAt: now, status: "starting", usage: zeroUsage(), syncSeq: 0, mcpSecret: randomBytes(24).toString("hex"),
    };
    await this.startRun(rec, false); // 起不来（没装、太旧、没实现）直接抛给调用方，不留记录
    this.records.set(rec.id, rec);
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
  private async writeMcpConfig(rec: SessionRecord): Promise<{ path: string; env: Record<string, string>; allowedTools: string[] }> {
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
    const allowedTools = [...SESSION_TOOL_NAMES];
    if (await this.d.cloudLinked?.()) {
      // 天枢 MCP 经本机程序转发（/internal/sessions/:id/cloud-mcp），云端令牌留在本机程序里，会话和它跑的命令都拿不到。
      servers[CLOUD_MCP_NAME] = { type: "http", url: `${local}/cloud-mcp`, headers: secretHeader };
      allowedTools.push(...CLOUD_MCP_READONLY_TOOLS.map((t) => `mcp__${CLOUD_MCP_NAME}__${t}`));
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
    const mcp = await this.writeMcpConfig(rec);
    const run = await adapter.start({
      sessionId: rec.id, cwd: rec.cwd, resume, model, includePersonalConfig: rec.includePersonalConfig,
      mcpConfigPath: mcp.path, mcpEnv: mcp.env, allowedTools: mcp.allowedTools,
      // 每次现查：会话途中本人移除了文件夹，之后的请求就算越界。
      isAllowedPath: (p) => isInside(rec.cwd, p) || this.d.folders.contains(p),
    });
    if (this.cancelled.delete(rec.id)) {
      await run.kill();
      throw new SessionError("conflict", "启动途中已被强停");
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
        this.sync(rec, { type: "plan", data: { entries: e.entries.slice(0, 100) } });
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
        this.setStatus(rec, "idle");
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
    rec.mcpSecret = "";
    this.setStatus(rec, killed || code === 0 ? "exited" : "failed", { exitCode: code, reason: killed ? "已强停" : undefined });
    this.d.log.evict(rec.id);
  }

  async sendMessage(id: string, text: string): Promise<TLocalSendMessageResponse> {
    const rec = this.must(id);
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

  async interrupt(id: string): Promise<TLocalSessionSummary> {
    const rec = this.must(id);
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
    await Promise.all([...this.runs.keys()].map((id) => this.kill(id).catch(() => undefined)));
  }

  // ───────── 本会话 MCP 回报（产出物、证据、交回） ─────────

  verifySecret(id: string, secret: string | undefined): boolean {
    const rec = this.records.get(id);
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
    this.sync(rec, { type: "artifact", data: { artifactId, title, fileName, mimeType, size, sha256, contentBase64: content.toString("base64") } });
    return `已交：${title}（${Math.ceil(size / 1024)} KB）`;
  }

  addEvidence(id: string, input: { kind: "note" | "log" | "link" | "diff_summary"; title: string; text?: string; url?: string }): string {
    const rec = this.must(id);
    const title = input.title.trim().slice(0, 200);
    if (!title) throw new SessionError("validation", "证据要有标题");
    if (input.url !== undefined && (!/^https?:\/\//.test(input.url) || input.url.length > 2000)) throw new SessionError("validation", "链接只收 2000 字以内的 http(s) 地址");
    this.sync(rec, { type: "evidence", data: { kind: input.kind, title, ...(input.text ? { text: input.text.slice(0, 8000) } : {}), ...(input.url ? { url: input.url } : {}) } });
    this.emit(rec, { type: "notice", level: "info", code: "evidence_added", text: `交了一条证据：${title.slice(0, 80)}` });
    return "已记下这条证据";
  }

  submitHandback(id: string, input: { summary: string; criteria: TLocalHandbackCriterion[] }): string {
    const rec = this.must(id);
    const summary = input.summary.slice(0, 4000);
    const criteria = input.criteria.slice(0, 50);
    this.emit(rec, { type: "handback", summary, criteria });
    this.sync(rec, { type: "handback", data: { summary, criteria } });
    return "已交回，等 Agent 验收";
  }
}
