import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { CreateLocalDeviceRequest, CreateLocalDeviceResponse, LOCAL_RUNNER_SYNC_PATH, LocalDeviceListResponse, LocalSyncBatchRequest,
  LocalSyncBatchResponse } from "@warmap/contracts";
import { createLocalDevice, deviceOfToken, listLocalDevices, ownOutput, revokeLocalDevice } from "../localDevices.js";
import { applySyncBatch } from "../localSync.js";
import { authenticateLocalToken } from "../personalTokens.js";
import type { AppInstance, RouteContext } from "./shared.js";

/** HTML 产出照材料预览：沙箱里只跑页面自己的脚本，不连网、不提交表单。 */
const HTML_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src https: data: blob:; font-src https: data:; media-src https: data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
/** 一批最多 12 MB（本机程序的上限），留一点余量。 */
const SYNC_BODY_LIMIT = 13 * 1024 * 1024;

/**
 * 本机程序在云端的那一侧：网页配对建设备令牌、看和吊销设备、打开本机传上来的产出；本机程序用设备令牌单向上报。
 * onHandbacks：上报里新排队的交回，交给 Agent 验收队列。
 */
export function registerLocalRoutes(app: AppInstance, ctx: RouteContext, deps: { onHandbacks: (ids: string[]) => void }): void {
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

  app.post(LOCAL_RUNNER_SYNC_PATH, { bodyLimit: SYNC_BODY_LIMIT, schema: { body: LocalSyncBatchRequest, response: { 200: LocalSyncBatchResponse } } }, async (req, reply) => {
    const identity = await authenticateLocalToken(q, req.headers.authorization, env.sessionSecret, ctx.now(), personExists);
    if (!identity) return fail(reply, 401, "UNAUTHORIZED", "设备令牌无效，请在天枢插件页重新配对");
    const device = await deviceOfToken(q, identity.tokenId);
    if (!device || device.id !== req.body.deviceId) return fail(reply, 403, "DEVICE_MISMATCH", "这把令牌不是这台电脑的");
    await q("UPDATE local_devices SET last_sync_at=$3,app_version=$4 WHERE owner_id=$1 AND id=$2", [device.ownerId, device.id, ctx.now(), req.body.runnerVersion.slice(0, 40)]);
    const { response, queued } = await applySyncBatch({ pool, storageDir: ctx.materialStorageDir, now: ctx.now, onError: () => app.log.error("local sync item failed") },
      identity.personId, req.body);
    if (queued.length) deps.onHandbacks(queued);
    return response;
  });
}
