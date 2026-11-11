import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, CreateLocalDeviceRequest, CreateLocalDeviceResponse, LOCAL_RUNNER_ATTACHMENT_PATH, LOCAL_RUNNER_SYNC_PATH,
  LOCAL_RUNNER_VERIFY_BRIEF_PATH, LOCAL_RUNNER_CARD_AGREEMENT_PATH, LocalCardAgreementResponse, LocalDeviceListResponse, LocalSyncBatchRequest, LocalSyncBatchResponse, LocalVerifyBriefResponse, SessionAttachmentUploadResponse,
  type TSessionAttachment } from "@warmap/contracts";
import type { FastifyReply } from "fastify";
import { readSessionAttachment, storeSessionAttachments } from "../sessionAttachments.js";
import { verifyBrief } from "../cardAcceptance.js";
import { cardAgreementForDevice } from "../cardAgreements.js";
import { createLocalDevice, deviceOfToken, listLocalDevices, ownOutput, revokeLocalDevice } from "../localDevices.js";
import { applySyncBatch } from "../localSync.js";
import { lastSequenceReader, projectHistoryReader } from "../sourceWords.js";
import { readReport, setAfterSequence } from "../subSessionReports.js";
import { authenticateLocalToken } from "../personalTokens.js";
import { CardError } from "../taskCards.js";
import type { BoardHooks } from "./taskCards.js";
import type { AppInstance, RouteContext } from "./shared.js";

/** HTML 产出照材料预览：沙箱里只跑页面自己的脚本，不连网、不提交表单。 */
const HTML_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src https: data: blob:; font-src https: data:; media-src https: data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
/** 附件一次上传合计最多 100 MB（每个 30 MB，网页逐个传）。 */
const ATTACHMENT_BODY_LIMIT = 101 * 1024 * 1024;
/** 一批最多 12 MB（本机程序的上限），留一点余量。 */
const SYNC_BODY_LIMIT = 13 * 1024 * 1024;

/**
 * 本机程序在云端的那一侧：网页配对建设备令牌、看和吊销设备、打开本机传上来的产出；本机程序用设备令牌单向上报、取验收员的交代。
 * board：看板那一侧（routes/taskCards.ts）——新交回排云端验收（开关关着时不排）、本机验收第二次没过记下的岗位修改排队、按人读卡挂的 Task。
 */
export function registerLocalRoutes(app: AppInstance, ctx: RouteContext, board: BoardHooks): void {
  const { q, pool, fail, requirePerson, env } = ctx;
  const personExists = (personId: string) => ctx.peopleDirectory.searchPeople(undefined).some((person) => person.personId === personId);

  app.get("/api/me/local-devices", { preHandler: requirePerson, schema: { response: { 200: LocalDeviceListResponse } } }, async (req) =>
    ({ devices: await listLocalDevices(q, req.person!.personId) }));

  app.post("/api/me/local-devices", { preHandler: requirePerson, schema: { body: CreateLocalDeviceRequest, response: { 201: CreateLocalDeviceResponse } } },
    async (req, reply) => reply.status(201).send(await createLocalDevice(pool, req.person!.personId, req.body, env.sessionSecret, ctx.now())));

  app.delete("/api/me/local-devices/:id", { preHandler: requirePerson, schema: { params: Type.Object({ id: Type.String({ format: "uuid" }) }) } }, async (req, reply) =>
    await revokeLocalDevice(pool, req.person!.personId, req.params.id, ctx.now()) ? reply.status(204).send() : fail(reply, 404, "NOT_FOUND", "找不到这台设备"));

  app.get("/api/me/local-outputs/:id", { preHandler: requirePerson, schema: { params: Type.Object({ id: Type.String({ format: "uuid" }) }) } }, async (req, reply) => {
    const output = await ownOutput(q, req.person!.personId, req.params.id);
    const data = output?.storage_key ? await readFile(join(ctx.materialStorageDir, output.storage_key)).catch(() => null) : null;
    if (!output || !data) return fail(reply, 404, "NOT_FOUND", "找不到这份产出");
    const html = output.mime === "text/html";
    return reply.type(html ? "text/html; charset=utf-8" : output.mime === "text/markdown" || output.mime === "text/plain" ? `${output.mime}; charset=utf-8` : output.mime!)
      .header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(output.file_name ?? output.title)}`)
      .header("x-content-type-options", "nosniff").header("content-security-policy", html ? HTML_CSP : "sandbox").send(data);
  });

  // 子会话的附件（新首页 14.5）：本人存到云端；本人看原文件；本人配对的电脑按 id 取回存进工作区。
  const sendAttachment = (reply: FastifyReply, found: { attachment: TSessionAttachment; data: Buffer }) =>
    reply.type(found.attachment.mimeType.startsWith("text/") ? `${found.attachment.mimeType}; charset=utf-8` : found.attachment.mimeType)
      .header("content-disposition", `${found.attachment.kind === "image" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(found.attachment.fileName)}`)
      .header("x-sha256", found.attachment.sha256).header("x-content-type-options", "nosniff").header("content-security-policy", "sandbox").send(found.data);
  app.post("/api/me/sub-sessions/:kind/:id/attachments", { preHandler: requirePerson, bodyLimit: ATTACHMENT_BODY_LIMIT,
    schema: { params: Type.Object({ kind: Type.Union([Type.Literal("card"), Type.Literal("topic")]), id: Type.String({ minLength: 1 }) }),
      response: { 200: SessionAttachmentUploadResponse } } }, async (req, reply) => {
    try {
      const files: { filename: string; buffer: Buffer }[] = [];
      for await (const part of req.files({ limits: { fileSize: ATTACHMENT_MAX_BYTES, files: ATTACHMENT_MAX_COUNT } })) {
        if (part.type !== "file" || part.fieldname !== "files") return fail(reply, 400, "INVALID_ATTACHMENT", "multipart 只接受 files 文件字段");
        files.push({ filename: part.filename, buffer: await part.toBuffer() });
      }
      if (!files.length) return fail(reply, 400, "INVALID_ATTACHMENT", "缺少附件文件");
      return { attachments: await storeSessionAttachments(q, ctx.materialStorageDir, req.person!.personId, req.params, files, ctx.now()) };
    } catch (cause) {
      if (cause instanceof CardError) return fail(reply, cause.status, cause.code, cause.message);
      const code = (cause as { code?: string }).code;
      if (code === "FST_REQ_FILE_TOO_LARGE") return fail(reply, 413, "ATTACHMENT_TOO_LARGE", "超过 30 MB");
      if (code === "FST_FILES_LIMIT") return fail(reply, 413, "TOO_MANY_ATTACHMENTS", "最多 20 个");
      throw cause;
    }
  });
  app.get("/api/me/session-attachments/:id", { preHandler: requirePerson, schema: { params: Type.Object({ id: Type.String({ minLength: 1 }) }) } }, async (req, reply) => {
    const found = await readSessionAttachment(q, ctx.materialStorageDir, req.person!.personId, req.params.id);
    return found ? sendAttachment(reply, found) : fail(reply, 404, "NOT_FOUND", "找不到这份附件");
  });
  app.get(LOCAL_RUNNER_ATTACHMENT_PATH, { schema: { params: Type.Object({ id: Type.String({ minLength: 1 }) }) } }, async (req, reply) => {
    const identity = await authenticateLocalToken(q, req.headers.authorization, env.sessionSecret, ctx.now(), personExists);
    if (!identity) return fail(reply, 401, "UNAUTHORIZED", "设备令牌无效，请在天枢插件页重新配对");
    const found = await readSessionAttachment(q, ctx.materialStorageDir, identity.personId, req.params.id);
    return found ? sendAttachment(reply, found) : fail(reply, 404, "NOT_FOUND", "找不到这份附件");
  });

  const planSequence = lastSequenceReader(ctx);
  app.post(LOCAL_RUNNER_SYNC_PATH, { bodyLimit: SYNC_BODY_LIMIT, schema: { body: LocalSyncBatchRequest, response: { 200: LocalSyncBatchResponse } } }, async (req, reply) => {
    const identity = await authenticateLocalToken(q, req.headers.authorization, env.sessionSecret, ctx.now(), personExists);
    if (!identity) return fail(reply, 401, "UNAUTHORIZED", "设备令牌无效，请在天枢插件页重新配对");
    const device = await deviceOfToken(q, identity.tokenId);
    if (!device || device.id !== req.body.deviceId) return fail(reply, 403, "DEVICE_MISMATCH", "这把令牌不是这台电脑的");
    // 每一批（包括闲着时的空批，也就是心跳）都刷新在线时间、版本和位置数；带了额度的整份换掉这台电脑存的额度，没带的留着上次的。
    await q("UPDATE local_devices SET last_sync_at=$3,app_version=$4,slots=$5::jsonb,quota=COALESCE($6::jsonb,quota) WHERE owner_id=$1 AND id=$2",
      [device.ownerId, device.id, ctx.now(), req.body.runnerVersion.slice(0, 40), JSON.stringify(req.body.slots), req.body.quota ? JSON.stringify(req.body.quota) : null]);
    const { response, queued, proposals, reports, decisions } = await applySyncBatch({ pool, storageDir: ctx.materialStorageDir, now: ctx.now,
      onError: () => app.log.error("local sync item failed"), planTask: board.planTask,
      lastSequence: (personId, target) => planSequence(personId, target, String(req.id)) }, identity.personId, req.body);
    queued.forEach(board.enqueueAcceptance);
    proposals.forEach(board.enqueueProposal);
    if (reports.length || decisions.length) void reportNotices(identity.personId, reports, decisions);
    return response;
  });

  /**
   * 子会话停了、要介入（18 节第 10 条），提交以后在后台做：补上项目对话当时最后一条消息的 sequence（报告、决定卡按它插进对话）。出错只记日志。
   * 主循环第 63 条：报告不再替本人给项目主管线发一句、不再让它回一小轮（不触发模型）；管线要知道近况自己读（read_project）。
   */
  const history = projectHistoryReader(ctx);
  const lastSequence = (projectId: string, ownerId: string) =>
    history(projectId, ownerId, "sub-session-report").then((read) => read.messages.at(-1)?.sequence ?? null).catch(() => null);
  async function reportNotices(ownerId: string, reports: string[], decisions: string[]) {
    try {
      for (const id of decisions) {
        const projectId = (await q("SELECT project_id::text FROM sub_session_decisions WHERE id=$1", [id])).rows[0]?.project_id as string | undefined;
        if (projectId) await setAfterSequence(q, "sub_session_decisions", id, await lastSequence(projectId, ownerId));
      }
      for (const id of reports) {
        const report = await readReport(q, id);
        if (!report) continue;
        await setAfterSequence(q, "sub_session_reports", id, await lastSequence(report.project_id, ownerId));
      }
    } catch (cause) {
      app.log.error({ err: cause }, "sub-session notices failed");
    }
  }

  // 验收员的交代（第 21 节）：本机交回以后自己起验收员，先来取这份。
  app.get(LOCAL_RUNNER_VERIFY_BRIEF_PATH, { schema: { querystring: Type.Object({ handbackKey: Type.String({ minLength: 1, maxLength: 200 }) }),
    response: { 200: LocalVerifyBriefResponse } } }, async (req, reply) => {
    const identity = await authenticateLocalToken(q, req.headers.authorization, env.sessionSecret, ctx.now(), personExists);
    if (!identity) return fail(reply, 401, "UNAUTHORIZED", "设备令牌无效，请在天枢插件页重新配对");
    try {
      return await verifyBrief(q, identity.personId, req.query.handbackKey, (planTaskId) => board.planTask(identity.personId, planTaskId));
    } catch (cause) {
      if (cause instanceof CardError) return fail(reply, cause.status, cause.code, cause.message);
      throw cause;
    }
  });

  // 卡此刻的约定（主循环第 60 条）：本机开工、交回前取，核对执行方知道的是不是最新一版。
  app.get(LOCAL_RUNNER_CARD_AGREEMENT_PATH, { schema: { querystring: Type.Object({ cardId: Type.String({ minLength: 1, maxLength: 80 }) }),
    response: { 200: LocalCardAgreementResponse } } }, async (req, reply) => {
    const identity = await authenticateLocalToken(q, req.headers.authorization, env.sessionSecret, ctx.now(), personExists);
    if (!identity) return fail(reply, 401, "UNAUTHORIZED", "设备令牌无效，请在天枢插件页重新配对");
    try {
      return await cardAgreementForDevice(q, identity.personId, req.query.cardId);
    } catch (cause) {
      if (cause instanceof CardError) return fail(reply, cause.status, cause.code, cause.message);
      throw cause;
    }
  });
}
