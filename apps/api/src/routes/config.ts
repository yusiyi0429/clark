import type { FastifyReply } from "fastify";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  AssignBattlefieldIssueRequest,
  CreateBattlefieldRequest,
  CreateCapabilityRequest,
  CreateCeoIssueRequest,
  CreateConfigMeetingRequest,
  type TBattlefieldManagementResponse,
  type TCardCollection,
  type TCreateConfigMeetingRequest,
} from "@warmap/contracts";
import { deleteBattlefield, listBattlefieldCards, projectBattlefieldManagement, registerBattlefield } from "../battlefields.js";
import { listCapabilityCards, registerCapability } from "../capabilities.js";
import { assignIssueBattlefield, createCeoIssue, unassignIssueBattlefield } from "../issues.js";
import { createConfigMeeting } from "../meetings.js";
import { companyPeriod } from "../monthlyPlans.js";
import { MAX_MATERIAL_BATCH_BYTES, MAX_MATERIAL_FILES, MAX_MATERIAL_FILE_BYTES, MaterialParseError, cleanupMaterialTemp, parseMaterialBatch } from "../materialParser.js";
import { idParams, type AppInstance, type RouteContext } from "./shared.js";

export function registerConfigRoutes(app: AppInstance, ctx: RouteContext): void {
  const { pool, q, env, fail, requireCEO, companyMemory, preflight, research, materialStorageDir, materialMultipartLimitError, now } = ctx;

function parseConfigMeetingFields(fields: Map<string, string>): { value: TCreateConfigMeetingRequest } | { error: string } {
  const body: Record<string, unknown> = {};
  for (const key of ["title", "scheduledAt", "leadDriId"] as const) {
    const value = fields.get(key)?.trim();
    if (!value) return { error: `${key} 必填` };
    body[key] = value;
  }
  const issueIds = fields.get("issueIds");
  if (issueIds !== undefined && issueIds.trim() !== "") {
    let decoded: unknown;
    try {
      decoded = JSON.parse(issueIds);
    } catch {
      return { error: "issueIds 不是合法 JSON 数组" };
    }
    if (!Array.isArray(decoded) || decoded.some((id) => typeof id !== "string")) return { error: "issueIds 不是合法 JSON 数组" };
    body.issueIds = decoded;
  }
  const invalid = [...Value.Errors(CreateConfigMeetingRequest, body)][0];
  if (invalid) return { error: `字段 ${invalid.path.replace(/^\//, "") || "body"} 不合法` };
  return { value: body as TCreateConfigMeetingRequest };
}
  app.post(
    "/api/config/battlefields",
    { preHandler: requireCEO, schema: { body: CreateBattlefieldRequest } },
    async (req, reply): Promise<FastifyReply> => {
      const result = await registerBattlefield(q, req.body);
      if (!result.ok) return fail(reply, 409, result.code, result.message);
      const cards = await listBattlefieldCards(q, companyPeriod(now()));
      return reply.status(201).send({ cards: cards.filter((card) => card.objectRef.id === result.id) });
    },
  );
  app.post(
    "/api/config/capabilities",
    { preHandler: requireCEO, schema: { body: CreateCapabilityRequest } },
    async (req, reply): Promise<FastifyReply> => {
      const result = await registerCapability(q, req.body);
      if (!result.ok) return fail(reply, 409, result.code, result.message);
      const cards = (await listCapabilityCards(q)).filter((card) => card.objectRef.id === result.id);
      return reply.status(201).send({ cards });
    },
  );
  app.post(
    "/api/config/issues",
    { preHandler: requireCEO, schema: { body: CreateCeoIssueRequest } },
    async (req, reply): Promise<FastifyReply> => {
      const result = await createCeoIssue(pool, env.sessionSecret, req.body);
      if (result.status !== 201) {
        return fail(reply, result.status, result.code, result.message, result.fieldErrors ? { fieldErrors: result.fieldErrors } : undefined);
      }
      // 与其他 Issue 创建路径一致：立即启动唯一深度预研，不阻塞响应
      research.start(result.card.objectRef.id).catch((err) => console.error("research start failed", err));
      return reply.status(201).send({ cards: [result.card] });
    },
  );
  // 配置页建会：multipart（title/scheduledAt/leadDriId + 可选 issueIds JSON 字符串 + 可选 files[]），
  // 有材料时创建后先落材料再跑首次预审；无材料等价于原来的 JSON 建会。
  app.post(
    "/api/config/meetings",
    { preHandler: requireCEO, bodyLimit: 101 * 1024 * 1024 },
    async (req, reply): Promise<FastifyReply> => {
      let parsed: Awaited<ReturnType<typeof parseMaterialBatch>> | undefined;
      try {
        const fields = new Map<string, string>();
        const files: { filename: string; mimetype: string; buffer: Buffer }[] = [];
        let totalBytes = 0;
        for await (const part of req.parts({ limits: { fileSize: MAX_MATERIAL_FILE_BYTES, files: MAX_MATERIAL_FILES } })) {
          if (part.type === "file") {
            if (part.fieldname !== "files") return fail(reply, 400, "INVALID_MATERIAL", "multipart 只接受 files 文件字段");
            const buffer = await part.toBuffer();
            totalBytes += buffer.length;
            if (totalBytes > MAX_MATERIAL_BATCH_BYTES) return fail(reply, 413, "MATERIAL_BATCH_TOO_LARGE", "材料总大小超过 100 MiB");
            files.push({ filename: part.filename, mimetype: part.mimetype, buffer });
            continue;
          }
          if (typeof part.value !== "string") return fail(reply, 400, "INVALID_INPUT", `${part.fieldname} 不是文本字段`);
          fields.set(part.fieldname, part.value);
        }
        const body = parseConfigMeetingFields(fields);
        if ("error" in body) return fail(reply, 400, "INVALID_INPUT", body.error);
        if (files.length) parsed = await parseMaterialBatch(files);
        const result = await createConfigMeeting(pool, companyMemory, preflight, env.sessionSecret, {
          ...body.value,
          materials: parsed?.materials,
          materialStorageDir,
        });
        if ("error" in result) {
          return fail(reply, result.error.status, result.error.code, result.error.message, result.error.fieldErrors ? { fieldErrors: result.error.fieldErrors } : undefined);
        }
        return reply.status(201).send({ cards: [result.card] });
      } catch (error) {
        if (error instanceof MaterialParseError) return fail(reply, 400, error.code, error.message);
        const limited = materialMultipartLimitError(
          error,
          { status: 413, code: "MATERIAL_BATCH_TOO_LARGE", message: "材料文件或数量超出上限" },
          { status: 400, code: "MATERIAL_BATCH_TOO_LARGE", message: `每批最多 ${MAX_MATERIAL_FILES} 份材料文件` },
          { status: 400, code: "MATERIAL_BATCH_TOO_LARGE", message: `每批最多 ${MAX_MATERIAL_FILES} 份材料文件` },
        );
        if (limited) return fail(reply, limited.status, limited.code, limited.message);
        throw error;
      } finally {
        if (parsed) await cleanupMaterialTemp(parsed.directory);
      }
    },
  );
  app.delete(
    "/api/config/battlefields/:id",
    { preHandler: requireCEO, schema: { params: idParams } },
    async (req, reply): Promise<FastifyReply> => {
      const result = await deleteBattlefield(pool, req.params.id);
      if (!result.ok) return fail(reply, result.status, result.code, result.message);
      return reply.code(204).send();
    },
  );

  // 战场管理页：一次返回整页展示数据，无业务写入。
  app.get(
    "/api/config/battlefields",
    { preHandler: requireCEO },
    async (): Promise<TBattlefieldManagementResponse> => projectBattlefieldManagement(q),
  );

  // CEO 配置页的议题↔战场关联集合：确定性配置语义，不走 opaque-action。
  app.post(
    "/api/config/battlefields/:id/issues",
    { preHandler: requireCEO, schema: { params: idParams, body: AssignBattlefieldIssueRequest } },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      const result = await assignIssueBattlefield(pool, env.sessionSecret, req.params.id, req.body.issueId);
      return result.ok ? { cards: [result.card] } : fail(reply, result.status, result.code, result.message);
    },
  );
  app.delete(
    "/api/config/battlefields/:id/issues/:issueId",
    { preHandler: requireCEO, schema: { params: Type.Object({ id: Type.String({ minLength: 1 }), issueId: Type.String({ minLength: 1 }) }, { additionalProperties: false }) } },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      const result = await unassignIssueBattlefield(pool, env.sessionSecret, req.params.id, req.params.issueId);
      return result.ok ? { cards: [result.card] } : fail(reply, result.status, result.code, result.message);
    },
  );
}
