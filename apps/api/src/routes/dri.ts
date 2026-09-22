import type { FastifyReply } from "fastify";
import { Type } from "@sinclair/typebox";
import {
  DriIssueImportRequest,
  DriMeetingImportRequest,
  DriMonthlyExportDeliveredRequest,
  DriMonthlyExportFailedRequest,
  DriMonthlyPlanFeedbackRequest,
  DriMonthlyPlanTodoFeedbackRequest,
  type TCardCollection,
} from "@warmap/contracts";
import { importDriIssue } from "../issues.js";
import { importDriMeeting } from "../meetings.js";
import { appendDriMonthlyFeedback, listMonthlyExports, mutateMonthlyExport } from "../monthlyPlans.js";
import { importTranscript } from "../outcome.js";
import { idParams, type AppInstance, type RouteContext } from "./shared.js";

export function registerDriRoutes(app: AppInstance, ctx: RouteContext): void {
  const { pool, q, env, fail, requireServiceToken, companyMemory, preflight, outcome, research, respondTranscriptImport, maxTranscriptBytes } = ctx;

  app.post(
    "/api/dri/meetings/:id/transcript",
    { onRequest: requireServiceToken(env.driServiceToken), bodyLimit: maxTranscriptBytes, schema: { params: idParams } },
    async (req, reply): Promise<TCardCollection | FastifyReply> =>
      respondTranscriptImport(reply, await importTranscript(pool, outcome, env.sessionSecret, req.params.id, req.body)),
  );

  app.post(
    "/api/dri/issues",
    // 服务身份用 onRequest：未鉴权调用先得到 401，而不是从 400 推断字段
    { onRequest: requireServiceToken(env.driServiceToken), schema: { body: DriIssueImportRequest } },
    async (req, reply) => {
      const result = await importDriIssue(pool, companyMemory, req.body, env.sessionSecret);
      if ("code" in result) {
        return fail(reply, result.status, result.code, result.message, result.fieldErrors ? { fieldErrors: result.fieldErrors } : undefined);
      }
      // 创建后立即展示，随后启动唯一深度预研；不阻塞响应，也不让 rejection 终止进程
      if (result.status === 201) {
        research.start(result.card.objectRef.id).catch((err) => console.error("research start failed", err));
      }
      return reply.status(result.status).send({ cards: [result.card] });
    },
  );
  app.post(
    "/api/dri/meetings",
    { onRequest: requireServiceToken(env.driServiceToken), schema: { body: DriMeetingImportRequest } },
    async (req, reply) => {
      const result = await importDriMeeting(pool, companyMemory, preflight, env.sessionSecret, req.body);
      if ("code" in result) {
        return fail(reply, result.status, result.code, result.message, result.fieldErrors ? { fieldErrors: result.fieldErrors } : undefined);
      }
      return reply.status(result.status).send({ cards: [result.card] });
    },
  );
  // DRI 叙述性 feedback：只追加到同一个 MonthlyPlan，不修改 todo 执行状态。
  app.post(
    "/api/dri/monthly-feedback",
    { onRequest: requireServiceToken(env.driServiceToken), schema: { body: DriMonthlyPlanFeedbackRequest } },
    async (req, reply) => {
      const result = await appendDriMonthlyFeedback(pool, companyMemory, req.body, env.sessionSecret);
      if ("code" in result) {
        return fail(reply, result.status, result.code, result.message, result.fieldErrors ? { fieldErrors: result.fieldErrors } : undefined);
      }
      return reply.status(result.status).send({ cards: [result.card] });
    },
  );
  app.post(
    "/api/dri/todo-feedback",
    { onRequest: requireServiceToken(env.driServiceToken), schema: { body: DriMonthlyPlanTodoFeedbackRequest } },
    async (req, reply) => {
      const result = await appendDriMonthlyFeedback(pool, companyMemory, req.body, env.sessionSecret);
      if ("code" in result) {
        return fail(reply, result.status, result.code, result.message, result.fieldErrors ? { fieldErrors: result.fieldErrors } : undefined);
      }
      return reply.status(result.status).send({ cards: [result.card] });
    },
  );

  // DRI 出站：普通 todo 的真实 pending_export/delivered/failed 状态；WarMap 不跟踪执行进度。
  const exportParams = Type.Object({ effectRef: Type.String({ minLength: 1 }) }, { additionalProperties: false });
  const exportStatusQuery = Type.Object(
    { status: Type.Optional(Type.Union([Type.Literal("pending_export"), Type.Literal("delivered"), Type.Literal("failed")])) },
    { additionalProperties: false },
  );
  app.get(
    "/api/dri/monthly-exports",
    { onRequest: requireServiceToken(env.driServiceToken), schema: { querystring: exportStatusQuery } },
    async (req) => ({ exports: await listMonthlyExports(q, req.query.status) }),
  );
  app.post(
    "/api/dri/monthly-exports/:effectRef/delivered",
    { onRequest: requireServiceToken(env.driServiceToken), schema: { params: exportParams, body: DriMonthlyExportDeliveredRequest } },
    async (req, reply) => {
      const result = await mutateMonthlyExport(pool, req.params.effectRef, { status: "delivered", exportRef: req.body.exportRef });
      return result.status === 200 ? { exports: result.exports } : fail(reply, result.status, result.code, result.message);
    },
  );
  app.post(
    "/api/dri/monthly-exports/:effectRef/failed",
    { onRequest: requireServiceToken(env.driServiceToken), schema: { params: exportParams, body: DriMonthlyExportFailedRequest } },
    async (req, reply) => {
      const result = await mutateMonthlyExport(pool, req.params.effectRef, { status: "failed", error: req.body.error });
      return result.status === 200 ? { exports: result.exports } : fail(reply, result.status, result.code, result.message);
    },
  );
  // failed → pending_export 只在显式再导出时发生，不自动重试
  app.post(
    "/api/dri/monthly-exports/:effectRef/re-export",
    { onRequest: requireServiceToken(env.driServiceToken), schema: { params: exportParams } },
    async (req, reply) => {
      const result = await mutateMonthlyExport(pool, req.params.effectRef, { status: "pending_export" });
      return result.status === 200 ? { exports: result.exports } : fail(reply, result.status, result.code, result.message);
    },
  );
}
