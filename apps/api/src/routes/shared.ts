import { timingSafeEqual } from "node:crypto";
import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest, RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerDefault } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { Pool } from "pg";
import type { TApiError, TCardCollection } from "@warmap/contracts";
import { SESSION_COOKIE, parseCookies, verifySessionToken } from "../session.js";
import type { CompanyMemoryRepository } from "../companyMemory.js";
import type { ConversationRuntime } from "../conversations.js";
import type { DriExporter, MeetingActionOutcome, Query } from "../meetingStore.js";
import type { PreflightAgent } from "../meetingPreflight.js";
import type { PostMeetingAgent, TranscriptImportResult } from "../outcome.js";
import type { RadarService } from "../radar.js";
import type { ResearchService } from "../research.js";
import type { MonthlyPlanService } from "../monthlyDraft.js";
import type { AppEnv } from "../app.js";

export type AppInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>;

export type RequestContext = { runId?: string; scope?: string; objectRef?: string; actionType?: string; errorCode?: string };
export type MaterialLimit = { status: 413 | 400; code: string; message: string };

/** buildApp 装配出的依赖与请求边界助手；路由插件只依赖这里，不反向依赖 app.ts 的运行实例。 */
export type RouteContext = {
  pool: Pool;
  q: Query;
  env: AppEnv;
  companyMemory: CompanyMemoryRepository;
  preflight: PreflightAgent;
  outcome: PostMeetingAgent;
  runtime: ConversationRuntime;
  radar: RadarService;
  research: ResearchService;
  driExporter?: DriExporter;
  monthlyPlanService?: MonthlyPlanService;
  materialStorageDir: string;
  conversationAttachmentStorageDir: string;
  conversationTurnTimeoutMs: number;
  maxTranscriptBytes: number;
  now: () => Date;
  requestContext: WeakMap<FastifyRequest, RequestContext>;
  fail: (reply: FastifyReply, status: number, code: string, message: string, extra?: Partial<TApiError>) => FastifyReply;
  requireCEO: (req: FastifyRequest, reply: FastifyReply, done: () => void) => void;
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

/** CEO 浏览器写请求边界：session + 同源 Origin（CSRF）。 */
export function createRequireCEO(env: AppEnv, fail: RouteContext["fail"]) {
  return function requireCEO(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
    const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!verifySessionToken(env.sessionSecret, cookie)) {
      fail(reply, 401, "UNAUTHORIZED", "未登录");
      return;
    }
    if (req.method !== "GET" && req.headers.origin !== env.publicOrigin) {
      fail(reply, 403, "ORIGIN_MISMATCH", "Origin 不符");
      return;
    }
    done();
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
