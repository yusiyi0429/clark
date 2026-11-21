import type { FastifyReply } from "fastify";
import { Type } from "@sinclair/typebox";
import { MeetingMinutesFetchResponse, MeetingMinutesLinkRequest, MeetingTranscriptQuery, type TCardCollection, type TMeetingTranscriptPage } from "@warmap/contracts";
import { MAX_MATERIAL_FILES, MAX_MATERIAL_FILE_BYTES, MaterialParseError, cleanupMaterialTemp, parseMaterialBatch, readStoredMaterial } from "../materialParser.js";
import { renderMaterialPreview } from "../materialPreview.js";
import { appendSupplementMaterial, replaceMeetingMaterials } from "../meetingMaterials.js";
import { getMeetingRow } from "../meetingStore.js";
import { attendeesOf } from "../meetingDecisionView.js";
import { canReadMeetingSource, leftPartnerMeeting } from "../partnerMeetings.js";
import { personDisplayNames } from "../people.js";
import { isActiveMember } from "../threads.js";
import { importTranscript } from "../outcome.js";
import { createTranscriptCandidate } from "../transcriptCandidate.js";
import { projectMemberMeetingCardFromCard } from "../memberCards.js";
import { idParams, type AppInstance, type RouteContext } from "./shared.js";
import { registerDecisionHistoryRoutes } from "./decisionHistory.js";

export function registerMeetingRoutes(app: AppInstance, ctx: RouteContext): void {
  const { pool, q, env, peopleDirectory, fail, requireCEO, requirePerson, outcome, materialStorageDir, materialMultipartLimitError, respond, respondTranscriptImport, maxTranscriptBytes } = ctx;
  // 议题有效历史（H05）只读接口：GET /api/issues/:id/history、GET /api/meetings/:id/history
  registerDecisionHistoryRoutes(app, ctx);

  // 逐字稿按发言段分页读：只给 CEO、主持人和实际参会的人（同成员 Card 的 attended）；其他人与不存在的会同一个 404，不泄露这场会。
  app.get(
    "/api/meetings/:id/transcript",
    { preHandler: requirePerson, schema: { params: idParams, querystring: MeetingTranscriptQuery } },
    async (req, reply): Promise<TMeetingTranscriptPage | FastifyReply> => {
      const person = req.person!;
      const meeting = await getMeetingRow(q, req.params.id);
      const allowed = meeting && (person.role === "ceo" || meeting.lead_dri_id === person.personId || attendeesOf(meeting).personIds.includes(person.personId));
      if (!allowed || meeting.status === "cancelled" || await leftPartnerMeeting(q,meeting.id,person.personId) ||
        !await canReadMeetingSource(q, app.meetingFollowThrough.minutes, meeting, person)) return fail(reply, 404, "NOT_FOUND", "会议不存在");
      const turns = meeting.transcript?.turns ?? [];
      const start = req.query.from === undefined ? 0 : turns.findIndex((turn) => turn.id === req.query.from);
      if (start < 0) return { turns: [], nextTurn: null, total: turns.length };
      const end = start + (req.query.limit ?? 200);
      const names = personDisplayNames(peopleDirectory);
      return {
        turns: turns.slice(start, end).map((turn) => ({ id: turn.id, speakerName: names.get(turn.speakerId) ?? "发言人", startedAt: turn.startedAt ?? null, text: turn.text })),
        nextTurn: turns[end]?.id ?? null,
        total: turns.length,
      };
    },
  );

  app.post(
    "/api/meetings/:id/transcript",
    { preHandler: requirePerson, schema: { params: idParams }, bodyLimit: maxTranscriptBytes * 2 },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      let buffer: Buffer;
      const hostId = req.person!.role === "ceo" ? undefined : req.person!.personId;
      if (hostId !== undefined && (await getMeetingRow(q, req.params.id))?.lead_dri_id !== hostId)
        return fail(reply, 404, "MEETING_NOT_FOUND", "Meeting 不存在");
      try {
        const upload = await req.file({ limits: { fileSize: maxTranscriptBytes, files: 1 } });
        if (!upload) return fail(reply, 400, "INVALID_TRANSCRIPT", "multipart 缺少 Transcript 文件");
        buffer = await upload.toBuffer();
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "FST_REQ_FILE_TOO_LARGE" || code === "FST_FILES_LIMIT") {
          return fail(reply, 413, "TRANSCRIPT_TOO_LARGE", `Transcript 超过 ${maxTranscriptBytes} 字节上限`);
        }
        throw err;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
      } catch (err) {
        const encoding = (err as { code?: string }).code === "ERR_ENCODING_INVALID_ENCODED_DATA";
        return fail(reply, 400, encoding ? "INVALID_TRANSCRIPT_ENCODING" : "INVALID_TRANSCRIPT", encoding ? "Transcript 不是合法 UTF-8" : "Transcript 不是合法 JSON");
      }
      const result = await importTranscript(pool, outcome, env.sessionSecret, req.params.id, parsed, hostId);
      return respondTranscriptImport(reply, result.status === 200 && hostId !== undefined
        ? { ...result, card: projectMemberMeetingCardFromCard(result.card, hostId) } : result);
    },
  );

  // 会议记录（md/txt/html/docx/pdf）：认得出说话人的只生成候选，确认是独立 opaque Action；认不出的按纪要直接确认。
  app.post(
    "/api/meetings/:id/transcript-candidate",
    { preHandler: requirePerson, schema: { params: idParams }, bodyLimit: MAX_MATERIAL_FILE_BYTES * 2 },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      let file: { fileName: string; buffer: Buffer } | null = null;
      const hostId = req.person!.role === "ceo" ? undefined : req.person!.personId;
      if (hostId !== undefined && (await getMeetingRow(q, req.params.id))?.lead_dri_id !== hostId)
        return fail(reply, 404, "MEETING_NOT_FOUND", "Meeting 不存在");
      try {
        const upload = await req.file({ limits: { fileSize: MAX_MATERIAL_FILE_BYTES, files: 1 } });
        if (!upload) return fail(reply, 400, "INVALID_TRANSCRIPT", "multipart 缺少会议记录文件");
        file = { fileName: upload.filename, buffer: await upload.toBuffer() };
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "FST_REQ_FILE_TOO_LARGE" || code === "FST_FILES_LIMIT") {
          return fail(reply, 413, "TRANSCRIPT_TOO_LARGE", "会议记录不能超过 20 MB");
        }
        throw err;
      }
      const result = await createTranscriptCandidate(pool, peopleDirectory, outcome, env.sessionSecret, env.publicOrigin, req.params.id, file, hostId);
      if (result.status === 200) return { cards: [hostId === undefined ? result.card : projectMemberMeetingCardFromCard(result.card, hostId)] };
      return fail(reply, result.status, result.code, result.message, result.fieldErrors ? { fieldErrors: result.fieldErrors } : undefined);
    },
  );

  // 飞书妙记：主持人或创建人「再读一次」、贴妙记链接（别人一律 404）。
  app.post("/api/meetings/:id/minutes/refetch", {
    preHandler: requirePerson, schema: { params: idParams, response: { 200: MeetingMinutesFetchResponse } },
  }, async (req, reply) => {
    ctx.requestContext.set(req, { actionType: "meeting.minutes_refetch", objectRef: `meeting:${req.params.id}` });
    const result = await app.meetingFollowThrough.minutes.refetch(req.params.id, req.person!.personId);
    return "error" in result ? fail(reply, result.error.status, result.error.code, result.error.message) : result;
  });

  app.post("/api/meetings/:id/minutes", {
    preHandler: requirePerson, schema: { params: idParams, body: MeetingMinutesLinkRequest, response: { 200: MeetingMinutesFetchResponse } },
  }, async (req, reply) => {
    ctx.requestContext.set(req, { actionType: "meeting.minutes_link", objectRef: `meeting:${req.params.id}` });
    const result = await app.meetingFollowThrough.minutes.readLink(req.params.id, req.person!.personId, req.body.url);
    return "error" in result ? fail(reply, result.error.status, result.error.code, result.error.message) : result;
  });

  // Meeting Material 使用独立 endpoint，绝不复用 Transcript 语义或 DRI service 身份。
  app.post(
    "/api/meetings/:id/materials",
    { preHandler: requireCEO, schema: { params: idParams }, bodyLimit: 101 * 1024 * 1024 },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      let parsed: Awaited<ReturnType<typeof parseMaterialBatch>> | undefined;
      try {
        const files: { filename: string; mimetype: string; buffer: Buffer }[] = [];
        let totalBytes = 0;
        for await (const part of req.files({ limits: { fileSize: MAX_MATERIAL_FILE_BYTES, files: MAX_MATERIAL_FILES } })) {
          if (part.type !== "file" || part.fieldname !== "files") return fail(reply, 400, "INVALID_MATERIAL", "multipart 只接受 files 文件字段");
          const buffer = await part.toBuffer();
          totalBytes += buffer.length;
          if (totalBytes > 100 * 1024 * 1024) return fail(reply, 413, "MATERIAL_BATCH_TOO_LARGE", "材料总大小超过 100 MiB");
          files.push({ filename: part.filename, mimetype: part.mimetype, buffer });
        }
        parsed = await parseMaterialBatch(files);
        const result = await replaceMeetingMaterials(pool, env.sessionSecret, req.params.id, parsed.materials, materialStorageDir);
        return respond(reply, result);
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

  // 预览同样仅 CEO 鉴权：PDF inline 字节、Markdown 纯文本、DOCX 按需 sanitize HTML（不持久化）。
  // 补充材料文件组：CEO 把会外收到的回应文件归档到已记录请求；scheduled only；不重置/不触发预审。
  app.post(
    "/api/meetings/:id/materials/supplement",
    { preHandler: requireCEO, schema: { params: idParams }, bodyLimit: MAX_MATERIAL_FILE_BYTES * 2 },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      let parsed: Awaited<ReturnType<typeof parseMaterialBatch>> | undefined;
      try {
        let requestId: string | null = null;
        let file: { filename: string; mimetype: string; buffer: Buffer } | null = null;
        for await (const part of req.parts({ limits: { fileSize: MAX_MATERIAL_FILE_BYTES, files: 1 } })) {
          if (part.type === "file") {
            if (part.fieldname !== "files") return fail(reply, 400, "INVALID_MATERIAL", "multipart 文件必须放在 files 字段");
            if (file) return fail(reply, 400, "INVALID_MATERIAL", "补充材料一次只能上传一份");
            file = { filename: part.filename, mimetype: part.mimetype, buffer: await part.toBuffer() };
          } else if (part.fieldname === "requestId") {
            requestId = String(part.value ?? "").trim() || null;
          }
        }
        if (!file || !requestId) return fail(reply, 400, "INVALID_MATERIAL", "multipart 需要 files 文件与 requestId 字段");
        parsed = await parseMaterialBatch([file]);
        const result = await appendSupplementMaterial(pool, env.sessionSecret, req.params.id, requestId, parsed.materials[0], materialStorageDir);
        return respond(reply, result);
      } catch (error) {
        if (error instanceof MaterialParseError) return fail(reply, 400, error.code, error.message);
        const limited = materialMultipartLimitError(
          error,
          { status: 413, code: "MATERIAL_FILE_TOO_LARGE", message: "补充材料超出 20 MiB 上限" },
          { status: 400, code: "INVALID_MATERIAL", message: "补充材料一次只能上传一份" },
          { status: 400, code: "INVALID_MATERIAL", message: "补充材料必须恰好一份，或上传在完成前中断" },
        );
        if (limited) return fail(reply, limited.status, limited.code, limited.message);
        throw error;
      } finally {
        if (parsed) await cleanupMaterialTemp(parsed.directory);
      }
    },
  );

  app.get(
    "/api/meetings/:id/materials/:materialId/preview",
    { preHandler: requirePerson, schema: { params: Type.Object({ id: Type.String(), materialId: Type.String() }) } },
    async (req, reply): Promise<FastifyReply> => {
      if (req.person!.role !== "ceo" && !await isActiveMember(q, { objectType: "meeting", objectId: req.params.id }, req.person!.personId))
        return fail(reply, 404, "MATERIAL_NOT_FOUND", "材料不存在");
      const meeting = await getMeetingRow(q, req.params.id);
      const material = meeting?.materials.find((candidate) => candidate.id === req.params.materialId);
      if (!material) return fail(reply, 404, "MATERIAL_NOT_FOUND", "材料不存在");
      try {
        const buffer = await readStoredMaterial(materialStorageDir, material.storageKey);
        const preview = await renderMaterialPreview(buffer, material.mimeType);
        return reply.type(preview.contentType)
          .header("content-disposition", "inline")
          .header("x-content-type-options", "nosniff")
          .header("content-security-policy", "default-src 'none'; sandbox")
          .send(preview.body);
      } catch {
        return fail(reply, 404, "MATERIAL_NOT_FOUND", "材料原件不存在");
      }
    },
  );

  app.get(
    "/api/meetings/:id/materials/:materialId/download",
    { preHandler: requirePerson, schema: { params: Type.Object({ id: Type.String(), materialId: Type.String() }) } },
    async (req, reply): Promise<FastifyReply> => {
      if (req.person!.role !== "ceo" && !await isActiveMember(q, { objectType: "meeting", objectId: req.params.id }, req.person!.personId))
        return fail(reply, 404, "MATERIAL_NOT_FOUND", "材料不存在");
      const meeting = await getMeetingRow(q, req.params.id);
      const material = meeting?.materials.find((candidate) => candidate.id === req.params.materialId);
      if (!material) return fail(reply, 404, "MATERIAL_NOT_FOUND", "材料不存在");
      try {
        const buffer = await readStoredMaterial(materialStorageDir, material.storageKey);
        return reply.type(material.mimeType).header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(material.fileName)}`).send(buffer);
      } catch {
        return fail(reply, 404, "MATERIAL_NOT_FOUND", "材料原件不存在");
      }
    },
  );
}
