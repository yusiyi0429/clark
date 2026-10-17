import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
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
import { loadCompanyMemory } from "../src/companyMemory.js";
import { createMonthlyReviewService, type MonthlyReviewAgents, type MonthlyReviewService } from "../src/monthlyReviewService.js";
import type { OntologyUpdater, PostMeetingAgent } from "../src/outcome.js";
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

const ADMIN_URL = process.env.TEST_PG_URL ?? "postgres://postgres:postgres@localhost:54329/postgres";

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
    basis: "依据关联 Issue、ResearchDoc 与 CompanyMemory，只形成候选材料",
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

/** 建一个一次性空库跑迁移/集成测试，结束后删除。 */
export async function createTestDb(fn: (t: TestDb) => Promise<void>): Promise<void> {
  const database = `warmap_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
  await admin.query(`CREATE DATABASE ${database}`);
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
const FIXTURE_MEMORY_DIR = fileURLToPath(new URL("./fixtures/company-memory", import.meta.url));

export const testEnv: AppEnv = {
  sessionSecret: "test-session-secret",
  sessionMaxAgeSeconds: 60 * 60 * 8,
  publicOrigin: "https://warmap.local",
  driServiceToken: "dri-token-test",
  mcpServiceToken: "mcp-token-test",
  companyMemorySeedDir: FIXTURE_MEMORY_DIR,
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
  restart: (runtime: ConversationRuntime) => Promise<FastifyInstance>;
  close: () => Promise<void>;
};

/** 每个用例一个独立数据库 + 已迁移 schema + 完整 app。可覆盖 CompanyMemory seed 路径。 */
const defaultConversationRuntime: ConversationRuntime = {
  async run(input) {
    input.emit({ type: "message", delta: "test reply" });
    return { assistantMessage: "test reply", runtimeEntries: input.runtimeEntries };
  },
};

export async function createTestApp(
  seedOverrides: Partial<Pick<AppEnv, "companyMemorySeedDir" | "companyPeopleSeed" | "materialStorageDir" | "conversationAttachmentStorageDir" | "recordingStorageDir" | "extraOrigins" | "companyName" | "missionCardDraftsDir" | "worldApiUrl" | "worldAgentToken" | "publicOrigin">> = {},
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
    materialAnnotationAgent?: MaterialAnnotationAgent;
    missionCardAnnotationAgent?: MissionCardAnnotationAgent;
    missionCardReviewAgent?: MissionCardReviewAgent;
    missionCardDraftAgent?: MissionCardDraftAgent;
    /** 送达通道的假 Agent；不注入时用真实装配（测试里不会被调用）。 */
    requestAgent?: RequestAgent;
    driExporter?: DriExporter;
    ontologyUpdater?: OntologyUpdater;
    monthlyDraftAgent?: MonthlyDraftAgent;
    monthlyNow?: () => Date;
    /** 月末复盘的假起草、评估、汇总 Agent；与 monthlyDraftAgent 共用 monthlyNow。 */
    monthlyReviewAgents?: MonthlyReviewAgents;
    monthlyReviewRetryDelayMs?: number;
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
  } = {},
  researchService?: ResearchService,
): Promise<TestApp> {
  const database = `warmap_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
  await admin.query(`CREATE DATABASE ${database}`);
  const pool = tolerateDroppedConnections(new Pool({
    connectionString: ADMIN_URL.replace(/\/postgres$/, `/${database}`),
    max: 5,
  }));
  const client = await pool.connect();
  await migrate(client);
  await seedTestAccess(client);
  client.release();
  const env = { ...testEnv, ...seedOverrides };
  const { monthlyDraftAgent, monthlyNow, recordingDeps, monthlyReviewAgents, monthlyReviewRetryDelayMs, ...restRuntimeOptions } = runtimeOptions;
  const appRuntimeOptions = { backgroundPreflight: false, ...restRuntimeOptions };
  const monthlyPlans = monthlyDraftAgent
    ? createMonthlyPlanService({ pool, companyMemory: loadCompanyMemory(env), agent: monthlyDraftAgent, now: monthlyNow })
    : undefined;
  const monthlyReviews = monthlyReviewAgents
    ? createMonthlyReviewService({ pool, companyMemory: loadCompanyMemory(env), agents: monthlyReviewAgents, now: monthlyNow, retryDelayMs: monthlyReviewRetryDelayMs,
      personalDraft: { storageDir: env.conversationAttachmentStorageDir ?? DEFAULT_CONVERSATION_ATTACHMENT_STORAGE_DIR,
        agent: monthlyReviewAgents.personal ?? { async generate() { return { candidate: {
          overall: { text: "缺少材料", sources: [] }, judgments: { text: "缺少材料", sources: [] },
          nextFocus: { text: "缺少材料", sources: [] }, escalations: { text: "", sources: [] },
        } }; } } } })
    : undefined;
  const recordings = recordingDeps
    ? createMeetingRecordingService({ pool, storageDir: env.recordingStorageDir ?? DEFAULT_RECORDING_STORAGE_DIR, companyMemory: loadCompanyMemory(env), deps: recordingDeps })
    : undefined;
  const app = await buildApp({ pool, env, conversationRuntime, researchService, monthlyPlanService: monthlyPlans, monthlyReviewService: monthlyReviews, recordingService: recordings, now: monthlyNow,
    threadIntroAgent: { async generate(input) { return { message: `${input.inviter}邀请${input.newcomers.join("、")}加入「${input.title}」，请查看对象进展。` }; } },
    taskAcceptanceAgent: { async draft() { throw new Error("测试里没有模型"); } },
    ...appRuntimeOptions });
  const apps = [app];
  return {
    app,
    pool,
    monthlyPlans,
    monthlyReviews,
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
      await Promise.all(apps.map((instance) => instance.close()));
      await pool.end();
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    },
  };
}
