import { timingSafeEqual } from "node:crypto";
import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest, RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerDefault } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { Pool } from "pg";
import type { TApiError, TCardCollection } from "@warmap/contracts";
import { SESSION_COOKIE, parseCookies, readSessionToken } from "../session.js";
import { canSwitchView, canUseMemberView, currentSessionVersion, roleOf, type SessionRole } from "../memberAccess.js";
import type { PeopleDirectory } from "../peopleDirectory.js";
import type { CompanyContext } from "../companyContext.js";
import type { ConversationRuntime } from "../conversations.js";
import type { ConversationCompaction } from "../conversationCompaction.js";
import type { DriExporter, MeetingActionOutcome, Query } from "../meetingStore.js";
import type { PreflightAgent } from "../meetingPreflight.js";
import type { OntologyUpdater, PostMeetingAgent, TranscriptImportResult } from "../outcome.js";
import type { RadarService } from "../radar.js";
import type { PersonalRadarService } from "../personalRadar.js";
import type { ResearchService } from "../research.js";
import type { MonthlyPlanService } from "../monthlyDraft.js";
import type { MonthlyReviewService } from "../monthlyReviewService.js";
import type { WeeklyReviewService } from "../weeklyReviewService.js";
import type { WeeklyReviewWorldSync } from "../weeklyReviewWorld.js";
import type { WorldPeriodGoalService } from "../worldPeriodGoals.js";
import type { MeetingRecordingService } from "../meetingRecordings.js";
import type { VoiceprintDeps } from "../voiceprints.js";
import type { DictationDeps } from "../dictation.js";
import type { RealtimeSessionDeps } from "../tencentAsrRealtime.js";
import type { DictationPolishDeps } from "../dictationPolish.js";
import type { ThreadIntroAgent } from "../threadIntro.js";
import type { MissionCardDraftAgent } from "../missionCardDraftAgent.js";
import type { TaskAcceptanceAgent } from "../taskAcceptanceDraft.js";
import type { AppEnv } from "../app.js";
import type { WorldReader } from "../worldReader.js";
import type { PersonalMemory } from "../personalMemory.js";
import type { PersonalDistillation } from "../personalDistillation.js";
import type { CollectionAgent } from "../collectionAgent.js";
import type { CollectionDeps } from "../collections.js";

export type AppInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>;

/** 已登录的人：cookie 的当前视角须仍被 seed 中的身份允许。 */
export type SessionPerson = { personId: string; role: SessionRole; canSwitchView: boolean; sessionVersion: number };

declare module "fastify" {
  interface FastifyRequest {
    /** requirePerson / requireCEO 通过后挂上当前的人；未经闸门的路由为 null。 */
    person: SessionPerson | null;
  }
}

/** preHandler 闸门：放行时不返回，拒绝时返回已发送的 reply。 */
export type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void>;

export type RequestContext = { runId?: string; scope?: string; objectRef?: string; actionType?: string; errorCode?: string };
export type MaterialLimit = { status: 413 | 400; code: string; message: string };

/** buildApp 装配出的依赖与请求边界助手；路由插件只依赖这里，不反向依赖 app.ts 的运行实例。 */
export type RouteContext = {
  /** 本体（tkos.world）只读集成；未配置时 enabled=false、snapshot 恒为 null。 */
  world?: WorldReader;
  /** 第二个只读实例（词元云集 TK scope）；没配时为空。 */
  worldTk?: WorldReader;
  pool: Pool;
  q: Query;
  env: AppEnv;
  /** 人员目录：登录、会话角色、本人隔离、人名解析只看它。 */
  peopleDirectory: PeopleDirectory;
  /** 后台起草读本体公司事实的入口（只读）。 */
  company: CompanyContext;
  /** 本人私有的个人记忆（只有本人可见，不写进本体）。 */
  personalMemory: PersonalMemory;
  /** 个人记忆的后台提炼队列。 */
  personalDistillation: PersonalDistillation;
  preflight: PreflightAgent;
  outcome: PostMeetingAgent;
  runtime: ConversationRuntime;
  radar: RadarService;
  personalRadar: PersonalRadarService;
  research: ResearchService;
  driExporter?: DriExporter;
  ontologyUpdater: OntologyUpdater;
  monthlyPlanService?: MonthlyPlanService;
  monthlyReviewService?: MonthlyReviewService;
  /** 周复盘生成；缺省时重新生成返回 503（server.ts 注入真实服务）。 */
  weeklyReviewService?: WeeklyReviewService;
  /** 周复盘提交后写本体；本体没配或不写时为空，提交照常，world_sync_status 留 pending。 */
  weeklyReviewWorld?: WeeklyReviewWorldSync;
  /** 签发月度计划后代 CEO 确认本体周期目标；本体没配或不写时为空。 */
  worldPeriodGoals?: WorldPeriodGoalService;
  /** ③ 信息收集：起草 Agent 与服务依赖（路由和对话入口共用）。 */
  collections: { agent: CollectionAgent; deps: CollectionDeps };
  recordings: MeetingRecordingService;
  voiceprints: VoiceprintDeps;
  dictation: DictationDeps;
  /** 实时听写签发（腾讯实时识别 URL 签名）的配置与真实时钟。 */
  dictationRealtime: RealtimeSessionDeps;
  /** 听写后的快速整理（火山方舟）。 */
  dictationPolish: DictationPolishDeps;
  threadIntroAgent: ThreadIntroAgent;
  missionCardDraftAgent: MissionCardDraftAgent;
  /** 验收弹窗里我的 Agent 起草（只读）；测试注入假实现。 */
  taskAcceptanceAgent: TaskAcceptanceAgent;
  materialStorageDir: string;
  conversationAttachmentStorageDir: string;
  conversationTurnTimeoutMs: number;
  conversationStallTimeoutMs: number;
  conversationHeartbeatMs: number;
  /** 对话历史的后台压缩（conversationCompaction.ts）：轮前换入就绪的快照，轮后需要时在后台压缩。 */
  conversationCompaction?: ConversationCompaction;
  maxTranscriptBytes: number;
  now: () => Date;
  requestContext: WeakMap<FastifyRequest, RequestContext>;
  fail: (reply: FastifyReply, status: number, code: string, message: string, extra?: Partial<TApiError>) => FastifyReply;
  requireCEO: Guard;
  requirePerson: Guard;
  readSession: (req: FastifyRequest) => Promise<SessionPerson | null>;
  requireServiceToken: (expected: string) => (req: FastifyRequest, reply: FastifyReply, done: () => void) => void;
  invalidInput: (reply: FastifyReply, schema: TSchema, input: unknown) => FastifyReply;
  respond: (reply: FastifyReply, outcome: MeetingActionOutcome) => TCardCollection | FastifyReply;
  respondTranscriptImport: (reply: FastifyReply, result: TranscriptImportResult) => TCardCollection | FastifyReply;
  materialMultipartLimitError: (error: unknown, tooLarge: MaterialLimit, tooMany: MaterialLimit, truncated: MaterialLimit) => MaterialLimit | null;
};

export const idParams = Type.Object({ id: Type.String({ minLength: 1 }) }, { additionalProperties: false });

export function createFail(requestContext: WeakMap<FastifyRequest, RequestContext>) {
  return function fail(
    reply: FastifyReply,
    status: number,
    code: string,
    message: string,
    extra?: Partial<TApiError>,
  ): FastifyReply {
    requestContext.set(reply.request, { ...requestContext.get(reply.request), errorCode: code });
    return reply.status(status).send({ code, message, retryable: false, requestId: reply.request.id, ...extra });
  };
}

/**
 * 材料上传的 multipart 上限错误 → 深思熟虑的 4xx；返回 null 表示不是上限错误，调用方必须继续抛出（不吞解析/内部错误）。
 * - FST_REQ_FILE_TOO_LARGE（文件超过 fileSize）→ 413
 * - FST_FILES_LIMIT（文件份数超过 files）→ 调用方按语义给 413（主材料整批）或 400（补充材料恰好一份）
 * - ERR_STREAM_PREMATURE_CLOSE：files 上限触发的清理会销毁当前 part 流，常以此错误呈现（同族客户端错误）→ truncated 映射
 */
export function materialMultipartLimitError(
  error: unknown,
  tooLarge: MaterialLimit,
  tooMany: MaterialLimit,
  truncated: MaterialLimit,
): MaterialLimit | null {
  const code = (error as { code?: string }).code;
  if (code === "FST_REQ_FILE_TOO_LARGE") return tooLarge;
  if (code === "FST_FILES_LIMIT") return tooMany;
  if (code === "ERR_STREAM_PREMATURE_CLOSE") return truncated;
  return null;
}

/** 读会话：签名与有效期之外，人要还在 seed 里，凭据版本要与库里一致（口令重置后旧会话立即失效）。 */
export function createReadSession(env: AppEnv, q: Query, peopleDirectory: PeopleDirectory) {
  return async function readSession(req: FastifyRequest): Promise<SessionPerson | null> {
    const claims = readSessionToken(env.sessionSecret, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (!claims) return null;
    const person = peopleDirectory.searchPeople(undefined).find((p) => p.personId === claims.pid);
    if (!person) return null;
    if ((await currentSessionVersion(q, person.personId)) !== claims.v) return null;
    const role = claims.view ?? roleOf(person);
    if (role === "ceo" ? !person.roles.includes("ceo") : !canUseMemberView(person)) return null;
    return { personId: person.personId, role, canSwitchView: canSwitchView(person), sessionVersion: claims.v };
  };
}

/** CSRF 来源检查：正式地址，或本地开发额外列出的地址。 */
export function isAllowedOrigin(env: AppEnv, origin: string | undefined): boolean {
  return origin !== undefined && (origin === env.publicOrigin || (env.extraOrigins?.includes(origin) ?? false));
}

/** 浏览器请求边界：有效会话 + 写请求同源 Origin（CSRF）。 */
export function createRequirePerson(env: AppEnv, readSession: RouteContext["readSession"], fail: RouteContext["fail"]): Guard {
  return async function requirePerson(req, reply) {
    const person = await readSession(req);
    if (!person) return fail(reply, 401, "UNAUTHORIZED", "未登录");
    if (req.method !== "GET" && !isAllowedOrigin(env, req.headers.origin)) return fail(reply, 403, "ORIGIN_MISMATCH", "Origin 不符");
    req.person = person;
  };
}

/** CEO 专用：成员会话一律 403（不是 401，前端据此不回锁屏）。 */
export function createRequireCEO(requirePerson: Guard, fail: RouteContext["fail"]): Guard {
  return async function requireCEO(req, reply) {
    await requirePerson(req, reply);
    if (reply.sent) return reply;
    if (req.person?.role !== "ceo") return fail(reply, 403, "FORBIDDEN", "只有 CEO 可以访问");
  };
}

/** 服务身份边界：独立 bearer token，与 CEO session 不可互换。 */
export function createRequireServiceToken(fail: RouteContext["fail"]) {
  return function requireServiceToken(expected: string) {
    return (req: FastifyRequest, reply: FastifyReply, done: () => void): void => {
      const header = req.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      const a = Buffer.from(token);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        fail(reply, 401, "UNAUTHORIZED", "无效服务凭据");
        return;
      }
      done();
    };
  };
}

export function createInvalidInput(fail: RouteContext["fail"]) {
  return function invalidInput(reply: FastifyReply, schema: TSchema, input: unknown): FastifyReply {
    const fieldErrors: Record<string, string> = {};
    for (const error of Value.Errors(schema, input)) {
      fieldErrors[(error.path || "/").replace(/^\//, "") || "input"] = error.message;
    }
    return fail(reply, 400, "INVALID_INPUT", "输入校验失败", { fieldErrors });
  };
}

/** Action 结果 → HTTP：error 用统一 ApiError，version 冲突携带 latestCard，成功返回新 Card。 */
export function createRespond(fail: RouteContext["fail"]) {
  return function respond(reply: FastifyReply, outcome: MeetingActionOutcome): TCardCollection | FastifyReply {
    if ("error" in outcome) {
      return fail(reply, outcome.error.status, outcome.error.code, outcome.error.message, outcome.error.fieldErrors ? { fieldErrors: outcome.error.fieldErrors } : undefined);
    }
    if (outcome.conflict) {
      return fail(reply, 409, "VERSION_CONFLICT", "对象已被修改，请基于最新 Card 重试", { latestCard: outcome.latestCard });
    }
    return { cards: [outcome.card] };
  };
}

/** Transcript 导入结果 → HTTP；Web multipart 与 service API 共用同一个边界。 */
export function createRespondTranscriptImport(fail: RouteContext["fail"]) {
  return function respondTranscriptImport(reply: FastifyReply, result: TranscriptImportResult): TCardCollection | FastifyReply {
    if (result.status === 200) return { cards: [result.card] };
    return fail(reply, result.status, result.code, result.message, result.fieldErrors ? { fieldErrors: result.fieldErrors } : undefined);
  };
}
