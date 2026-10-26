import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { TPreflightCandidate, TWebSearchInput, TWebSearchResponse, TWebSearchResult } from "@warmap/contracts";
import { migrate } from "../src/migrate.js";
import { hashSecret } from "../src/session.js";
import { buildApp, DEFAULT_CONVERSATION_ATTACHMENT_STORAGE_DIR, type AppEnv } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { ConversationRuntime } from "../src/conversations.js";
import type { ConversationCompactionOptions } from "../src/conversationCompaction.js";
import type { ResearchService } from "../src/research.js";
import type { PreflightAgent } from "../src/meetingPreflight.js";
import type { DriExporter } from "../src/meetingStore.js";
import { createMonthlyPlanService, type MonthlyDraftAgent, type MonthlyPlanService } from "../src/monthlyDraft.js";
import { loadPeopleDirectory } from "../src/peopleDirectory.js";
import { createCompanyContext } from "../src/companyContext.js";
import { createMonthlyReviewService, type MonthlyReviewAgents, type MonthlyReviewService } from "../src/monthlyReviewService.js";
import { assessOutcomeCandidate, type PostMeetingAgent } from "../src/outcome.js";
import { deriveMeetingStatus, meetingEffectRef } from "../src/effects.js";
import { decisionIssueId, getMeetingRow } from "../src/meetingStore.js";
import { dispatchMeetingTodo } from "../src/tasks.js";
import type { WebSearchAdapter } from "../src/webSearch.js";
import { createMeetingRecordingService, DEFAULT_RECORDING_STORAGE_DIR, type MeetingRecordingService, type RecordingDeps } from "../src/meetingRecordings.js";
import type { VoiceprintDeps } from "../src/voiceprints.js";
import type { DictationDeps } from "../src/dictation.js";
import type { RealtimeSessionDeps } from "../src/tencentAsrRealtime.js";
import type { DictationPolishDeps } from "../src/dictationPolish.js";
import type { RadarService } from "../src/radar.js";
import type { PersonalRadarService } from "../src/personalRadar.js";
import type { ThreadIntroAgent } from "../src/threadIntro.js";
import type { TaskAcceptanceAgent } from "../src/taskAcceptanceDraft.js";
import type { MaterialAnnotationAgent } from "../src/materialAnnotationAgent.js";
import type { MissionCardAnnotationAgent } from "../src/missionCardAnnotationAgent.js";
import type { MissionCardReviewAgent } from "../src/missionCardReview.js";
import type { MissionCardDraftAgent } from "../src/missionCardDraftAgent.js";
import type { RequestAgent } from "../src/delivery/requestAgent.js";
import type { FeishuClient } from "../src/feishu/client.js";
import { createWeeklyReviewService, type WeeklyReviewService } from "../src/weeklyReviewService.js";
import type { WeeklyReviewAgent } from "../src/weeklyReviewAgent.js";

const ADMIN_URL = process.env.TEST_PG_URL ?? "postgres://postgres:postgres@localhost:54329/postgres";
const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);
const TEMPLATE_LOCK_KEY = 727212; // 建测试模板库的锁，与 migrate 的锁分开
let migratedTemplate: Promise<string> | undefined;

/**
 * 跑完全部迁移的模板库，按迁移文件内容哈希命名；测试库从它复制，不必每次重跑全部迁移。
 * 多个测试进程同时起步时持锁只建一次；先在临时名下迁移、建好再改名，别的进程不会复制到半成品。
 */
function migratedTemplateDatabase(): Promise<string> {
  migratedTemplate ??= (async () => {
    const hash = createHash("sha256");
    for (const file of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort()) {
      hash.update(file).update(await readFile(new URL(file, MIGRATIONS_DIR)));
    }
    const name = `warmap_template_${hash.digest("hex").slice(0, 16)}`;
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
      await admin.query("SELECT pg_advisory_lock($1)", [TEMPLATE_LOCK_KEY]);
      if ((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount === 0) {
        const building = `${name}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
        await admin.query(`CREATE DATABASE ${building}`);
        const db = new Client({ connectionString: ADMIN_URL.replace(/\/postgres$/, `/${building}`) });
        await db.connect();
        try {
          await migrate(db);
        } finally {
          await db.end();
        }
        await admin.query(`ALTER DATABASE ${building} RENAME TO ${name}`);
      }
    } finally {
      await admin.end(); // 断开即释放锁
    }
    return name;
  })();
  return migratedTemplate;
}

export type TestDb = { db: import("pg").PoolClient; pool: Pool; admin: Pool; database: string };

/**
 * 新版 advisor-review 场景的合法候选；各领域测试只替换其关心的内容。
 * 问题不设下限（feedback 18）：这里是一个真实取舍——一条会议问题、一条不重复的一号位追问，各带 ceoDecision。
 */
export function preflightCandidate(sourceRefs: string[]): TPreflightCandidate {
  const entry = (kind: TPreflightCandidate["entries"][number]["kind"], title: string, body: string) =>
    ({ kind, title, body, sourceRefs });
  const question = (kind: "meeting_question" | "leader_lens", title: string, body: string, options: { label: string; impact: string }[]) => ({
    ...entry(kind, title, body),
    ceoDecision: { whyNow: "渠道窗口六月关闭，晚于五月底决定就错过本季投放", whyCeo: "涉及跨战场预算调配，超出渠道负责人授权", options },
  });
  return {
    taskDefinition: {
      materialPurpose: "说明渠道投入选择",
      reviewPurpose: "支持 CEO 会前判断材料是否足以进入讨论",
      primaryRole: "research_analysis",
      secondaryRole: null,
      maturity: "internal_alignment",
      readerAction: "判断是否进入渠道投入决策讨论",
      nonGoal: "不在预审阶段替 CEO 批准投入",
    },
    readiness: "revise",
    entries: [
      entry("core_judgment", "核心判断", "材料可进入讨论，但关键证据仍需补足"),
      entry("strategic_alignment", "战略一致性", "当前选择需与公司主线校准"),
      entry("positive_signal", "积极信号", "材料已经提出明确选择"),
      entry("risk_calibration", "风险与校准", "投入后果仍缺少验证依据"),
      question("meeting_question", "渠道预算是否转向华南", "是否在六月前把渠道预算从华东转到华南？", [
        { label: "六月前转向华南", impact: "抢到本季窗口，但华东存量客户的续约投入减少" },
        { label: "维持华东投入", impact: "保住续约节奏，本季华南窗口放弃" },
      ]),
      entry("next_step", "下一阶段建议", "提交人先补齐推荐路径与后果"),
      question("leader_lens", "华南转化依据", "华南转化率来自哪几家客户，样本够不够支撑整笔预算调整？", []),
    ],
    basis: "依据关联 Issue、ResearchDoc 与本体公司事实，只形成候选材料",
    brief: "材料可进入讨论，但关键证据仍需补足",
    summary: { criticalIssue: "缺少推荐路径的验证依据", priorityAction: "补齐选择后果与推翻条件" },
  };
}

/** DROP DATABASE (FORCE) 终止测试库残留连接是预期行为；其他池错误必须保持可见。 */
function tolerateDroppedConnections(pool: Pool): Pool {
  pool.on("error", (error: Error & { code?: string }) => {
    if (error.code !== "57P01") console.error("test pool error", error);
  });
  return pool;
}

/** 建一个一次性库跑迁移/集成测试，结束后删除。默认是空库；migrated 时从已迁移的模板复制。 */
export async function createTestDb(fn: (t: TestDb) => Promise<void>, options: { migrated?: boolean } = {}): Promise<void> {
  const database = `warmap_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
  await admin.query(options.migrated ? `CREATE DATABASE ${database} TEMPLATE ${await migratedTemplateDatabase()}` : `CREATE DATABASE ${database}`);
  const db = tolerateDroppedConnections(new Pool({
    connectionString: ADMIN_URL.replace(/\/postgres$/, `/${database}`),
    max: 5,
  }));
  const client = await db.connect();
  try {
    await fn({ db: client, pool: db, admin, database });
  } finally {
    client.release();
    await db.end();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  }
}

const FIXTURE_PEOPLE_SEED = fileURLToPath(new URL("./fixtures/company-people.json", import.meta.url));

export const testEnv: AppEnv = {
  sessionSecret: "test-session-secret",
  sessionMaxAgeSeconds: 60 * 60 * 8,
  publicOrigin: "https://warmap.local",
  driServiceToken: "dri-token-test",
  companyPeopleSeed: FIXTURE_PEOPLE_SEED,
  piBaseUrl: "https://provider.invalid/v1/responses",
  piApiKey: "test-key",
  lightModel: "test-light-model",
  heavyModel: "test-heavy-model",
  compactionModel: "test-compaction-model",
  buildSha: "test-sha",
};

/** fixture seed：person-fixture-001 是 CEO，002 是成员。测试凭据已跳过首次改口令。 */
export const TEST_CEO = { personId: "person-fixture-001", loginId: "ceshij", passcode: "2468" } as const;
export const TEST_MEMBER = { personId: "person-fixture-002", loginId: "ceshiy", passcode: "1357" } as const;
export const TEST_LOGIN = { loginId: TEST_CEO.loginId, passcode: TEST_CEO.passcode };

/**
 * 旧格式会议（会议卡之前，会后逐条条目）：现在的会后整理只生成会议卡，逐条确认也已停。测旧会议数据的用例在逐字稿导入之后用它把会议写成旧会议的样子，
 * 和原来的会后抽取一样：校验候选、todo 推成执行事项、按条目算会议状态；没有会议卡。
 * confirmDecisions：写成当时已经逐条确认过决定的样子（关联议题的写一条 meeting.confirm_item 回执、议题记为 decided）。
 */
export async function seedLegacyOutcome(pool: Pool, meetingId: string, candidate: unknown, { confirmDecisions = false }: { confirmDecisions?: boolean } = {}): Promise<void> {
  const meeting = (await getMeetingRow(pool.query.bind(pool), meetingId))!;
  const assessed = assessOutcomeCandidate({ candidate, turns: meeting.transcript!.turns, participants: meeting.participants,
    ceoParticipantId: meeting.ceo_participant_id, issueIds: meeting.issue_ids });
  if (!assessed.ok) throw new Error(assessed.message);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const item of assessed.items) {
      if (item.kind !== "todo") continue;
      const ownerId = item.ownerPersonId ?? meeting.lead_dri_id;
      const taskId = await dispatchMeetingTodo(client, { id: meetingId, leadDriId: meeting.lead_dri_id, ceoId: meeting.ceo_participant_id,
        ownerName: meeting.participants.find((person) => person.personId === ownerId)?.displayName, title: meeting.title }, item);
      if (taskId) item.review = { status: "confirmed", effectRef: `task:${taskId}` };
    }
    for (const item of confirmDecisions ? assessed.items : []) {
      if (item.kind !== "decision") continue;
      const effectRef = meetingEffectRef(meetingId, "decision", item.id)!;
      const issueId = decisionIssueId(meeting, item);
      if (issueId) {
        const issue = (await client.query("SELECT receipts, research FROM issues WHERE id = $1", [issueId])).rows[0];
        const receipt = { id: randomUUID(), actionType: "meeting.confirm_item", actionFingerprint: randomUUID(), effectRef, decisionText: item.text,
          researchStatusAtDecision: issue.research.status, override: false, source: { kind: "meeting-item", meetingId, outcomeItemId: item.id }, createdAt: new Date().toISOString() };
        await client.query("UPDATE issues SET status = 'decided', receipts = $2::jsonb, version = version + 1, updated_at = now() WHERE id = $1",
          [issueId, JSON.stringify([...issue.receipts, receipt])]);
      }
      item.review = { status: "confirmed", effectRef };
    }
    await client.query("DELETE FROM meeting_cards WHERE meeting_id = $1", [meetingId]);
    await client.query(
      `UPDATE meetings SET outcome = outcome || jsonb_build_object('status', 'ready', 'summary', $2::text, 'items', $3::jsonb, 'warnings', $4::jsonb,
         'extractedAt', $5::text, 'error', NULL, 'startedAt', NULL), status = $6, version = version + 1, updated_at = now() WHERE id = $1`,
      [meetingId, assessed.summary, JSON.stringify(assessed.items), JSON.stringify(assessed.warnings), new Date().toISOString(), deriveMeetingStatus(meeting.status, assessed.items)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** 给一次性测试库写入两份测试凭据；已存在就不动（不让已签发的会话失效）。 */
export async function seedTestAccess(q: { query: (text: string, params?: unknown[]) => Promise<unknown> }): Promise<void> {
  for (const who of [TEST_CEO, TEST_MEMBER]) {
    await q.query(
      "INSERT INTO member_access (person_id, login_id, passcode_hash, must_change) VALUES ($1, $2, $3, FALSE) ON CONFLICT (person_id) DO NOTHING",
      [who.personId, who.loginId, hashSecret(who.passcode)],
    );
  }
}

async function loginAs(app: FastifyInstance, who: { loginId: string; passcode: string }): Promise<string> {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: testEnv.publicOrigin },
    payload: { loginId: who.loginId, passcode: who.passcode },
  });
  if (login.statusCode !== 200) throw new Error(`login failed: ${login.body}`);
  return (login.headers["set-cookie"] as string).split(";")[0];
}

export function createFakeWebSearchAdapter(
  fixtures: Record<string, TWebSearchResponse | TWebSearchResult[]>,
): WebSearchAdapter & { calls: TWebSearchInput[] } {
  const calls: TWebSearchInput[] = [];
  return {
    calls,
    async search(input, signal) {
      if (signal.aborted) throw signal.reason;
      calls.push(structuredClone(input));
      const fixture = fixtures[input.query];
      if (!fixture) return { results: [], warnings: [`No fake fixture for: ${input.query}`] };
      return Array.isArray(fixture) ? { results: structuredClone(fixture), warnings: [] } : structuredClone(fixture);
    },
  };
}

export type TestApp = {
  app: FastifyInstance;
  pool: Pool;
  publicOrigin: string;
  env: AppEnv;
  loginCookie: () => Promise<string>;
  memberCookie: () => Promise<string>;
  fixtureRow: () => Promise<Record<string, unknown>>;
  conversationState: (scope: string) => Promise<{
    runtimeEntries: unknown[];
    piSessionId?: string;
    recreatedAt?: Date | null;
    runtimeWarning?: string | null;
    messages: Record<string, unknown>[];
  }>;
  setRuntimeEntries: (scope: string, entries: unknown) => Promise<void>;
  agentRuns: () => Promise<Record<string, unknown>[]>;
  sql: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
  /** 仅当注入 monthlyDraftAgent 时存在；测试用它触发 Company Day scheduler。 */
  monthlyPlans?: MonthlyPlanService;
  /** 仅当注入 monthlyReviewAgents 时存在；测试用它触发月末复盘 scheduler、等生成跑完。 */
  monthlyReviews?: MonthlyReviewService;
  /** 仅当注入 recordingDeps 时存在；测试用它等流水线跑完、模拟重启恢复。 */
  recordings?: MeetingRecordingService;
  /** 仅当注入 weeklyReviewAgent 时存在：测试用它触发周五定时、等生成跑完。 */
  weeklyReviews?: WeeklyReviewService;
  restart: (runtime: ConversationRuntime) => Promise<FastifyInstance>;
  close: () => Promise<void>;
};

/** 个人记忆提炼的测试模型流：每次只交一份 noop 候选。 */
export function noopDistillationStream() {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = { role: "assistant", api: "openai-responses", provider: "warmap", model: "test",
    content: [{ type: "toolCall", id: randomUUID(), name: "submit_candidate", arguments: { status: "noop", items: [], clarification: "" } }],
    stopReason: "toolUse", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  queueMicrotask(() => stream.push({ type: "done", reason: "toolUse", message }));
  return stream;
}

/** 每个用例一个独立数据库 + 已迁移 schema + 完整 app。可覆盖人员 seed 路径。 */
const defaultConversationRuntime: ConversationRuntime = {
  async run(input) {
    input.emit({ type: "message", delta: "test reply" });
    return { assistantMessage: "test reply", runtimeEntries: input.runtimeEntries };
  },
};

export async function createTestApp(
  seedOverrides: Partial<Pick<AppEnv, "companyPeopleSeed" | "materialStorageDir" | "conversationAttachmentStorageDir" | "recordingStorageDir" | "extraOrigins" | "companyName" | "missionCardDraftsDir" | "worldApiUrl" | "worldAgentToken" | "worldInstance" | "worldInstanceLocalFile" | "publicOrigin" | "feishu" | "adminPersonIds" | "onboardingDelegationStep" | "internalChatToken" | "worldPeriodGoalGates" | "collectionsEnabled" | "docChangeEnabled">> = {},
  conversationRuntime: ConversationRuntime = defaultConversationRuntime,
  runtimeOptions: {
    conversationTurnTimeoutMs?: number;
    conversationStallTimeoutMs?: number;
    conversationHeartbeatMs?: number;
    /** 对话历史后台压缩的阈值等（conversationCompaction.ts），测试用小阈值。 */
    conversationCompactionOptions?: Omit<ConversationCompactionOptions, "query" | "summarize">;
    backgroundPreflight?: boolean;
    preflightAgent?: PreflightAgent;
    outcomeAgent?: PostMeetingAgent;
    threadIntroAgent?: ThreadIntroAgent;
    /** 验收草稿的假 Agent；不注入时起草失败（接口 503，手填照样能验收）。 */
    taskAcceptanceAgent?: TaskAcceptanceAgent;
    /** 首页 Task 行的假来源；不注入时一个 Task 都没有。 */
    planTasks?: Parameters<typeof buildApp>[0]["planTasks"];
    materialAnnotationAgent?: MaterialAnnotationAgent;
    missionCardAnnotationAgent?: MissionCardAnnotationAgent;
    missionCardReviewAgent?: MissionCardReviewAgent;
    missionCardDraftAgent?: MissionCardDraftAgent;
    /** 送达通道的假 Agent；不注入时用真实装配（测试里不会被调用）。 */
    requestAgent?: RequestAgent;
    /** ③ 信息收集的假起草 Agent 与假多维表格；不注入时用真实装配（起草不会被调用）、多维表格是进程内的 mock。 */
    collectionAgent?: Parameters<typeof buildApp>[0]["collectionAgent"];
    bitable?: Parameters<typeof buildApp>[0]["bitable"];
    driExporter?: DriExporter;
    monthlyDraftAgent?: MonthlyDraftAgent;
    monthlyNow?: () => Date;
    /** 月末复盘的假起草、评估、汇总 Agent；与 monthlyDraftAgent 共用 monthlyNow。 */
    monthlyReviewAgents?: MonthlyReviewAgents;
    monthlyReviewRetryDelayMs?: number;
    /** 周复盘的假 Co-Agent；与月度复盘共用 monthlyNow。people 缺省是名单里能进成员工作台的人。 */
    weeklyReviewAgent?: WeeklyReviewAgent;
    weeklyReviewPeople?: () => string[];
    /** 会议录音的假 ffmpeg/TOS/火山；不注入时 app 装配真实依赖（不会被调用）。 */
    recordingDeps?: RecordingDeps;
    /** /api/me/voiceprint 的假 ffmpeg/腾讯云；不注入时按环境变量判断未配置。 */
    voiceprintDeps?: VoiceprintDeps;
    /** /api/me/dictation 的假 ffmpeg/火山极速版。 */
    dictationDeps?: DictationDeps;
    /** /api/me/dictation/session 的时钟 / 配置替身（只覆盖给出的几项）。 */
    dictationRealtimeDeps?: Partial<RealtimeSessionDeps>;
    /** /api/me/dictation/polish 的假方舟。不注入时按环境变量判断（测试环境未配置，回原文）。 */
    dictationPolishDeps?: DictationPolishDeps;
    /** 公司雷达与个人雷达服务替身；不注入时 app 用未配置的桩。 */
    radarService?: RadarService;
    personalRadarService?: PersonalRadarService;
    /** 个人记忆提炼的模型流；不注入时一律交 noop 候选（测试里不调真实模型）。 */
    personalDistillationStream?: Parameters<typeof buildApp>[0]["personalDistillationStream"];
    /** 飞书开放接口替身；配合 seedOverrides.feishu 使用。 */
    feishuClient?: FeishuClient;
    /** 个人记忆的召回模型替身；不注入时不用模型、只按字面重合选（测试里不调真实模型）。 */
    personalMemoryRecall?: Parameters<typeof buildApp>[0]["personalMemoryRecall"];
    /** 记忆导入的分类与去重模型替身；不注入时按测试环境装配（测试里不调真实模型）。 */
    memoryImportModel?: Parameters<typeof buildApp>[0]["memoryImportModel"];
    /** 会后分层、影响分析与妙记接口的替身；不注入时用真实装配（只在后台任务里调用，测试不跑 worker）。 */
    meetingFollowThroughAgents?: Parameters<typeof buildApp>[0]["meetingFollowThroughAgents"];
    /** 文档变更找候选的假 Agent；不注入时用真实装配（只在后台任务里调用）。 */
    docChangeAgent?: Parameters<typeof buildApp>[0]["docChangeAgent"];
    /** 战场进展汇总的假 Agent；不注入时用真实装配（打开汇总接口才会调用）。 */
    battlefieldSummaryAgent?: Parameters<typeof buildApp>[0]["battlefieldSummaryAgent"];
  } = {},
  researchService?: ResearchService,
): Promise<TestApp> {
  const database = `warmap_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
  await admin.query(`CREATE DATABASE ${database} TEMPLATE ${await migratedTemplateDatabase()}`);
  const pool = tolerateDroppedConnections(new Pool({
    connectionString: ADMIN_URL.replace(/\/postgres$/, `/${database}`),
    max: 5,
  }));
  const client = await pool.connect();
  await seedTestAccess(client);
  client.release();
  const env = { ...testEnv, ...seedOverrides };
  const { monthlyDraftAgent, monthlyNow, recordingDeps, monthlyReviewAgents, monthlyReviewRetryDelayMs, weeklyReviewAgent, weeklyReviewPeople, ...restRuntimeOptions } = runtimeOptions;
  const appRuntimeOptions = { backgroundPreflight: false, personalDistillationStream: noopDistillationStream, personalMemoryRecall: null, ...restRuntimeOptions };
  const monthlyPlans = monthlyDraftAgent
    ? createMonthlyPlanService({ pool, peopleDirectory: loadPeopleDirectory(env), company: createCompanyContext(env), agent: monthlyDraftAgent, now: monthlyNow })
    : undefined;
  const monthlyReviews = monthlyReviewAgents
    ? createMonthlyReviewService({ pool, peopleDirectory: loadPeopleDirectory(env), company: createCompanyContext(env), agents: monthlyReviewAgents, now: monthlyNow, retryDelayMs: monthlyReviewRetryDelayMs,
      personalDraft: { storageDir: env.conversationAttachmentStorageDir ?? DEFAULT_CONVERSATION_ATTACHMENT_STORAGE_DIR,
        agent: monthlyReviewAgents.personal ?? { async generate() { return { candidate: {
          overall: { text: "缺少材料", sources: [] }, judgments: { text: "缺少材料", sources: [] },
          nextFocus: { text: "缺少材料", sources: [] }, escalations: { text: "", sources: [] },
        } }; } } } })
    : undefined;
  const weeklyReviews = weeklyReviewAgent
    ? createWeeklyReviewService({ pool, agent: weeklyReviewAgent, now: monthlyNow, retryDelayMs: 0,
      people: weeklyReviewPeople ?? (() => loadPeopleDirectory(env).searchPeople(undefined).filter((person) => person.roles.includes("dri") || person.roles.includes("participant")).map((person) => person.personId)) })
    : undefined;
  const recordings = recordingDeps
    ? createMeetingRecordingService({ pool, storageDir: env.recordingStorageDir ?? DEFAULT_RECORDING_STORAGE_DIR, peopleDirectory: loadPeopleDirectory(env), publicOrigin: env.publicOrigin, deps: recordingDeps })
    : undefined;
  const app = await buildApp({ pool, env, conversationRuntime, researchService, monthlyPlanService: monthlyPlans, monthlyReviewService: monthlyReviews, weeklyReviewService: weeklyReviews, recordingService: recordings, now: monthlyNow,
    threadIntroAgent: { async generate(input) { return { message: `${input.inviter}邀请${input.newcomers.join("、")}加入「${input.title}」，请查看对象进展。` }; } },
    taskAcceptanceAgent: { async draft() { throw new Error("测试里没有模型"); } },
    ...appRuntimeOptions });
  const apps = [app];
  return {
    app,
    pool,
    monthlyPlans,
    monthlyReviews,
    weeklyReviews,
    recordings,
    publicOrigin: env.publicOrigin,
    env,
    loginCookie: () => loginAs(app, TEST_CEO),
    memberCookie: () => loginAs(app, TEST_MEMBER),
    /** 真实 DRI 导入的 pending Issue：目标路由只消费持久对象，测试不再依赖 fixture 表。 */
    createIssue: async (overrides: Record<string, unknown> = {}) => {
      const payload = {
        externalId: `test-issue-${randomUUID()}`,
        submitterPersonId: "person-fixture-002",
        title: "测试议题：是否调整渠道投入",
        whyNow: "渠道窗口将在六月关闭",
        sourceRef: "dri://test/issue",
        location: { level: "battlefield", battlefieldId: "growth" },
        ...overrides,
      };
      const res = await app.inject({
        method: "POST",
        url: "/api/dri/issues",
        headers: { authorization: `Bearer ${testEnv.driServiceToken}` },
        payload,
      });
      if (res.statusCode !== 201) throw new Error(`createIssue failed: ${res.statusCode} ${res.body}`);
      return (res.json() as { cards: { objectRef: { id: string }; id: string; version: number }[] }).cards[0];
    },
    conversationState: async (scope) => {
      const conversation = await pool.query(
        "SELECT id, pi_session_id, runtime_entries, recreated_at, runtime_warning FROM conversations WHERE scope = $1",
        [scope],
      );
      if (!conversation.rows[0]) return { runtimeEntries: [], messages: [] };
      const messages = await pool.query(
        "SELECT role, content, references_snapshot FROM conversation_messages WHERE conversation_id = $1 ORDER BY sequence",
        [conversation.rows[0].id],
      );
      return {
        runtimeEntries: conversation.rows[0].runtime_entries,
        piSessionId: conversation.rows[0].pi_session_id,
        recreatedAt: conversation.rows[0].recreated_at,
        runtimeWarning: conversation.rows[0].runtime_warning,
        messages: messages.rows,
      };
    },
    setRuntimeEntries: async (scope, entries) => {
      await pool.query("UPDATE conversations SET runtime_entries = $2::jsonb WHERE scope = $1", [scope, JSON.stringify(entries)]);
    },
    agentRuns: async () => (await pool.query("SELECT * FROM agent_runs ORDER BY started_at, id")).rows,
    sql: async (text, params) => (await pool.query(text, params)).rows,
    restart: async (runtime) => {
      const restarted = await buildApp({ pool, env, conversationRuntime: runtime, researchService, monthlyPlanService: monthlyPlans, monthlyReviewService: monthlyReviews, recordingService: recordings, now: monthlyNow, ...appRuntimeOptions });
      apps.push(restarted);
      return restarted;
    },
    close: async () => {
      await monthlyReviews?.idle();
      await weeklyReviews?.idle();
      await Promise.all(apps.map((instance) => instance.close()));
      await pool.end();
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    },
  };
}
