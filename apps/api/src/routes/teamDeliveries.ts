import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { FastifyRequest } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import {
  ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, attachmentKind, ReplyTeamDeliveryRequest, SendTeamDeliveryRequest, TeamDeliveryListQuery,
  TeamDeliveryListResponse, TeamDeliveryResponse, TeamDeliverySourcesResponse, TeamDeliveryTextResponse,
} from "@warmap/contracts";
import type { AppInstance, RouteContext } from "./shared.js";
import { isRealPerson } from "../people.js";
import { listTeamDeliveries, readTeamDelivery } from "../teamDeliveryInbox.js";
import * as team from "../teamDeliveries.js";

const uuid = Type.String({ format: "uuid" });
const id = Type.Object({ id: uuid });
const fileId = Type.Object({ id: uuid, attachmentId: uuid });
const recipientId = Type.Object({ id: uuid, personId: Type.String({ minLength: 1, maxLength: 100 }) });
const metadataBytes = 160 * 1024;

class TeamInputError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** JSON 与 multipart 的 payload 复用 Fastify 编译的同一个契约（含 UUID、日期时间与未知字段的约束）。 */
function checked<S extends TSchema>(req: FastifyRequest, schema: S, input: unknown): Static<S> {
  if (!input || typeof input !== "object" || Array.isArray(input) || !req.compileValidationSchema(schema, "body")(input)) {
    throw new TeamInputError(400, "INVALID_INPUT", "发件内容或收件人格式无效");
  }
  return input as Static<S>;
}

async function inputWithFiles<S extends TSchema>(req: FastifyRequest, schema: S) {
  const files: { filename: string; buffer: Buffer }[] = [];
  if (!req.isMultipart()) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) throw new TeamInputError(415, "UNSUPPORTED_MEDIA_TYPE", "请使用 JSON 或 multipart/form-data");
    return { payload: checked(req, schema, req.body), files };
  }

  // 先看到第 21 个文件头才能明确报数量超限；不要读取它的内容。
  const limits = { fileSize: ATTACHMENT_MAX_BYTES, files: ATTACHMENT_MAX_COUNT + 1, fields: 2, fieldSize: metadataBytes, parts: ATTACHMENT_MAX_COUNT + 3 };
  let payload: Static<S> | undefined;
  try {
    for await (const part of req.parts({ limits })) {
      if (part.type === "field") {
        if (part.valueTruncated || part.fieldnameTruncated) throw new TeamInputError(413, "PAYLOAD_TOO_LARGE", "发件内容过长");
        if (part.fieldname !== "payload" || payload || typeof part.value !== "string") throw new TeamInputError(400, "INVALID_INPUT", "需要一份 JSON 格式的 payload");
        let value: unknown;
        try { value = JSON.parse(part.value); }
        catch { throw new TeamInputError(400, "INVALID_INPUT", "payload 不是有效的 JSON"); }
        payload = checked(req, schema, value);
        continue;
      }
      if (!payload || part.fieldname !== "files") { part.file.resume(); throw new TeamInputError(400, "INVALID_INPUT", "请先上传 payload，再添加 files 文件"); }
      if (files.length >= ATTACHMENT_MAX_COUNT) { part.file.resume(); throw new TeamInputError(413, "TOO_MANY_ATTACHMENTS", "最多 20 个附件"); }
      const filename = part.filename.split(/[\\/]/).pop()?.trim() ?? "";
      if (!attachmentKind(filename)) { part.file.resume(); throw new TeamInputError(400, "UNSUPPORTED_ATTACHMENT", "附件格式不支持"); }
      const buffer = await part.toBuffer();
      if (part.file.truncated || buffer.length > ATTACHMENT_MAX_BYTES) throw new TeamInputError(413, "ATTACHMENT_TOO_LARGE", "每个文件最多 30 MB");
      if (!buffer.length) throw new TeamInputError(400, "EMPTY_ATTACHMENT", "不能发送空文件");
      files.push({ filename, buffer });
    }
  } catch (cause) {
    if (cause instanceof TeamInputError) throw cause;
    const code = (cause as { code?: string })?.code;
    if (code === "FST_REQ_FILE_TOO_LARGE") throw new TeamInputError(413, "ATTACHMENT_TOO_LARGE", "每个文件最多 30 MB");
    if (code === "FST_FILES_LIMIT" || code === "FST_PARTS_LIMIT") throw new TeamInputError(413, "TOO_MANY_ATTACHMENTS", "最多 20 个附件");
    throw new TeamInputError(400, "INVALID_MULTIPART", "上传没有完整收到，请重新选择文件");
  }
  if (!payload) throw new TeamInputError(400, "INVALID_INPUT", "缺少发件内容");
  return { payload, files };
}

export function registerTeamDeliveryRoutes(app: AppInstance, ctx: RouteContext): void {
  const deps = () => ({ pool: ctx.pool, q: ctx.q, storageDir: ctx.materialStorageDir, now: ctx.now,
    people: new Map(ctx.peopleDirectory.searchPeople(undefined).filter(isRealPerson).map((p) => [p.personId, p.displayName])) });
  void app.register(async (server) => {
    const scoped = server.withTypeProvider<TypeBoxTypeProvider>();
    scoped.addHook("preHandler", ctx.requirePerson);
    scoped.setErrorHandler((cause, _req, reply) => {
      if (cause instanceof TeamInputError || cause instanceof team.TeamDeliveryError) return ctx.fail(reply, cause.status, cause.code, cause.message);
      throw cause;
    });
    scoped.get("/api/me/team-deliveries", { schema: { querystring: TeamDeliveryListQuery, response: { 200: TeamDeliveryListResponse } } },
      async (req) => ({ items: await listTeamDeliveries(deps(), req.person!.personId, req.query.box) }));
    scoped.get("/api/me/team-delivery-sources", { schema: { response: { 200: TeamDeliverySourcesResponse } } },
      async (req) => ({ items: await team.listTeamDeliverySources(deps(), req.person!.personId) }));
    scoped.get("/api/me/team-deliveries/:id", { schema: { params: id, response: { 200: TeamDeliveryResponse } } }, async (req, reply) => {
      const delivery = await readTeamDelivery(deps(), req.person!.personId, req.params.id);
      return delivery ? { delivery } : ctx.fail(reply, 404, "NOT_FOUND", "这条来件不存在或不可见");
    });
    scoped.post("/api/me/team-deliveries", { schema: { response: { 200: TeamDeliveryResponse } } }, async (req) => {
      const { payload, files } = await inputWithFiles(req, SendTeamDeliveryRequest);
      return { delivery: await team.sendTeamDelivery(deps(), req.person!.personId, payload, files) };
    });
    scoped.post("/api/me/team-deliveries/:id/replies", { schema: { params: id, response: { 200: TeamDeliveryResponse } } }, async (req) => {
      const { payload, files } = await inputWithFiles(req, ReplyTeamDeliveryRequest);
      return { delivery: await team.replyTeamDelivery(deps(), req.person!.personId, req.params.id, payload, files) };
    });
    scoped.post("/api/me/team-deliveries/:id/recipients/:personId/retry", { schema: { params: recipientId, response: { 200: TeamDeliveryResponse } } },
      async (req) => ({ delivery: await team.retryTeamRecipient(deps(), req.person!.personId, req.params.id, req.params.personId) }));
    scoped.get("/api/me/team-deliveries/:id/attachments/:attachmentId", { schema: { params: fileId } }, async (req, reply) => {
      const found = await team.readTeamFile(deps(), req.person!.personId, req.params.id, req.params.attachmentId);
      if (!found) return ctx.fail(reply, 404, "NOT_FOUND", "这份文件不存在或不可读");
      return reply.type(found.mimeType).header("content-disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(found.fileName))
        .header("cache-control", "private, no-store").header("x-content-type-options", "nosniff").header("content-security-policy", "sandbox")
        .header("x-sha256", found.sha256).send(found.data);
    });
    scoped.get("/api/me/team-deliveries/:id/attachments/:attachmentId/text", { schema: { params: fileId, response: { 200: TeamDeliveryTextResponse } } }, async (req, reply) => {
      const result = await team.readTeamFileText(deps(), req.person!.personId, req.params.id, req.params.attachmentId);
      if (!result) return ctx.fail(reply, 404, "NOT_FOUND", "这份文件不存在或不可读");
      return reply.header("cache-control", "private, no-store").send(result);
    });
  });
}
