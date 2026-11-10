import { Value } from "@sinclair/typebox/value";
import type { FastifyReply } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import {
  NEXUS_DRI_CONFIRMATIONS_PATH, NEXUS_DRI_MAX_BODY_BYTES, NEXUS_DRI_REQUESTS_PATH,
  NexusConfirmationDecisionRequest, NexusConfirmationListResponse, NexusConfirmationParams,
  NexusDriConfirmationParams, NexusDriReceiptParams, NexusDriReceiptQuery, NexusDriRequest,
  type TNexusConfirmationDecisionResponse, type TNexusDriConfirmationRecord, type TNexusDriReceipt,
} from "@warmap/contracts";
import type { NexusDri } from "../nexusDri.js";
import type { AppInstance, RouteContext } from "./shared.js";

/**
 * Nexus → DRI 确认的接口（契约 nexusDri.ts）。
 * - Nexus 调的三个（Bearer NEXUS_DRI_SERVICE_TOKEN，不走浏览器会话，不在公开 OpenAPI 里）：没配凭据时不注册，一律 404。
 *   接收接口要拿到正文原文（指纹按整份请求算，不能让 schema 校验把多出来的字段去掉），所以单独注册一个把 JSON 当字符串收的解析器。
 * - 本人这一侧的两个一直注册（没配时列表为空）。
 */
export function registerNexusDriRoutes(app: AppInstance, ctx: RouteContext, nexusDri: NexusDri): void {
  const { env, fail, invalidInput, requirePerson, requireServiceToken } = ctx;

  app.get(
    "/api/me/nexus-confirmations",
    { preHandler: requirePerson, schema: { response: { 200: NexusConfirmationListResponse } } },
    async (req) => ({ items: await nexusDri.listFor(req.person!.personId) }),
  );
  app.post(
    "/api/me/nexus-confirmations/:id/decision",
    { preHandler: requirePerson, schema: { params: NexusConfirmationParams, body: NexusConfirmationDecisionRequest } },
    async (req, reply): Promise<TNexusConfirmationDecisionResponse | FastifyReply> => {
      const result = await nexusDri.decide(req.person!.personId, req.params.id, req.body);
      return "error" in result ? fail(reply, result.error.status, result.error.code, result.error.message) : result;
    },
  );

  if (!env.nexusDri) return;
  const onRequest = requireServiceToken(env.nexusDri.serviceToken);
  void app.register(async (plugin) => {
    plugin.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
    const scope = plugin.withTypeProvider<TypeBoxTypeProvider>();

    scope.post(
      NEXUS_DRI_REQUESTS_PATH,
      { onRequest, bodyLimit: NEXUS_DRI_MAX_BODY_BYTES },
      async (req, reply): Promise<TNexusDriReceipt | FastifyReply> => {
        let request: unknown;
        try {
          request = JSON.parse(req.body as string);
        } catch {
          return fail(reply, 400, "INVALID_INPUT", "正文不是合法 JSON");
        }
        if (!Value.Check(NexusDriRequest, request)) return invalidInput(reply, NexusDriRequest, request);
        const key = req.headers["idempotency-key"];
        const result = await nexusDri.receive(request, typeof key === "string" ? key : undefined);
        return "error" in result ? fail(reply, result.error.status, result.error.code, result.error.message) : result.receipt;
      },
    );
    scope.get(
      `${NEXUS_DRI_REQUESTS_PATH}/:requestId/receipt`,
      { onRequest, schema: { params: NexusDriReceiptParams, querystring: NexusDriReceiptQuery } },
      async (req, reply): Promise<TNexusDriReceipt | FastifyReply> =>
        (await nexusDri.readReceipt(req.params.requestId, req.query.revision)) ?? fail(reply, 404, "RECEIPT_NOT_FOUND", "没有收到过这一版"),
    );
    scope.get(
      `${NEXUS_DRI_CONFIRMATIONS_PATH}/:confirmationRef`,
      { onRequest, schema: { params: NexusDriConfirmationParams } },
      async (req, reply): Promise<TNexusDriConfirmationRecord | FastifyReply> =>
        (await nexusDri.readConfirmation(req.params.confirmationRef)) ?? fail(reply, 404, "CONFIRMATION_NOT_FOUND", "没有这条确认记录"),
    );
  });
}
