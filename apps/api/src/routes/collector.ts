import type { FastifyReply, FastifyRequest } from "fastify";
import { CollectorHeartbeatRequest, CollectorHeartbeatResponse, CollectorReportRequest, CollectorReportResponse } from "@warmap/contracts";
import { recordHeartbeat, recordReport, type CollectorIdentity } from "../collector.js";
import { authenticatePersonalToken } from "../personalTokens.js";
import type { AppInstance, RouteContext } from "./shared.js";

/** 本机采集器上报：只认 client=collector 的个人令牌；数据一律记在令牌本人名下。鉴权先于请求体校验。 */
export function registerCollectorRoutes(app: AppInstance, ctx: RouteContext): void {
  const { pool, q, fail, companyMemory } = ctx;
  const identities = new WeakMap<FastifyRequest, CollectorIdentity>();
  const requireCollector = async (req: FastifyRequest, reply: FastifyReply) => {
    const identity = await authenticatePersonalToken(q, req.headers.authorization, ctx.env.sessionSecret, ctx.now(),
      (personId) => companyMemory.searchPeople(undefined).some((person) => person.personId === personId));
    if (!identity || identity.client !== "collector") return fail(reply, 401, "UNAUTHORIZED", "采集器令牌无效，请在天枢重新生成采集器令牌");
    identities.set(req, { personId: identity.personId, tokenId: identity.tokenId });
  };

  app.post("/api/collector/heartbeat", { preValidation: requireCollector, schema: { body: CollectorHeartbeatRequest, response: { 200: CollectorHeartbeatResponse } } },
    async (req) => recordHeartbeat(q, identities.get(req)!, req.body, ctx.now()));

  app.post("/api/collector/reports", { preValidation: requireCollector, schema: { body: CollectorReportRequest, response: { 200: CollectorReportResponse } } }, async (req, reply) => {
    const result = await recordReport(pool, identities.get(req)!, req.body, ctx.now());
    if (!result.ok) return fail(reply, 400, "INVALID_INPUT", result.message);
    const { ok: _ok, ...body } = result;
    return body;
  });
}
