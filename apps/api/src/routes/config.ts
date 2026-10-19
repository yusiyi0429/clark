import type { FastifyReply } from "fastify";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  AssignBattlefieldIssueRequest,
  CreateBattlefieldRequest,
  PatchBattlefieldRequest,
  CreateCapabilityRequest,
  PatchCapabilityRequest,
  PatchStrategyConfigRequest,
  CreateCeoIssueRequest,
  CreateConfigMeetingRequest,
  CreateMissionRequest,
  CompanyRadarSettings,
  PutCompanyRadarRequest,
  type TBattlefieldManagementResponse,
  type TCapabilityManagementResponse,
  type TCardCollection,
  type TCreateConfigMeetingRequest,
  type TMissionManagementResponse,
} from "@warmap/contracts";
import { deleteBattlefield, listBattlefieldCards, projectBattlefieldManagement, registerBattlefield, updateBattlefield } from "../battlefields.js";
import { listCapabilityCards, listCapabilityRows, registerCapability, updateCapability, validateSupportRefs } from "../capabilities.js";
import { assignIssueBattlefield, createCeoIssue, unassignIssueBattlefield } from "../issues.js";
import { createConfigMeeting } from "../meetings.js";
import { listMissionCards, listMissionRows, registerMission, validateMissionRelations } from "../missions.js";
import { missionCardParticipants } from "../missionRounds.js";
import { companyPeriod } from "../monthlyPlans.js";
import { isKnownOwner, personDisplayNames } from "../people.js";
import { getStrategyConfig, updateStrategyConfig } from "../strategy.js";
import { MAX_MATERIAL_BATCH_BYTES, MAX_MATERIAL_FILES, MAX_MATERIAL_FILE_BYTES, MaterialParseError, cleanupMaterialTemp, parseMaterialBatch } from "../materialParser.js";
import { readCompanyRadarSettings, saveCompanyRadarSettings } from "../radarSettings.js";
import { idParams, type AppInstance, type RouteContext } from "./shared.js";

export function registerConfigRoutes(app: AppInstance, ctx: RouteContext): void {
  const { pool, q, env, fail, requireCEO, peopleDirectory, preflight, research, radar, materialStorageDir, materialMultipartLimitError, now } = ctx;

function parseConfigMeetingFields(fields: Map<string, string>): { value: TCreateConfigMeetingRequest } | { error: string } {
  const body: Record<string, unknown> = {};
  for (const key of ["title", "scheduledAt", "leadDriId"] as const) {
    const value = fields.get(key)?.trim();
    if (!value) return { error: `${key} 必填` };
    body[key] = value;
  }
  // 结束时间可选：省略或空串交给 createConfigMeeting 按开始后 60 分钟补齐
  const endsAt = fields.get("endsAt")?.trim();
  if (endsAt) body.endsAt = endsAt;
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
  app.get("/api/config/strategy", { preHandler: requireCEO }, async () => getStrategyConfig(q));
  // 公司雷达设置（ADR-0021）：CEO 在同一个编辑器里改手工方向与目录里的发布方；保存不触发公司扫描。
  app.get(
    "/api/config/radar",
    { preHandler: requireCEO, schema: { response: { 200: CompanyRadarSettings } } },
    async () => readCompanyRadarSettings(q, radar.providerStatus.web),
  );
  app.put(
    "/api/config/radar",
    { preHandler: requireCEO, schema: { body: PutCompanyRadarRequest, response: { 200: CompanyRadarSettings } } },
    async (req, reply) => {
      const saved = await saveCompanyRadarSettings(pool, req.body);
      if (!saved.ok) return fail(reply, saved.status, saved.code, saved.message, saved.fieldErrors ? { fieldErrors: saved.fieldErrors } : undefined);
      return readCompanyRadarSettings(q, radar.providerStatus.web);
    },
  );
  app.patch(
    "/api/config/strategy",
    { preHandler: requireCEO, schema: { body: PatchStrategyConfigRequest } },
    async (req) => updateStrategyConfig(q, req.body.ltco),
  );
  app.post(
    "/api/config/battlefields",
    { preHandler: requireCEO, schema: { body: CreateBattlefieldRequest } },
    async (req, reply): Promise<FastifyReply> => {
      const ownerNames = personDisplayNames(peopleDirectory);
      if (!isKnownOwner(ownerNames, req.body.ownerId)) return fail(reply, 400, "INVALID_OWNER", "负责人必须命中 company-people.v1");
      const result = await registerBattlefield(q, req.body);
      if (!result.ok) return fail(reply, result.status, result.code, result.message);
      const cards = await listBattlefieldCards(q, companyPeriod(now()), ownerNames);
      return reply.status(201).send({ cards: cards.filter((card) => card.objectRef.id === result.id) });
    },
  );
  app.post(
    "/api/config/capabilities",
    { preHandler: requireCEO, schema: { body: CreateCapabilityRequest } },
    async (req, reply): Promise<FastifyReply> => {
      if (!isKnownOwner(personDisplayNames(peopleDirectory), req.body.ownerId)) return fail(reply, 400, "INVALID_OWNER", "负责人必须命中 company-people.v1");
      const refs = req.body.supportRefs ?? [];
      const refsValid = await validateSupportRefs(q, refs);
      if (!refsValid.ok) return fail(reply, 400, refsValid.code, refsValid.message);
      const result = await registerCapability(q, req.body);
      if (!result.ok) return fail(reply, result.status, result.code, result.message);
      const cards = (await listCapabilityCards(q)).filter((card) => card.objectRef.id === result.id);
      return reply.status(201).send({ cards });
    },
  );
  // 能力管理页：轻量列表投影，只读注册表行。
  app.get(
    "/api/config/capabilities",
    { preHandler: requireCEO },
    async (): Promise<TCapabilityManagementResponse> => ({ capabilities: await listCapabilityRows(q, personDisplayNames(peopleDirectory)) }),
  );
  app.patch(
    "/api/config/capabilities/:id",
    { preHandler: requireCEO, schema: { params: idParams, body: PatchCapabilityRequest } },
    async (req, reply): Promise<FastifyReply> => {
      if (!isKnownOwner(personDisplayNames(peopleDirectory), req.body.ownerId)) return fail(reply, 400, "INVALID_OWNER", "负责人必须命中 company-people.v1");
      if (req.body.supportRefs !== undefined) {
        const refsValid = await validateSupportRefs(q, req.body.supportRefs);
        if (!refsValid.ok) return fail(reply, 400, refsValid.code, refsValid.message);
      }
      const result = await updateCapability(q, req.params.id, req.body);
      if (!result.ok) return fail(reply, result.status, result.code, result.message);
      const cards = (await listCapabilityCards(q)).filter((card) => card.objectRef.id === result.id);
      return reply.status(200).send({ cards });
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
        const result = await createConfigMeeting(pool, peopleDirectory, preflight, env.sessionSecret, {
          ...body.value,
          materials: parsed?.materials,
          materialStorageDir,
        }, ctx.threadIntroAgent);
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
  // Mission 配置页：一次返回按 period/能力域/code 排序的完整正面集合，无业务写入。
  app.get(
    "/api/config/missions",
    { preHandler: requireCEO },
    async (req): Promise<TMissionManagementResponse> => ({
      missions: (await listMissionCards(q, env.sessionSecret, personDisplayNames(peopleDirectory), undefined, req.person!)).map(
        (card) => card.payload as TMissionManagementResponse["missions"][number],
      ),
    }),
  );
  // 首次导入没有既有版本可锚，走确定性 CEO 配置写入；之后编辑走 mission.edit opaque Action。
  app.post(
    "/api/config/missions",
    { preHandler: requireCEO, schema: { body: CreateMissionRequest } },
    async (req, reply): Promise<FastifyReply> => {
      const ownerNames = personDisplayNames(peopleDirectory);
      const refsValid = await validateMissionRelations(q, ownerNames, req.body);
      if (refsValid) return fail(reply, 400, refsValid.code, refsValid.message);
      const result = await registerMission(q, req.body);
      if (!result.ok) return fail(reply, result.status, result.code, result.message);
      const cards = (await listMissionCards(q, env.sessionSecret, ownerNames)).filter((card) => card.objectRef.id === result.id);
      return reply.status(201).send({ cards });
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
  app.patch(
    "/api/config/battlefields/:id",
    { preHandler: requireCEO, schema: { params: idParams, body: PatchBattlefieldRequest } },
    async (req, reply): Promise<FastifyReply> => {
      const ownerNames = personDisplayNames(peopleDirectory);
      if (!isKnownOwner(ownerNames, req.body.ownerId)) return fail(reply, 400, "INVALID_OWNER", "负责人必须命中 company-people.v1");
      if (req.body.participantIds?.some((id) => !ownerNames.has(id))) return fail(reply, 400, "INVALID_PARTICIPANT", "参与者必须命中 company-people.v1");
      const result = await updateBattlefield(pool, req.params.id, req.body);
      if (!result.ok) return fail(reply, result.status, result.code, result.message);
      const cards = (await listBattlefieldCards(q, companyPeriod(now()), ownerNames)).filter((card) => card.objectRef.id === result.id);
      return reply.status(200).send({ cards });
    },
  );

  // 战场管理页：一次返回整页展示数据，无业务写入。
  app.get(
    "/api/config/battlefields",
    { preHandler: requireCEO },
    async (): Promise<TBattlefieldManagementResponse> => {
      const people = peopleDirectory.searchPeople(undefined);
      // 推算按下一次起草的月份：最新一份月度计划（月底签发下月计划时就是下月）。
      const period = ((await q("SELECT max(period) AS period FROM monthly_plans")).rows[0]?.period as string | null) ?? companyPeriod(now());
      return projectBattlefieldManagement(q, personDisplayNames(peopleDirectory), (id) => missionCardParticipants(q, people, id, period));
    },
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
