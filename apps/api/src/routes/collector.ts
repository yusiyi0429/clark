import type { FastifyReply, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import { CollectorConsentResponse, CollectorHeartbeatRequest, CollectorHeartbeatResponse, CollectorReportRequest, CollectorReportResponse,
  CollectorStatusResponse, UpdateCollectorConsentRequest } from "@warmap/contracts";
import { COLLECTOR_FILES, readCollectorFile, readCollectorStatus, recordHeartbeat, recordReport, type CollectorFileName, type CollectorIdentity } from "../collector.js";
import { collectorConsentGranted, readCollectorConsent, updateCollectorConsent } from "../collectorDistill.js";
import { authenticatePersonalToken } from "../personalTokens.js";
import type { AppInstance, RouteContext } from "./shared.js";

/**
 * 本机采集器上报：只认 client=collector 的个人令牌；数据一律记在令牌本人名下。鉴权先于请求体校验。
 * 本人没同意采集（D-02）时工作段一律不收（403，本机留着下次再发），心跳照收。同意开关在 /api/me/collector/consent。
 */
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
    async (req) => recordHeartbeat(pool, identities.get(req)!, req.body, ctx.now()));

  app.post("/api/collector/reports", { preValidation: requireCollector, schema: { body: CollectorReportRequest, response: { 200: CollectorReportResponse } } }, async (req, reply) => {
    if (req.body.items.length && !await collectorConsentGranted(q, identities.get(req)!.personId)) {
      return fail(reply, 403, "COLLECTOR_CONSENT_REQUIRED", "还没有同意采集，请在天枢的上手流程里打开采集");
    }
    const result = await recordReport(pool, identities.get(req)!, req.body, ctx.now());
    if (!result.ok) return fail(reply, 400, "INVALID_INPUT", result.message);
    const { ok: _ok, ...body } = result;
    return body;
  });

  app.get("/api/me/collector/status", { preHandler: ctx.requirePerson, schema: { response: { 200: CollectorStatusResponse } } },
    async (req) => readCollectorStatus(q, req.person!.personId));

  // 一行安装命令（上手流程「安装采集器」）：脚本与 Python 文件公开下载，不含令牌；令牌只在本人复制的命令参数里。
  const sendFile = async (reply: FastifyReply, name: CollectorFileName) => reply
    .header("Cache-Control", "no-cache").type("text/plain; charset=utf-8").send(await readCollectorFile(name));
  app.get("/api/collector/install.ps1", async (_req, reply) => sendFile(reply, "install-windows.ps1"));
  app.get("/api/collector/install.sh", async (_req, reply) => sendFile(reply, "install-macos.sh"));
  app.get("/api/collector/files/:name", { schema: { params: Type.Object({ name: Type.String({ maxLength: 40 }) }) } }, async (req, reply) => {
    const name = req.params.name as CollectorFileName;
    if (!name.endsWith(".py") || !COLLECTOR_FILES.includes(name)) return fail(reply, 404, "NOT_FOUND", "没有这个文件");
    return sendFile(reply, name);
  });

  app.get("/api/me/collector/consent", { preHandler: ctx.requirePerson, schema: { response: { 200: CollectorConsentResponse } } },
    async (req) => ({ consent: await readCollectorConsent(q, req.person!.personId) }));
  app.put("/api/me/collector/consent", { preHandler: ctx.requirePerson, schema: { body: UpdateCollectorConsentRequest, response: { 200: CollectorConsentResponse } } },
    async (req) => ({ consent: await updateCollectorConsent(pool, req.person!.personId, req.body.granted, ctx.now()) }));
}
