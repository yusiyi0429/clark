import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  LocalCardPlan, LocalVerdict,
  type TLocalAgentKind, type TLocalCardPlan, type TLocalCreateSessionRequest, type TLocalHandbackCriterion, type TLocalPermissionRequestView, type TLocalRole,
  type TLocalSendMessageRequest, type TLocalSendMessageResponse, type TLocalSessionKind, type TLocalSessionStatus, type TLocalSlots, type TLocalSessionSubject,
  type TLocalSessionSummary, type TLocalSyncItem, type TLocalTopicVersionKind, type TLocalUsage, type TLocalVerdict, type TLocalVerdictCriterion,
  type TLocalWorkspace, type TLocalGitRef, type TLocalMergeResponse, type TLocalQuestionRequestView, type TLocalQuestionAnswerRequest,
  type TLocalBackgroundItem, type TLocalMergeHoldReason, type TLocalMergeSync, type TLocalModelTier, type TLocalHold, type TLocalMoney,
  type TLocalRun, type TLocalTaskBudgetView, type TLocalBudgetUpdateRequest, type TBudgetMode,
} from "@warmap/contracts";
import { readJson, writeJsonAtomic, nowIso } from "./store.js";
import type { EventLog, EventBody } from "./eventLog.js";
import type { AgentAdapter, AgentRun, TurnModels } from "./agents/types.js";
import type { QuotaTracker } from "./quota.js";
import type { GatewayPricing } from "./pricing.js";
import { Budgets, MULTI_AGENT_OFF_PERCENT, reworkRounds, runFor } from "./budget.js";
import type { ResolvedModel } from "./models.js";
import type { ModelProfiles } from "./models.js";
import { isInside, type Folders } from "./folders.js";
import type { Outbox } from "./outbox.js";
import { SESSION_MCP_NAME, sessionToolNames } from "./sessionMcp.js";
import { changesBrief, criticAgents, returnText, reviewMessage, systemPrompt } from "./rolePrompt.js";
import { addWorktree, branchName, cardDiff, changedFiles, commitAll, deleteBranch, git, mergeBranch, pruneRepo, removeWorktree, repoHead } from "./git.js";
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
/** 一个会话最多留几个后台任务（先丢最早的已结束的）。 */
const MAX_BACKGROUND = 50;
/** 卡在等前面的卡时排队的原因（ADR 0038）。 */
const WAITING_FOR_CARDS = "等前面的卡合回";
/** 额度恢复以后再等多久接着做（新首页设计 11.2：恢复时间到了再过 1 分钟）。 */
const HOLD_RESUME_AFTER_MS = 60_000;
/** 停着等额度、不知道几点恢复时，隔多久读一次额度再试。 */
const HOLD_POLL_MS = 5 * 60_000;
/** 额度恢复后发给执行方的一句（不是本人说的，网页上显示成一条提示）。 */
const HOLD_CONTINUE = "额度恢复了，接着把刚才没做完的做完。";
const HOLD_REASON = "订阅额度用完了，恢复后自动接着做";
/** 预算用完（新首页设计 11.4）：跑着的收到这一句，这一轮做完或过 3 分钟就停下。 */
const BUDGET_STOP = "这件 Task 的预算用完了：把手上这一步做完就停下，列出还没做完的，不要再开新的步骤。";
const BUDGET_STOP_GRACE_MS = 3 * 60_000;
const BUDGET_REASON = "预算用完了，等你加预算";
/** 预算加了：停着的往里说这一句接着做；收到「做完这一步就停」还没停的说后一句。 */
const BUDGET_CONTINUE = "预算加了，接着把刚才没做完的做完。";
const BUDGET_NO_STOP = "预算加了，不用停，接着做。";
/** 隔多久看一次时长有没有到预算（只算真在跑的）。 */
const BUDGET_TICK_MS = 30_000;
const BALANCE_REASON = "TokenHub 余额不足，充值后说一句接着做";
/** 计时的状态：真在跑（排队、等额度、等你批准、等你回复都不算）。 */
const RUNNING_TIME: TLocalSessionStatus[] = ["starting", "running"];
/** 不是 git 仓库的文件夹同时只做一张卡（ADR 0038），另一张在那儿跑时排队的原因。 */
const FOLDER_BUSY = "这个文件夹不是 git 仓库，同时只做一张卡，等另一张这一轮做完";

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
  /** 这件的档位（开工请求的 modelTier，没有就是岗位的）：订阅模型按它选模型和思考强度；null 按 normal。 */
  modelTier: TLocalModelTier | null;
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
  /** 卡：在自己的工作树还是文件夹里做（ADR 0038）；别的会话为 null。 */
  workspace: TLocalWorkspace | null;
  /** 验收员：验的是哪个提交（卡在工作树里做时，交回的那个提交）。 */
  commit: string | null;
  /** 卡：开工时说要等的卡（cardId）。都做完（合回，或文件夹里的卡验收过了）以前排着，没有工作树。 */
  after: string[];
  /** 验收员：结论过没过（还没交为 null）。 */
  passed: boolean | null;
  /** 这个会话里 Claude Code 自己开的后台任务（子 agent、后台命令），按开始的先后。 */
  background: TLocalBackgroundItem[];
  /** 停着等订阅额度恢复（新首页设计 11.2）：排着的不开始，做过的到点自动接着做。 */
  hold: TLocalHold | null;
  /** 什么时候开始停着等的（不知道几点恢复时，读过一次额度以后才接着做）。 */
  holdSince: string | null;
  /** 记在哪一份预算上（Budgets.key：一件 Task，或不挂 Task 的这个会话）；没带预算为 null。验收员随被验的卡。 */
  budgetKey: string | null;
  /** 这一段真在跑是从什么时候开始的（starting、running）；没在跑为 null。 */
  runSince: string | null;
  /** 最近一次拉起时定的跑法（摘要和状态条目带上）。 */
  run: TLocalRun | null;
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
  /** 验收过就合回（本机设置 autoMerge，默认开）。 */
  autoMerge?: () => boolean;
  /** 本人已装的技能目录（找 lark-* 飞书技能，岗位要飞书时挂给会话）。 */
  skillsDir?: string;
  /** 向天枢取一次交回的验收交代（没有就不自动验收）。 */
  verifyBrief?: (handbackKey: string) => Promise<VerifyBrief>;
  /** 本人订阅的额度：用完了订阅的会话停着等，跑着的卡报的额度变化记进去。 */
  quota?: QuotaTracker;
  /** 网关模型按 TokenHub 价目表算真钱。 */
  pricing?: GatewayPricing;
  /** 预算记账（新首页设计 11.3、11.4）。 */
  budgets?: Budgets;
  /** 测试用：额度恢复后再等多久、不知道几点恢复时多久再试；预算用完后等这一轮做完最多多久、多久看一次时长。 */
  holdTiming?: { resumeAfterMs?: number; pollMs?: number; budgetGraceMs?: number; budgetTickMs?: number };
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
  /** 这一轮交了计划的规划员：这一轮做完就收工。 */
  private readonly proposed = new Set<string>();
  /** 正在跑一轮的会话：Claude Code 每轮开头报 system/init，到这一轮的 turn_end 为止。一轮之外来的权限请求是后台子 agent 的。 */
  private readonly inTurn = new Set<string>();
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
  /** 在等本人回答的提问（会话 id → 提问），会话这时是 idle（等你回复）。 */
  private readonly questions = new Map<string, TLocalQuestionRequestView>();
  /** 前面的卡都做完、正在开工作树的卡（开好以前不能开始）。 */
  private readonly opening = new Set<string>();
  private pulling: Promise<void> | null = null;
  private pullAgain = false;
  private briefTimer: NodeJS.Timeout | null = null;
  private holdTimer: NodeJS.Timeout | null = null;
  /** 预算用完、收到「做完这一步就停」还没停下的会话：到点打断的定时器；sent 是那一句送出去没有（还在拉起的，开始后再送）。 */
  private readonly budgetStopping = new Map<string, { timer: NodeJS.Timeout; sent: boolean }>();
  private budgetTimer: NodeJS.Timeout | null = null;
  /** TokenHub 说余额不足的网关模型配置：排着的、新开的用它的先停着等，本人说一句才放开。 */
  private readonly balanceBlocked = new Set<string>();
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
      rec.modelTier ??= null;
      rec.critics ??= [];
      rec.queuedMessage ??= null;
      rec.queueOrder ??= 0;
      rec.parentId ??= null;
      rec.briefPending ??= false;
      rec.criteria ??= [];
      rec.failStreak ??= 0;
      rec.submitted ??= 0;
      rec.nudged ??= false;
      rec.workspace ??= null;
      rec.commit ??= null;
      rec.after ??= [];
      rec.passed ??= null;
      rec.background ??= [];
      rec.hold ??= null;
      rec.holdSince ??= null;
      rec.budgetKey ??= null;
      rec.run ??= null;
      rec.runSince = null; // 上次的进程已不在，正跑着的那一段算不准，不算
      this.queueSeq = Math.max(this.queueSeq, rec.queueOrder);
      this.records.set(rec.id, rec);
      // 上次没收尾的后台任务（本机程序没正常退出）：进程已不在，算被停了
      this.stopAllBackground(rec);
      // 本机程序重启时，上次的进程都已不在。排着的照原样排着；刚从队里拉起、还没开始的放回队里（位置不变）。
      if (rec.status === "starting" && rec.queuedMessage !== null) this.setStatus(rec, "queued", { reason: "本机程序重启，照原样排着" });
      else if (LIVE.includes(rec.status)) this.setStatus(rec, "exited", { reason: rec.hold ? HOLD_REASON : "本机程序重启，会话已停；再发一句话会接着做" });
    }
    this.holdQueue = false;
    this.scheduleHoldCheck(); // 上次停着等额度的，照原来的恢复时间接着等
    if (d.budgets) {
      // 时长到没到预算：只在有会话真在跑时才有变化
      this.budgetTimer = setInterval(() => {
        for (const key of new Set([...this.records.values()].filter((r) => r.runSince && r.budgetKey).map((r) => r.budgetKey!))) this.evaluateBudget(key);
      }, d.holdTiming?.budgetTickMs ?? BUDGET_TICK_MS);
      this.budgetTimer.unref?.();
    }
  }

  private save(rec: SessionRecord) {
    rec.updatedAt = nowIso();
    writeJsonAtomic(join(this.dir, rec.id, "session.json"), rec);
  }

  private summary(rec: SessionRecord): TLocalSessionSummary {
    const {
      mcpSecret: _s, syncSeq: _q, outputs: _o, versionNumber: _v, lastVersion: _l, role: _r, critics: _c, queuedMessage: _m, queueOrder: _n,
      parentId: _p, briefPending: _b, criteria: _cr, failStreak: _f, submitted: _sb, nudged: _nd, workspace, commit: _cm, after: _af, passed: _ps,
      background, hold, holdSince: _hs, modelTier: _mt, budgetKey: _bk, runSince: _rs, run, ...rest
    } = rec;
    const question = this.questions.get(rec.id);
    const waitingFor = this.waitingFor(rec);
    return {
      ...rest, lastSeq: this.d.log.lastSeq(rec.id), pendingPermissions: this.pending.get(rec.id)?.size ?? 0, queuePosition: this.queuePosition(rec),
      ...(workspace ? { workspace } : {}), ...(question ? { pendingQuestion: question } : {}), ...(waitingFor.length ? { waitingFor } : {}),
      ...(background.length ? { background } : {}), ...(hold ? { hold } : {}), ...(run ? { run } : {}),
    };
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

  /** 排着、而且能开始的（等验收交代的验收员、等前面的卡或工作树还没开好的卡、文件夹被另一张卡占着的卡、停着等额度的先跳过）。 */
  private ready(): SessionRecord[] {
    return this.queue().filter((r) => !r.hold && this.startable(r));
  }

  private startable(r: SessionRecord): boolean {
    return !r.briefPending && !(r.after.length && !r.workspace) && !this.folderBusy(r);
  }

  /** 排着的卡还在等的前面的卡（还没做完的那几张）。 */
  private waitingFor(rec: SessionRecord): string[] {
    if (rec.status !== "queued" || !rec.after.length || rec.workspace) return [];
    return rec.after.filter((id) => !this.cardDone(id));
  }

  /** 这张卡在这台本机上做完了：在工作树里做的合回了；在文件夹里做的（不是 git 仓库，没有合回）最近一次验收过了。 */
  private cardDone(cardId: string): boolean {
    const all = [...this.records.values()];
    return all.some((r) => {
      if (r.subject.kind !== "card" || r.subject.cardId !== cardId) return false;
      if (r.workspace?.kind === "worktree") return Boolean(r.workspace.mergedCommit);
      if (r.workspace?.kind !== "folder") return false;
      const last = all.filter((v) => v.parentId === r.id && v.passed !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
      return last?.passed === true;
    });
  }

  /**
   * 前面的卡做完了一张：还在等的卡重报一次（少了一张）；都做完的从基线最新的提交开工作树，开好了排着等空位（pump 接上）。
   * 合回成功、验收过了、本机程序启动后都会调。前面的卡取消了或一直没合回，就一直等，本人可以停掉它。
   */
  async releaseWaiting(): Promise<void> {
    for (const rec of this.queue().filter((r) => r.after.length && !r.workspace && !this.opening.has(r.id))) {
      if (this.waitingFor(rec).length) {
        this.syncStatus(rec);
        continue;
      }
      this.opening.add(rec.id);
      try {
        const place = await this.openWorkspace(rec.subject.cardId!, rec.title, rec.cwd);
        Object.assign(rec, { cwd: place.cwd, workspace: place.workspace });
        this.save(rec);
        if (rec.status !== "queued") { void this.releaseWorktree(rec); continue; } // 开的时候被取消了
        this.noteWorkspace(rec, place);
        this.syncStatus(rec);
        this.d.onChange?.();
      } catch (e) {
        this.setStatus(rec, "failed", { reason: `前面的卡都做完了，但没开起来：${e instanceof Error ? e.message : String(e)}` });
      } finally {
        this.opening.delete(rec.id);
      }
    }
    this.pump();
  }

  /** 不是 git 仓库的文件夹同时只做一张卡：另一张卡正在那儿跑（占着位置、正在拉起，或它开的后台任务还在跑）。 */
  private folderBusy(rec: SessionRecord): boolean {
    const ws = rec.workspace;
    if (ws?.kind !== "folder") return false;
    const same = (r: SessionRecord) => r !== rec && r.workspace?.kind === "folder" && r.workspace.folder === ws.folder;
    const busy = (r: SessionRecord) => OCCUPYING.includes(r.status) || r.background.some((b) => b.state === "running");
    return [...this.records.values()].some((r) => same(r) && busy(r)) || [...this.launching.values()].some(same);
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
    this.gateQueued();
    // 额度恢复了：做过的先接着做（它们本来就在做），排着的回到队里
    for (const rec of [...this.records.values()].filter((r) => this.holdDue(r)).sort((a, b) => Number(a.status === "queued") - Number(b.status === "queued"))) {
      if (rec.status !== "queued" && this.activeCount() >= this.max()) continue;
      this.resumeHeld(rec);
    }
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
      if (cancelled) void this.releaseWorktree(rec);
      return;
    } finally {
      this.starting.delete(rec.id);
    }
    const text = rec.queuedMessage ?? "";
    rec.queuedMessage = null;
    this.emit(rec, { type: "user_message", text, source: "initial" });
    const run = this.runs.get(rec.id)!;
    run.send(text);
    this.setStatus(rec, "running");
    this.sendBudgetStop(rec, run); // 拉起途中预算用完了
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
    const waitingFor = this.waitingFor(rec);
    this.sync(rec, { type: "status", data: {
      status: rec.status, title: rec.title, agent: rec.agent, modelLabel: rec.modelLabel, ...(queuePosition ? { queuePosition } : {}), ...(waitingFor.length ? { waitingFor } : {}),
      ...(rec.hold ? { hold: rec.hold } : {}), ...(rec.run ? { run: rec.run } : {}),
    } });
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
    this.countRunTime(rec, status);
    rec.status = status;
    this.save(rec);
    this.emit(rec, { type: "status", status, ...extra, ...(rec.hold ? { hold: rec.hold } : {}) });
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
    if (subject.kind !== "card" && req.after?.length) throw new SessionError("validation", "只有卡能等别的卡");
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
    // 要等前面的卡：先排着，等它们都做完再开工作树（从那时基线最新的提交开出来）
    const after = [...new Set(req.after ?? [])].filter((id) => id !== subject.cardId);
    const waiting = after.some((id) => !this.cardDone(id));
    const place = subject.kind === "card" && !waiting ? await this.openWorkspace(subject.cardId!, req.title, cwd) : null;
    const now = nowIso();
    const id = randomUUID();
    // 这件的预算（认领回执里带来的，以最新的为准）：先收下，加了预算的话停着等的这时就接着做
    const budgetKey = req.taskBudget ? Budgets.key(req.taskBudget.taskId, id) : null;
    if (budgetKey && req.taskBudget) this.applyBudget(budgetKey, { taskId: req.taskBudget.taskId, sessionId: req.taskBudget.taskId ? null : id }, req.taskBudget.budget);
    const rec: SessionRecord = {
      id, subject, title: req.title, agent, modelProfileId: model.profileId, modelLabel: model.label, cwd: place?.cwd ?? cwd,
      includePersonalConfig: req.includePersonalConfig ?? defaults.includePersonalConfig,
      createdAt: now, updatedAt: now, status: "starting", usage: zeroUsage(), syncSeq: 0, mcpSecret: randomBytes(24).toString("hex"),
      outputs: [], versionNumber: subject.kind === "topic" ? req.versionBase ?? 0 : 0, lastVersion: null,
      role: req.role ?? null, modelTier: req.modelTier ?? req.role?.modelTier ?? null, critics: req.critics ?? [], queuedMessage: null, queueOrder: 0,
      parentId: null, briefPending: false, criteria: [], failStreak: 0, submitted: 0, nudged: false,
      workspace: place?.workspace ?? null, commit: null, after: waiting ? after : [], passed: null, background: [], hold: null, holdSince: null,
      budgetKey, runSince: null, run: null,
    };
    // 满了（或前面还有人在排、在等前面的卡、文件夹被另一张卡占着、订阅额度用完了、预算用完了、余额不足）就进队，先来先跑；有空位时 pump 接上。
    const busy = this.folderBusy(rec);
    const limited = model.source === "subscription" && this.blocked() !== null;
    const gate = this.gateReason(rec);
    if (waiting || this.ready().length || this.activeCount() >= this.max() || busy || limited || gate) {
      rec.queuedMessage = req.firstMessage;
      rec.queueOrder = ++this.queueSeq;
      this.records.set(rec.id, rec);
      if (!waiting && gate) this.markHold(rec, gate);
      else if (limited && !waiting) this.markHold(rec);
      this.setStatus(rec, "queued", waiting ? { reason: WAITING_FOR_CARDS } : busy ? { reason: FOLDER_BUSY } : rec.hold ? { reason: this.holdReason(rec.hold) } : {});
      this.noteWorkspace(rec, place);
      return this.summary(rec);
    }
    // 起不来（没装、太旧、没实现）直接抛给调用方，不留记录，也不留刚开的工作树和分支
    this.launching.set(rec.id, rec);
    try {
      await this.startRun(rec, false);
      this.records.set(rec.id, rec);
    } catch (e) {
      if (place?.created && rec.workspace?.kind === "worktree") {
        await removeWorktree(rec.workspace.folder, rec.workspace.path).catch(() => undefined);
        await deleteBranch(rec.workspace.folder, rec.workspace.branch);
      }
      throw e;
    } finally {
      this.launching.delete(rec.id);
    }
    this.save(rec);
    this.emit(rec, { type: "status", status: "starting" });
    this.noteWorkspace(rec, place);
    this.emit(rec, { type: "user_message", text: req.firstMessage, source: "initial" });
    this.runs.get(rec.id)!.send(req.firstMessage);
    this.setStatus(rec, "running");
    return this.summary(rec);
  }

  /**
   * 卡在哪做（ADR 0038）：本人选的文件夹在 git 仓库里（在分支上、有提交）就在本机数据目录的 worktrees/<cardId> 开一个工作树和新分支，
   * 从主文件夹所在分支的最新提交开始；这张卡上一个会话留下的工作树还在就接着用。不是仓库就在文件夹里做（同一个文件夹同时一张）。
   */
  private async openWorkspace(cardId: string, title: string, folder: string): Promise<{ workspace: TLocalWorkspace; cwd: string; created: boolean; reused: boolean; dirty: boolean }> {
    const head = await repoHead(folder);
    if (!head) return { workspace: { kind: "folder", folder }, cwd: folder, created: false, reused: false, dirty: false };
    const path = this.d.folders.worktreeDir(cardId);
    const prior = [...this.records.values()].filter((r) => r.workspace?.kind === "worktree" && r.workspace.path === path)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (prior.some((r) => r.status === "queued" || LIVE.includes(r.status))) throw new SessionError("conflict", "这张卡已经有一个会话在做，给它说一句就行");
    const last = prior.at(-1);
    if (last?.workspace?.kind === "worktree" && !last.workspace.mergedCommit && existsSync(path)) {
      return { workspace: { ...last.workspace }, cwd: last.cwd, created: false, reused: true, dirty: false };
    }
    // 没有会话认领的旧目录（本机程序上次中途退出留下的）先清掉
    if (existsSync(path)) await removeWorktree(head.top, path).catch(() => rmSync(path, { recursive: true, force: true }));
    const dirty = (await changedFiles(folder)).length > 0;
    let branch: string;
    try {
      branch = await addWorktree(head.top, path, branchName(cardId, title), head.commit);
    } catch (e) {
      throw new SessionError("conflict", `给这张卡开工作树没成：${e instanceof Error ? e.message : String(e)}`);
    }
    // 本人选的是仓库里的子文件夹时，会话在工作树里对应的子文件夹里做
    const sub = relative(resolve(head.top), folder);
    const cwd = sub && !sub.startsWith("..") && !isAbsolute(sub) ? join(path, sub) : path;
    return {
      workspace: { kind: "worktree", folder, path, branch, baseBranch: head.branch, baseCommit: head.commit, mergedCommit: null },
      cwd, created: true, reused: false, dirty,
    };
  }

  /** 开工时告诉网页卡在哪做。 */
  private noteWorkspace(rec: SessionRecord, place: { reused: boolean; dirty: boolean } | null) {
    const ws = rec.workspace;
    if (ws?.kind !== "worktree" || !place) return;
    const text = place.reused
      ? `接着在这张卡的工作树里做：分支 ${ws.branch}`
      : `在工作树里做：分支 ${ws.branch}，从 ${ws.baseBranch} 的最新提交 ${ws.baseCommit.slice(0, 7)} 开始${place.dirty ? "；主文件夹里没提交的改动没带进来" : ""}`;
    this.emit(rec, { type: "notice", level: "info", code: "workspace", text });
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
    // 续接时也重查：允许的文件夹可能已被本人移除（卡在工作树里做时看本人选的主文件夹）。
    const folder = rec.workspace?.folder ?? rec.cwd;
    if (!this.d.folders.isAllowed(folder)) throw new SessionError("folder_not_allowed", "这个会话的目录已不在允许的文件夹里");
    if (!existsSync(rec.cwd)) throw new SessionError("conflict", "工作目录已经不在了（卡合回或取消后，它的工作树会清理）");
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
    writeFileSync(systemPromptPath, systemPrompt(rec.subject.kind, rec.role, rec.critics, feishu, rec.workspace));
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
    const plan = this.runFor(rec, model);
    rec.run = plan.view;
    if (this.records.has(rec.id)) this.save(rec);
    const run = await adapter.start({
      sessionId: rec.id, cwd: rec.cwd, resume, model, run: plan.launch, includePersonalConfig: rec.includePersonalConfig,
      mcpConfigPath: mcp.path, mcpEnv: mcp.env, allowedTools: mcp.allowedTools,
      disallowedTools,
      systemPromptPath, agentsPath, pluginDirs: plugin ? [plugin] : [],
      // 每次现查：会话途中本人移除了文件夹，之后的请求（包括工作目录里的）就算越界。卡在工作树里做时整个工作树都算。
      allowedRoots: () => [
        ...(this.d.folders.isAllowed(folder) ? [rec.workspace?.kind === "worktree" ? rec.workspace.path : rec.cwd] : []),
        ...this.d.folders.list().map((f) => f.path),
      ],
      // 卡在自己的工作树里：工作树里安全的步骤不问本人（规则在 pathGuard 的 autoAllowed）
      autoAllowRoot: rec.subject.kind === "card" && rec.workspace?.kind === "worktree" ? rec.workspace.path : null,
    });
    if (this.cancelled.delete(rec.id)) {
      await run.kill();
      throw new SessionError("conflict", CANCELLED_WHILE_STARTING);
    }
    this.runs.set(rec.id, run);
    this.pending.set(rec.id, new Map());
    run.onEvent((e) => this.onAgentEvent(rec, e));
    run.onExit((code) => this.onExit(rec, run, code));
    if (model.source === "subscription") run.onRateLimit((info) => this.d.quota?.fromEvent(info));
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
        // 批完回到原来的样子：在一轮里是在跑；一轮之外（后台子 agent 的请求，它在后台接着跑）或正在问本人时是等你回复
        if (!this.pending.get(rec.id)?.size && rec.status === "waiting_permission") {
          this.setStatus(rec, this.inTurn.has(rec.id) && !this.questions.has(rec.id) ? "running" : "idle");
        }
        break;
      case "agent_info":
        // 新的一轮开始（Claude Code 每轮开头都报 system/init）
        this.inTurn.add(rec.id);
        // Claude Code 自己开了一轮（后台子 agent 跑完来通知时，不经本人）：会话又在跑了
        if (rec.status === "idle" && !this.questions.has(rec.id)) this.setStatus(rec, "running");
        break;
      case "background":
        this.recordBackground(rec, e.item);
        break;
      case "question":
        // 执行方问本人：等你回复（不占位置），网页按问题和选项画按钮；后台子 agent 还有权限请求在等时仍是等你批准
        this.questions.set(rec.id, e.request);
        this.setStatus(rec, this.pending.get(rec.id)?.size ? "waiting_permission" : "idle");
        break;
      case "question_resolved":
        this.questions.delete(rec.id);
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
        const run = this.runs.get(rec.id);
        void this.syncCost(rec, e.usage, run?.lastTurn ?? null);
        // 订阅额度用完了：停着等恢复（不算出错、不等本人回复）；之后有一轮正常做完了就不再等。
        // 网关余额不足：停着等本人，用它的排着的也先不开始。预算用完收到「做完这一步就停」的：这一轮做完就停着等加预算。
        const limited = e.errorKind === "usage_limit";
        const broke = e.errorKind === "balance";
        const stopped = this.endBudgetStop(rec);
        if (limited) this.markHold(rec);
        else if (broke) { this.balanceBlocked.add(rec.modelProfileId); this.markHold(rec, "balance"); }
        else if (stopped) this.markHold(rec, "budget");
        else if (rec.hold && !e.isError) this.clearHold(rec);
        // 这一轮的请求随这一轮作废；后台子 agent 的请求执行方还在等，留着（不然子 agent 一直卡着）
        const pending = this.pending.get(rec.id);
        for (const id of [...(pending?.keys() ?? [])]) {
          if (run?.isWaiting(id)) continue;
          this.emit(rec, { type: "permission_resolved", requestId: id, decision: "deny", message: "这一轮已结束", allowForSession: false });
          pending!.delete(id);
        }
        if (rec.subject.kind === "verify" && !rec.submitted && !rec.nudged && !e.isError && run && !stopped) {
          // 验收员一轮做完却没交结论：提醒一次，状态保持进行中（不让出位置，免得刚让出去又占回来）。
          rec.nudged = true;
          this.save(rec);
          this.emit(rec, { type: "notice", level: "info", code: "verify_nudge", text: VERIFY_NUDGE });
          run.send(VERIFY_NUDGE);
          break;
        }
        this.inTurn.delete(rec.id);
        // 交完就收工（done）：验收员交了结论、规划员这一轮交了计划，让 Claude Code 自己退出，不留空闲进程，也不在「等你回复」停一下。
        // 本人想问验收员、要规划员「改一改」，说一句会续上。
        const delivered = rec.subject.kind === "verify" ? rec.submitted > 0 : this.proposed.delete(rec.id);
        if (delivered && run && !pending?.size) {
          this.finished.add(rec.id);
          run.close();
          break;
        }
        this.setStatus(rec, pending?.size ? "waiting_permission" : "idle", rec.hold && (limited || broke || stopped) ? { reason: this.holdReason(rec.hold) } : {});
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
    const question = this.questions.get(rec.id);
    if (question) this.onAgentEvent(rec, { type: "question_resolved", requestId: question.requestId, choices: null, text: null });
    this.stopAllBackground(rec); // 进程没了，还在跑的后台任务也没了
    const killed = this.killed.delete(rec.id);
    const finished = this.finished.delete(rec.id) && !killed;
    this.proposed.delete(rec.id);
    // 收到「做完这一步就停」时进程没了（不是本人强停的）：一样停着等加预算
    if (this.endBudgetStop(rec) && !killed && !finished) this.markHold(rec, "budget");
    rec.mcpSecret = "";
    // 订阅额度用完时 Claude Code 可能不交结果、直接退出：也是停着等额度，不算失败
    const limited = !killed && !finished && code !== 0 && (Boolean(rec.hold) || (this.subscription(rec) && this.blocked() !== null));
    if (limited && !rec.hold) this.markHold(rec);
    // 交完收工、正常退出（本机关的：合回前、交完结论）的不再等；关机时留着，下次启动接着等
    if (rec.hold && !limited && (finished || code === 0) && !this.holdQueue) this.clearHold(rec);
    if (finished) this.setStatus(rec, "done", { exitCode: code, reason: rec.subject.kind === "plan" ? "计划交了" : "验收完了" });
    else this.setStatus(rec, killed || code === 0 || limited || rec.hold?.reason === "budget" ? "exited" : "failed", {
      exitCode: code, reason: killed ? "已强停" : rec.hold && !killed ? this.holdReason(rec.hold) : undefined,
    });
    this.d.log.evict(rec.id);
    // 验收过了：卡在工作树里做的，试着自动合回
    if (finished && rec.subject.kind === "verify" && rec.passed) void this.autoMerge(rec);
  }

  async sendMessage(id: string, req: TLocalSendMessageRequest): Promise<TLocalSendMessageResponse> {
    const rec = this.must(id);
    if (rec.status === "queued") throw new SessionError("conflict", "还在等空位，开始后再说");
    if (rec.queuedMessage !== null && !this.starting.has(id)) throw new SessionError("conflict", "这件还没开始过（排队时取消了或没开起来），要做就重新开工");
    // 在等回答时说的一句就是回答（不选选项）
    const question = this.questions.get(id);
    if (question && req.kind !== "review" && req.text) {
      this.answerQuestion(id, question.requestId, { choices: question.questions.map(() => []), text: req.text });
      return { delivery: "next_step" };
    }
    let text: string;
    if (req.kind === "review") {
      if (rec.subject.kind !== "topic" || !rec.critics.length) throw new SessionError("validation", "评审会只给开工时带了挑刺岗位的专题用");
      text = reviewMessage(rec.critics, rec.lastVersion, req.text);
    } else {
      if (!req.text) throw new SessionError("validation", "说一句要有内容");
      text = req.text;
    }
    // 本人说了一句：不再等（额度、预算、余额），照常发（额度还没恢复就再停着等）；余额不足的这个模型配置也放开（多半是充值了）
    if (rec.hold?.reason === "balance") this.releaseBalance(rec.modelProfileId);
    this.clearHold(rec);
    this.dropBudgetStop(rec);
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
    const flip = delivery !== "next_step" ? this.syncMultiAgent(rec, run) : null;
    if (flip) await flip;
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
    void this.releaseWorktree(rec);
    return true;
  }

  /** 卡没开始就取消了：工作树没有别的会话在用就清掉（分支保留）。 */
  private async releaseWorktree(rec: SessionRecord): Promise<void> {
    const ws = rec.workspace;
    if (ws?.kind !== "worktree" || ws.mergedCommit || !existsSync(ws.path)) return;
    if ([...this.records.values()].some((r) => r !== rec && r.workspace?.kind === "worktree" && r.workspace.path === ws.path)) return;
    await removeWorktree(ws.folder, ws.path).catch((e) => {
      this.emit(rec, { type: "notice", level: "warn", code: "workspace", text: `工作树没清掉：${e instanceof Error ? e.message : String(e)}` });
    });
  }

  /** keepHold：托盘、网页的「暂停全部」只是先不接着做，恢复后照样到点接着做（本人点这一件的停下才不再等）。 */
  async interrupt(id: string, keepHold = false): Promise<TLocalSessionSummary> {
    const rec = this.must(id);
    const held = !keepHold && this.clearHold(rec); // 停下：不再等额度、到点也不自动接着做
    if (!keepHold) this.dropBudgetStop(rec);
    if (this.cancelQueued(rec)) return this.summary(rec);
    if (held) this.noteHold(rec);
    const run = this.runs.get(id);
    // 在问本人时状态是 idle，但这一轮还没完（执行方在等回答），也要停
    if (run && (rec.status !== "idle" || this.questions.has(id))) await run.interrupt();
    return this.summary(rec);
  }

  /** 后台任务开始或变了：按 id 覆盖，存下，报给云端。最多留 MAX_BACKGROUND 个（先丢最早的已结束的）。 */
  private recordBackground(rec: SessionRecord, item: TLocalBackgroundItem) {
    const i = rec.background.findIndex((b) => b.id === item.id);
    if (i >= 0) rec.background[i] = item;
    else rec.background.push(item);
    while (rec.background.length > MAX_BACKGROUND) {
      const old = rec.background.findIndex((b) => b.state !== "running");
      rec.background.splice(old >= 0 ? old : 0, 1);
    }
    this.save(rec);
    this.sync(rec, { type: "background", data: item });
    this.d.onChange?.();
    if (item.state !== "running") this.pump(); // 后台任务结束可能让出了文件夹
  }

  /** 进程不在了：还在跑的后台任务都算被停了。 */
  private stopAllBackground(rec: SessionRecord) {
    for (const b of rec.background.filter((x) => x.state === "running")) {
      const item: TLocalBackgroundItem = { ...b, state: "stopped", finishedAt: new Date().toISOString(), stoppable: false };
      this.emit(rec, { type: "background", item });
      this.recordBackground(rec, item);
    }
  }

  /** 停一个后台任务（会话本身不停）。执行方答应后会来 background 事件（stopped），回执里已经是停了的样子。 */
  async stopBackground(id: string, itemId: string): Promise<TLocalSessionSummary> {
    const rec = this.must(id);
    const item = rec.background.find((b) => b.id === itemId);
    const run = this.runs.get(id);
    if (!item || item.state !== "running" || !run) throw new SessionError("conflict", "这个后台任务已经停了或不在了");
    if (!(await run.stopTask(itemId))) throw new SessionError("conflict", "执行方没停下这个后台任务，可能刚好结束了");
    return this.summary(rec);
  }

  /**
   * 回答一次提问：choices[i] 是第 i 个问题选中的选项，text 是本人另外写的话。交给执行方时每个问题一条「问题原文 → 回答」：
   * 选了的写选项（多选用顿号连）；text 给没选的问题，都选了就接在最后一个问题的回答后面。
   */
  answerQuestion(id: string, requestId: string, req: TLocalQuestionAnswerRequest): TLocalSessionSummary {
    const rec = this.must(id);
    const q = this.questions.get(id);
    const run = this.runs.get(id);
    if (!q || q.requestId !== requestId || !run) throw new SessionError("conflict", "这次提问已经答过或已失效");
    if (req.choices.length !== q.questions.length) throw new SessionError("validation", `要按 ${q.questions.length} 个问题各给一组选项`);
    const text = req.text?.trim() || null;
    q.questions.forEach((item, i) => {
      const picked = req.choices[i]!;
      const unknown = picked.filter((l) => !item.options.some((o) => o.label === l));
      if (unknown.length) throw new SessionError("validation", `第 ${i + 1} 个问题没有这个选项：${unknown.join("、")}`);
      if (!item.multiSelect && picked.length > 1) throw new SessionError("validation", `第 ${i + 1} 个问题只能选一个`);
      if (!picked.length && !text) throw new SessionError("validation", `第 ${i + 1} 个问题还没回答`);
    });
    const allPicked = req.choices.every((c) => c.length);
    const answers: Record<string, string> = {};
    q.questions.forEach((item, i) => {
      const picked = req.choices[i]!.join("、");
      answers[item.question] = !picked ? text! : allPicked && text && i === q.questions.length - 1 ? `${picked}；${text}` : picked;
    });
    if (!run.respondQuestion(requestId, answers)) throw new SessionError("conflict", "这次提问已经答过或已失效");
    this.onAgentEvent(rec, { type: "question_resolved", requestId, choices: req.choices, text });
    this.setStatus(rec, this.pending.get(id)?.size ? "waiting_permission" : "running");
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
    const held = this.clearHold(rec);
    this.dropBudgetStop(rec);
    if (this.cancelQueued(rec)) return this.summary(rec);
    if (held) this.noteHold(rec);
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
    await Promise.all([...this.runs.keys()].map((id) => this.interrupt(id, true).catch(() => undefined)));
  }

  /**
   * 合回（只在本人点了才合，ADR 0038）：卡的分支合进主文件夹的 baseBranch，合成了清理工作树、保留分支。
   * 主文件夹不在 baseBranch 上、有改动、有冲突时不合，主文件夹原样不动；卡这边合不了（不在工作树里、还在跑、工作树里有没提交的改动）回 409。
   */
  async merge(id: string, auto = false): Promise<TLocalMergeResponse> {
    const rec = this.must(id);
    const ws = rec.workspace;
    if (ws?.kind !== "worktree") throw new SessionError("conflict", "这张卡不在工作树里做，没有分支可合");
    if (ws.mergedCommit) throw new SessionError("conflict", "这张卡已经合回过了");
    const related = [...this.records.values()].filter((r) => r === rec || r.parentId === rec.id);
    if (related.some((r) => r.status === "queued" || OCCUPYING.includes(r.status) || this.starting.has(r.id))) {
      throw new SessionError("conflict", "卡或它的验收员还在跑，停下再合");
    }
    if (rec.background.some((b) => b.state === "running")) throw new SessionError("conflict", "卡还有后台任务在跑，等它们结束或停掉再合");
    if (!this.d.folders.isAllowed(ws.folder)) throw new SessionError("folder_not_allowed", "主文件夹已不在允许的文件夹里");
    if (!existsSync(ws.path)) throw new SessionError("conflict", "这张卡的工作树已经不在了");
    if ((await changedFiles(ws.path)).length) throw new SessionError("conflict", "卡的工作树里还有没提交的改动（交回以后又改过），让它再交回一次再合");
    const out = await mergeBranch(ws.folder, ws.branch, ws.baseBranch, `合回天枢卡「${rec.title}」（${ws.branch}）`);
    if (!out.merged) {
      // 验收过了自动合没合成：记下原因等本人合（本人点了没合成的，原因在回执和同步条目里）
      if (auto) ws.needsMerge = { reason: out.reason, message: out.message.slice(0, 500) };
      this.save(rec);
      this.syncMerge(rec, { merged: false, commit: null, reason: out.reason, message: out.message, auto });
      this.d.onChange?.();
      return out;
    }
    ws.mergedCommit = out.commit;
    delete ws.needsMerge;
    this.save(rec);
    this.syncMerge(rec, { merged: true, commit: out.commit, reason: null, message: null, auto });
    // 一轮做完还开着的进程（卡、本人续上的验收员）先让它们退出：进程还在工作树里时，Windows 上删不掉。
    const open = related.map((r) => this.runs.get(r.id)).filter((run): run is AgentRun => Boolean(run));
    await Promise.all(open.map((run) => new Promise<void>((done) => { run.onExit(() => done()); run.close(); })));
    const merged = `已合回 ${ws.baseBranch}（${out.commit.slice(0, 7)}）`;
    let text = `${merged}，工作树已清理，分支 ${ws.branch} 保留`;
    await removeWorktree(ws.folder, ws.path).catch((e) => { text = `${merged}，工作树没删掉：${e instanceof Error ? e.message : String(e)}`; });
    this.emit(rec, { type: "notice", level: "info", code: "merged", text });
    this.d.onChange?.();
    void this.releaseWaiting(); // 等这张卡的卡可能可以开了
    return { merged: true, commit: out.commit, session: this.summary(rec) };
  }

  /**
   * 验收过了，卡在工作树里做的自动合回（本机设置「验收过就合回」，只合不推）：主文件夹停在原分支上、干净、合并没冲突才合，
   * 合了等它的卡接着开始。合不了（或关了、卡还在跑、交回以后又改过）就在卡上记 needsMerge 等本人合。都报一条同步条目 merge。
   */
  private async autoMerge(verifier: SessionRecord): Promise<void> {
    const card = verifier.parentId ? this.records.get(verifier.parentId) : undefined;
    const ws = card?.workspace;
    // 卡在这之后又交回了：以新的那次验收为准
    if (!card || ws?.kind !== "worktree" || ws.mergedCommit || this.latestVerifier(card) !== verifier) return;
    const notice = (message: string) => this.emit(card, { type: "notice", level: "info", code: "merge_needed", text: `验收过了，没自动合回：${message}` });
    const hold = (reason: TLocalMergeHoldReason, message: string) => {
      ws.needsMerge = { reason, message: message.slice(0, 500) };
      this.save(card);
      this.syncMerge(card, { merged: false, commit: null, reason, message, auto: true });
      notice(message);
      this.d.onChange?.();
    };
    if (this.d.autoMerge?.() === false) return hold("auto_merge_off", "没开「验收过就合回」，等你合");
    // 只合验过的那个提交：交回以后卡又提交过，等它再交回、再验收
    try {
      const head = await git(ws.folder, ["rev-parse", `refs/heads/${ws.branch}`]).then((o) => o.trim(), () => null);
      if (!head) return hold("not_ready", `找不到卡的分支 ${ws.branch}`);
      if (verifier.commit && head !== verifier.commit) return hold("not_ready", "交回以后卡又改过，等它再交回、验收过了再合");
      const out = await this.merge(card.id, true); // 合不了时 merge 自己记下 needsMerge、报 merge
      if (!out.merged) notice(out.message);
    } catch (e) {
      // 不能让后台这一步把本机程序带倒：前提不满足（卡还在跑等）和 git 出错都记下来等本人合
      hold("not_ready", e instanceof SessionError ? e.message : `合回出错：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 卡最近一次交回的验收员。 */
  private latestVerifier(card: SessionRecord): SessionRecord | undefined {
    return [...this.records.values()].filter((v) => v.parentId === card.id && v.subject.kind === "verify").sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  }

  /** 报一条合回结果（同步条目 merge），按卡最近一次交回；没交回过就合的不报。 */
  private syncMerge(card: SessionRecord, r: Omit<TLocalMergeSync, "handbackKey" | "baseBranch">) {
    const ws = card.workspace;
    const verifier = this.latestVerifier(card);
    if (ws?.kind !== "worktree" || !verifier?.subject.handbackKey) return;
    this.sync(card, { type: "merge", data: { handbackKey: verifier.subject.handbackKey, baseBranch: ws.baseBranch, ...r, message: r.message?.slice(0, 500) || null } });
  }

  // ───────── 订阅额度（新首页设计第 11 节） ─────────

  private subscription(rec: SessionRecord): boolean {
    return this.d.models.sourceOf(rec.modelProfileId) === "subscription";
  }

  /** 订阅额度用完、还没到恢复时间：恢复时间（毫秒，不知道几点为 Infinity）；没用完为 null。 */
  private blocked(): number | null {
    return this.d.quota?.blockedUntil() ?? null;
  }

  private timing() {
    return { resumeAfterMs: this.d.holdTiming?.resumeAfterMs ?? HOLD_RESUME_AFTER_MS, pollMs: this.d.holdTiming?.pollMs ?? HOLD_POLL_MS };
  }

  /** 记下停着等（之后的状态变化会带上 hold）。额度用完又不知道几点恢复就马上读一次额度。 */
  private markHold(rec: SessionRecord, reason: TLocalHold["reason"] = "usage_limit") {
    const b = this.blocked();
    rec.hold = { reason, until: reason === "usage_limit" && b !== null && Number.isFinite(b) ? new Date(b).toISOString() : null };
    rec.holdSince = nowIso();
    this.save(rec);
    if (reason === "usage_limit" && !rec.hold.until) void this.d.quota?.refresh(true);
    this.scheduleHoldCheck();
  }

  private holdReason(h: TLocalHold): string {
    return h.reason === "budget" ? BUDGET_REASON : h.reason === "balance" ? BALANCE_REASON : HOLD_REASON;
  }

  private clearHold(rec: SessionRecord): boolean {
    if (!rec.hold) return false;
    rec.hold = null;
    rec.holdSince = null;
    this.save(rec);
    this.scheduleHoldCheck();
    return true;
  }

  /** 状态没变、只是等额度变了：照样报一条状态（网页和云端按 hold 显示「等额度恢复 · HH:MM」）。 */
  private noteHold(rec: SessionRecord) {
    this.emit(rec, { type: "status", status: rec.status, ...(rec.hold ? { hold: rec.hold } : {}) });
    this.syncStatus(rec);
    this.d.onChange?.();
  }

  /** 排着、本来能开始的停着等：预算用完了、余额不足的；额度用完时的订阅会话（不开始，免得一开始就碰壁）。 */
  private gateQueued() {
    const limited = this.blocked() !== null;
    for (const rec of this.queue()) {
      if (rec.hold || !this.startable(rec)) continue;
      const gate = this.gateReason(rec) ?? (limited && this.subscription(rec) ? "usage_limit" : null);
      if (!gate) continue;
      this.markHold(rec, gate);
      this.noteHold(rec);
    }
  }

  /** 这件现在不该开始的原因（额度以外的）：预算用完了、它的网关模型余额不足。 */
  private gateReason(rec: SessionRecord): "budget" | "balance" | null {
    if (this.budgetExhausted(rec)) return "budget";
    if (this.balanceBlocked.has(rec.modelProfileId)) return "balance";
    return null;
  }

  /**
   * 到点了：额度没在用完的状态，而且过了恢复时间 1 分钟。不知道几点恢复时隔一会儿（5 分钟）再试：读到的额度说没用完也等，
   * 免得 Claude Code 说碰壁、额度却说没满时一直「接着做 → 又碰壁」。
   */
  private holdDue(rec: SessionRecord): boolean {
    const h = rec.hold;
    if (!h || !["queued", "idle", "exited"].includes(rec.status)) return false;
    // 预算用完的：预算加了（不再用完）就接着做；余额不足的只等本人说一句
    if (h.reason === "budget") return !this.budgetExhausted(rec);
    if (h.reason === "balance" || this.blocked() !== null) return false;
    const now = Date.now();
    if (h.until) return now >= Date.parse(h.until) + this.timing().resumeAfterMs;
    return now >= (Date.parse(rec.holdSince ?? "") || 0) + this.timing().pollMs;
  }

  /** 接着做：排着的回到队里；一轮做完停着的往开着的进程里说一句；进程不在了就续接（--resume）再说。 */
  private resumeHeld(rec: SessionRecord) {
    const budget = rec.hold?.reason === "budget";
    // 额度恢复了但预算用完了、预算加了但额度用完了：换成另一种等
    const other = budget ? (this.subscription(rec) && this.blocked() !== null ? "usage_limit" : null) : this.budgetExhausted(rec) ? "budget" : null;
    if (other) { this.markHold(rec, other); this.noteHold(rec); return; }
    this.clearHold(rec);
    if (rec.status === "queued") { this.noteHold(rec); return; }
    this.emit(rec, { type: "notice", level: "info", code: budget ? "budget_resumed" : "usage_resumed", text: budget ? "预算加了，接着做" : "额度恢复了，接着做" });
    const say = budget ? BUDGET_CONTINUE : HOLD_CONTINUE;
    const run = this.runs.get(rec.id);
    if (run) {
      this.setStatus(rec, "running");
      const flip = this.syncMultiAgent(rec, run);
      if (flip) void flip.then(() => run.send(say)); else run.send(say);
      return;
    }
    this.setStatus(rec, "starting");
    const p = this.startRun(rec, true);
    this.starting.set(rec.id, p);
    p.then((r) => { r.send(say); this.setStatus(rec, "running"); this.sendBudgetStop(rec, r); }, (e: unknown) => {
      const cancelled = e instanceof SessionError && e.message === CANCELLED_WHILE_STARTING;
      this.setStatus(rec, "exited", { reason: cancelled ? "已强停" : `额度恢复了，但没接上：${e instanceof Error ? e.message : String(e)}；再发一句话会接着做` });
    }).finally(() => this.starting.delete(rec.id));
  }

  /** 额度变了（读到了、跑着的卡报了）：停着等的更新恢复时间，能接着做的接上，重排下一次检查；预算按本周额度涨了几个点重算。 */
  onQuotaChange(): void {
    const weekly = this.d.quota?.weeklyPercent() ?? null;
    if (this.d.budgets && weekly !== null) {
      this.d.budgets.observeWeekly(weekly);
      for (const key of this.d.budgets.keys()) this.evaluateBudget(key);
    }
    const b = this.blocked();
    if (b !== null) {
      const until = Number.isFinite(b) ? new Date(b).toISOString() : null;
      for (const rec of this.records.values()) {
        if (rec.hold?.reason !== "usage_limit" || rec.hold.until === until) continue;
        rec.hold = { ...rec.hold, until };
        rec.holdSince = nowIso();
        this.save(rec);
        this.noteHold(rec);
      }
    }
    this.pump();
    this.scheduleHoldCheck();
  }

  /** 下一次检查：最早的恢复时间过 1 分钟；不知道几点的隔一会儿；已经过点（没空位接上）的也隔一会儿再看。 */
  private scheduleHoldCheck() {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    const held = [...this.records.values()].filter((r) => r.hold?.reason === "usage_limit");
    if (!held.length || this.holdQueue) return;
    const { resumeAfterMs, pollMs } = this.timing();
    const now = Date.now();
    const at = Math.min(...held.map((r) => (r.hold!.until ? Date.parse(r.hold!.until) + resumeAfterMs : (Date.parse(r.holdSince ?? "") || now) + pollMs)));
    this.holdTimer = setTimeout(() => void this.checkHolds(), at > now ? at - now : pollMs);
    this.holdTimer.unref?.();
  }

  private async checkHolds() {
    this.holdTimer = null;
    await this.d.quota?.refresh(true);
    this.onQuotaChange();
  }

  /** 一轮的花费：带上是订阅还是网关、主要用的模型；网关的按 TokenHub 价目表估真钱（读不到为 null）。 */
  private async syncCost(rec: SessionRecord, usage: TLocalUsage, turn: TurnModels | null) {
    const source = this.d.models.sourceOf(rec.modelProfileId);
    const size = (m: TurnModels["models"][number]) => m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens;
    const model = turn?.models.slice().sort((a, b) => size(b) - size(a))[0]?.model.slice(0, 100) ?? null;
    let money: TLocalMoney | null = null;
    if (source === "gateway" && this.d.pricing) {
      const m = await this.d.models.resolve(rec.modelProfileId).catch(() => null);
      if (m) money = await this.d.pricing.money({ baseUrl: m.baseUrl, apiKey: m.apiKey }, turn).catch(() => null);
    }
    this.sync(rec, { type: "cost", data: { modelLabel: rec.modelLabel, usage, ...(source ? { source } : {}), model, money } });
    // 记进这件 Task 的预算，看到没到 80%、100%
    if (rec.budgetKey && this.d.budgets) {
      if (money) this.d.budgets.addMoney(rec.budgetKey, money);
      this.evaluateBudget(rec.budgetKey, rec);
    }
  }

  // ───────── 预算（新首页设计 11.3、11.4） ─────────

  /** 这件 Task 的预算模式（没带预算为自动）。 */
  private modeOf(rec: SessionRecord): TBudgetMode {
    return (rec.budgetKey && this.d.budgets?.budget(rec.budgetKey)?.mode) || "auto";
  }

  /** 验收员用哪一档（挑模型配置和思考强度）：「无上限」重档；「设预算」到 80% 后轻档；不然按岗位。 */
  private verifierTier(rec: SessionRecord, roleTier: TLocalModelTier): TLocalModelTier {
    const mode = this.modeOf(rec);
    if (mode === "unlimited") return "strong";
    if (mode === "set" && rec.budgetKey && this.d.budgets?.judge(rec.budgetKey, this.liveMs(rec.budgetKey)) !== "ok") return "light";
    return roleTier;
  }

  private budgetExhausted(rec: SessionRecord): boolean {
    return Boolean(rec.budgetKey && this.d.budgets?.state(rec.budgetKey) === "exhausted");
  }

  /** 这一份预算正跑着的那几段（还没记进去的）。 */
  private liveMs(key: string): number {
    const now = Date.now();
    return [...this.records.values()].reduce((n, r) => n + (r.budgetKey === key && r.runSince ? Math.max(0, now - Date.parse(r.runSince)) : 0), 0);
  }

  /** 状态变了：离开「真在跑」时把这一段记进预算，进入时记下开始的时间（第一个开工的还记下预算的起点）。 */
  private countRunTime(rec: SessionRecord, next: TLocalSessionStatus) {
    if (!rec.budgetKey || !this.d.budgets) return;
    if (rec.runSince && !RUNNING_TIME.includes(next)) {
      this.d.budgets.addRun(rec.budgetKey, Date.now() - Date.parse(rec.runSince));
      rec.runSince = null;
    } else if (!rec.runSince && RUNNING_TIME.includes(next)) {
      rec.runSince = nowIso();
      this.d.budgets.start(rec.budgetKey, this.d.quota?.weeklyPercent() ?? null);
    }
  }

  /**
   * 一次拉起怎么跑：订阅按档位和预算模式（budget.ts 的 runFor）；配置里写了模型名的用配置的；网关用配置的模型名、不传思考强度、不开多 agent。
   * view 是摘要里的 run，launch 是交给 Claude Code 的。
   */
  private runFor(rec: SessionRecord, model: ResolvedModel): { view: TLocalRun; launch: { model: string; effort: TLocalRun["effort"] & string; multiAgent: boolean } } {
    const mode = this.modeOf(rec);
    const key = rec.budgetKey;
    const launch = runFor({
      mode, tier: rec.modelTier ?? "normal", verify: rec.subject.kind === "verify",
      budgetState: key && this.d.budgets ? this.d.budgets.judge(key, this.liveMs(key)) : "ok",
      quotaPercent: this.d.quota?.usedPercent() ?? null, quotaWarning: this.d.quota?.warning() ?? false,
    });
    const view: TLocalRun = model.source === "gateway"
      ? { mode, model: model.model, effort: null, multiAgent: false }
      : { mode, model: model.model ?? launch.model, effort: launch.effort, multiAgent: launch.multiAgent };
    return { view, launch };
  }

  /** 新的一轮之前：多 agent 该开该关（「无上限」额度到 95% 关掉，模式改了跟着改）。只管订阅；不用改时为 null（不多等一拍）。 */
  private syncMultiAgent(rec: SessionRecord, run: AgentRun): Promise<void> | null {
    if (!rec.run || !this.subscription(rec)) return null;
    const want = this.modeOf(rec) === "unlimited" && rec.subject.kind !== "verify" && (this.d.quota?.usedPercent() ?? 0) < MULTI_AGENT_OFF_PERCENT;
    if (want === rec.run.multiAgent) return null;
    return run.setMultiAgent(want).catch(() => false).then((ok) => {
      if (!ok || !rec.run) return;
      rec.run = { ...rec.run, multiAgent: want };
      this.save(rec);
      this.emit(rec, { type: "notice", level: "info", code: "multi_agent", text: want ? "多 agent 打开了" : "额度快用完了，后面的轮次不开多 agent" });
      this.syncStatus(rec);
    });
  }

  /** 收下一份预算：变了就马上重算（加了预算的，用完停着的接着做）。 */
  private applyBudget(key: string, scope: { taskId: string | null; sessionId: string | null }, budget: TLocalTaskBudgetView["budget"]): void {
    if (!this.d.budgets) return;
    if (this.d.budgets.set(key, scope, budget)) this.evaluateBudget(key, undefined, true);
  }

  /** PUT /v1/budgets：改一件 Task 或一个不挂 Task 的会话的预算。 */
  setBudget(req: TLocalBudgetUpdateRequest): TLocalTaskBudgetView {
    if (!this.d.budgets) throw new SessionError("conflict", "本机程序没开预算记账");
    if (Boolean(req.taskId) === Boolean(req.sessionId)) throw new SessionError("validation", "taskId、sessionId 只能带一个");
    let key: string;
    let scope: { taskId: string | null; sessionId: string | null };
    if (req.taskId) { key = Budgets.key(req.taskId, ""); scope = { taskId: req.taskId, sessionId: null }; }
    else {
      const rec = this.must(req.sessionId!);
      key = rec.budgetKey ?? Budgets.key(null, rec.id);
      scope = { taskId: key.startsWith("task:") ? key.slice(5) : null, sessionId: key.startsWith("task:") ? null : rec.id };
      if (!rec.budgetKey) { rec.budgetKey = key; this.save(rec); }
    }
    this.applyBudget(key, scope, req.budget);
    return this.d.budgets.view(key, this.liveMs(key))!;
  }

  budgets(): TLocalTaskBudgetView[] {
    const b = this.d.budgets;
    return b ? b.keys().map((k) => b.view(k, this.liveMs(k))!) : [];
  }

  private inBudget(key: string): SessionRecord[] {
    return [...this.records.values()].filter((r) => r.budgetKey === key);
  }

  /**
   * 重算一份预算：状态变了（到 80%、到 100%、加了预算回落）或预算被改了就报一条同步条目；到 100% 停下，从 100% 回落接着做。
   * 一轮做完、额度变了、每 30 秒（有会话在跑时）、收到新预算时调。
   */
  private evaluateBudget(key: string, trigger?: SessionRecord, changed = false): void {
    const b = this.d.budgets;
    if (!b?.has(key)) return;
    const prev = b.state(key);
    const next = b.judge(key, this.liveMs(key));
    if (next === prev && !changed) return;
    b.setState(key, next);
    const target = trigger ?? this.inBudget(key).sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))[0];
    if (target) {
      this.sync(target, { type: "budget", data: b.view(key, this.liveMs(key))! });
      if (next !== prev && next !== "ok") {
        this.emit(target, { type: "notice", level: "warn", code: next === "exhausted" ? "budget_exhausted" : "budget_warning",
          text: next === "exhausted" ? "这件 Task 的预算用完了：排着的先不开始，跑着的做完这一步就停" : "这件 Task 的预算用了 80%：后面开的卡思考强度降一档" });
      }
    }
    if (next === "exhausted" && prev !== "exhausted") this.stopBudget(key);
    else if (prev === "exhausted" && next !== "exhausted") this.releaseBudget(key);
    this.d.onChange?.();
  }

  /** 预算用完：排着的停着等；跑着的说一句「做完这一步就停」，这一轮做完或 3 分钟后打断，然后停着等加预算。一轮做完在等本人的不动。 */
  private stopBudget(key: string): void {
    for (const rec of this.inBudget(key)) {
      if (rec.status === "queued") {
        if (!rec.hold) { this.markHold(rec, "budget"); this.noteHold(rec); }
        continue;
      }
      const busy = OCCUPYING.includes(rec.status) || this.inTurn.has(rec.id);
      if (!busy || this.budgetStopping.has(rec.id)) continue;
      const timer = setTimeout(() => void this.interrupt(rec.id, true).catch(() => undefined), this.d.holdTiming?.budgetGraceMs ?? BUDGET_STOP_GRACE_MS);
      timer.unref?.();
      this.budgetStopping.set(rec.id, { timer, sent: false });
      const run = this.runs.get(rec.id);
      if (run) this.sendBudgetStop(rec, run); // 还在拉起的，开始后再说
    }
  }

  /** 把「做完这一步就停」送出去（还没送过才送）。 */
  private sendBudgetStop(rec: SessionRecord, run: AgentRun): void {
    const s = this.budgetStopping.get(rec.id);
    if (!s || s.sent) return;
    s.sent = true;
    run.send(BUDGET_STOP);
  }

  /** 预算加了：收到「做完这一步就停」还没停下的，说一句不用停；停着等的由 pump 接着做（holdDue）。 */
  private releaseBudget(key: string): void {
    for (const rec of this.inBudget(key)) {
      const s = this.budgetStopping.get(rec.id);
      if (!s) continue;
      this.dropBudgetStop(rec);
      if (s.sent) this.runs.get(rec.id)?.send(BUDGET_NO_STOP);
      this.emit(rec, { type: "notice", level: "info", code: "budget_resumed", text: "预算加了，不用停" });
    }
    this.pump();
  }

  /** 一轮做完、进程没了：在等「做完这一步就停」的就算停下了（回 true）。 */
  private endBudgetStop(rec: SessionRecord): boolean {
    if (!this.budgetStopping.has(rec.id)) return false;
    this.dropBudgetStop(rec);
    return true;
  }

  private dropBudgetStop(rec: SessionRecord): void {
    const s = this.budgetStopping.get(rec.id);
    if (!s) return;
    clearTimeout(s.timer);
    this.budgetStopping.delete(rec.id);
  }

  /** 本人对余额不足的一件说了一句：这个模型配置放开，用它排着的回到队里（还不足就再停）。 */
  private releaseBalance(profileId: string): void {
    if (!this.balanceBlocked.delete(profileId)) return;
    for (const rec of this.queue()) {
      if (rec.hold?.reason !== "balance" || rec.modelProfileId !== profileId) continue;
      this.clearHold(rec);
      this.noteHold(rec);
    }
    this.pump();
  }

  /** 本机程序启动时：卡用过的仓库里，目录已经没了的工作树清掉登记（git worktree prune）。 */
  async pruneWorktrees(): Promise<void> {
    const repos = new Set([...this.records.values()].flatMap((r) => (r.workspace?.kind === "worktree" ? [r.workspace.folder] : [])));
    for (const repo of repos) if (existsSync(repo)) await pruneRepo(repo);
  }

  async shutdown(): Promise<void> {
    // 关机时进程一个个退出会让出位置，这时不能再从队里接新的：排着的留到下次启动。
    this.holdQueue = true;
    if (this.briefTimer) clearTimeout(this.briefTimer);
    this.briefTimer = null;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    if (this.budgetTimer) clearInterval(this.budgetTimer);
    this.budgetTimer = null;
    for (const s of this.budgetStopping.values()) clearTimeout(s.timer);
    this.budgetStopping.clear();
    // 停着等额度的不算本人停的：关机时照原样进程退出（kill 会清掉等额度），下次启动接着等
    await Promise.all([...this.runs.keys()].map(async (id) => {
      const run = this.runs.get(id);
      const rec = this.records.get(id);
      if (rec?.hold && run) { this.killed.add(id); await run.kill(); return; }
      await this.kill(id).catch(() => undefined);
    }));
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
  async handBack(id: string, input: { summary: string; criteria: TLocalHandbackCriterion[]; outputs?: string[] }): Promise<string> {
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
    // 卡在工作树里做：没提交的改动先提交到卡的分支，交回和验收都认这个提交（ADR 0038）
    const ws = rec.workspace;
    let git: TLocalGitRef | undefined;
    if (ws?.kind === "worktree") {
      try {
        const commit = await commitAll(ws.path, `交回：${rec.title}\n\n天枢卡 ${rec.subject.cardId}`);
        git = { branch: ws.branch, baseBranch: ws.baseBranch, baseCommit: ws.baseCommit, commit };
      } catch (e) {
        throw new SessionError("conflict", `提交改动没成，没交回：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (ws?.kind === "worktree" && ws.needsMerge) { delete ws.needsMerge; this.save(rec); } // 又交回了：等这次验收的结果
    this.emit(rec, { type: "handback", summary, criteria, outputKeys, ...(git ? { commit: git.commit } : {}) });
    const key = this.sync(rec, { type: "handback", data: { summary, criteria, outputKeys, ...(git ? { git } : {}) } });
    this.queueVerify(rec, key, git?.commit ?? null);
    return `已交回（用了 ${picked.map((o) => o.ref).join("、") || "0 份产出和证据"}${git ? `，提交 ${git.commit.slice(0, 7)}` : ""}），本机接着起验收员验收`;
  }

  // ───────── 验收员：交回后本机自己起（不经云端） ─────────

  /** 先排着；等交回被天枢收下、取到验收交代，再按验收员的岗位档位挑模型开始。 */
  private queueVerify(card: SessionRecord, handbackKey: string, commit: string | null) {
    const now = nowIso();
    const rec: SessionRecord = {
      id: randomUUID(), subject: { kind: "verify", cardId: card.subject.cardId!, handbackKey }, title: `验收：${card.title}`.slice(0, 120),
      agent: card.agent, modelProfileId: card.modelProfileId, modelLabel: card.modelLabel, cwd: card.cwd, includePersonalConfig: false,
      createdAt: now, updatedAt: now, status: "queued", usage: zeroUsage(), syncSeq: 0, mcpSecret: "", outputs: [], versionNumber: 0, lastVersion: null,
      role: null, modelTier: null, critics: [], queuedMessage: null, queueOrder: ++this.queueSeq,
      parentId: card.id, briefPending: true, criteria: [], failStreak: 0, submitted: 0, nudged: false, workspace: null, commit, after: [], passed: null,
      background: [], hold: null, holdSince: null, budgetKey: card.budgetKey, runSince: null, run: null,
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
      // 卡在工作树里做：交代后面接上开工以来到交回那个提交的改动（验收员只读、不能跑命令）
      const ws = rec.parentId ? this.records.get(rec.parentId)?.workspace : null;
      const changes = rec.commit && ws?.kind === "worktree"
        ? changesBrief(ws, rec.commit, await cardDiff(ws.folder, ws.baseCommit, rec.commit).catch((e: unknown) => (e instanceof Error ? e.message : String(e))))
        : null;
      // 验收员的档位：按岗位；「无上限」用重档，「设预算」到 80% 后用轻档（11.3）
      const tier = this.verifierTier(rec, brief.role?.modelTier ?? "normal");
      const model = await this.d.models.resolve(this.d.models.forTier(tier));
      if (rec.status !== "queued" || !rec.briefPending) continue;
      // 交代、模型一次填好再标成能开始：中间不能有 await，免得别处的 pump 拿着空的第一句话、执行方的模型先开了它。
      const markdown = changes ? `${brief.markdown}\n\n${changes}` : brief.markdown;
      Object.assign(rec, { briefPending: false, queuedMessage: markdown, criteria: brief.criteria, failStreak: brief.failStreak, role: brief.role, modelTier: tier });
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
      ...(rec.commit ? { commit: rec.commit } : {}),
    };
    const problem = schemaProblem(LocalVerdict, verdict);
    if (problem) throw new SessionError("validation", `结论不合格：${problem}`);
    rec.submitted = 1;
    rec.passed = verdict.passed;
    this.sync(rec, { type: "verdict", data: verdict });
    if (verdict.passed) void this.releaseWaiting(); // 文件夹里做的卡验收过了就算做完
    const failStreak = verdict.passed ? 0 : rec.failStreak + 1;
    const blocked = failStreak >= reworkRounds(this.modeOf(rec)); // 受阻前返工几轮：自动、设预算 2，无上限 3
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
        ...(Array.isArray(c?.after) && c.after.length ? { after: [...new Set<number>(c.after)] } : {}),
      })),
      modelLabel: rec.modelLabel, roleId: rec.role?.id ?? null, roleVersion: rec.role?.version ?? null,
    };
    const problem = schemaProblem(LocalCardPlan, plan);
    if (problem) throw new SessionError("validation", `计划不合格：${problem}`);
    // 只能等排在前面的件（位置比自己小），免得互相等
    const bad = plan.cards.findIndex((c, i) => c.after?.some((p) => p > i));
    if (bad >= 0) throw new SessionError("validation", `第 ${bad + 1} 件的 after 只能写排在它前面的件（1 到 ${bad}）`);
    rec.submitted = plan.revision;
    this.proposed.add(rec.id);
    this.sync(rec, { type: "card_plan", data: plan });
    this.emit(rec, { type: "notice", level: "info", code: "card_plan", text: `交了第 ${plan.revision} 次计划：${plan.cards.length} 件` });
    return `已交第 ${plan.revision} 次计划（${plan.cards.length} 件）。这一轮做完你就收工；本人要改会再叫你，改完再交一次。`;
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
