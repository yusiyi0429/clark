import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  NEXUS_DRI_AGENT_ID, NEXUS_DRI_MAX_BODY_BYTES, nexusDriIdempotencyKey,
  type TNexusConfirmationDecisionRequest, type TNexusConfirmationItem, type TNexusDriCallback, type TNexusDriConfirmationRecord,
  type TNexusDriContent, type TNexusDriDecision, type TNexusDriReceipt, type TNexusDriRequest,
} from "@warmap/contracts";
import { enqueueJob, type JobHandler } from "./jobs.js";
import type { Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";

/**
 * Nexus → DRI 确认的接收端（契约 nexusDri.ts，迁移 270）：存 Nexus 推来的待确认项和回执，让事项预先指定的负责人本人确认 / 修改 / 拒绝，
 * 存确认记录，再回调 Nexus。天枢这一侧不写本体，也不调模型：修改就是本人改后的原文。
 * - 负责人取 proposedConfirmers 的第一位（本体人员 ID），按「天枢人员 → 本体人员」对应（本体实例配置的 people）找天枢里的人；
 *   对不上不猜，confirmer_person_id 留空并打一条日志；对应补上、重启后 resume() 把之前对不上的补认。
 * - 回调走后台任务（nexus_dri.callback）：没配地址或密钥时不排任务，确认记录留在待发；配上、重启后 resume() 把待发的排进去。
 */
export type NexusDriEnv = {
  /** Nexus 调天枢用的服务凭据（NEXUS_DRI_SERVICE_TOKEN）。 */
  serviceToken: string;
  /** 天枢这边的租户（NEXUS_DRI_TENANT_ID）：请求的 recipientTenant 要等于它，回执的 tenantId 也是它。 */
  tenantId: string;
  /** 请求的 agentId 要等于它（NEXUS_DRI_AGENT_ID，缺省 tianshu-dri）。 */
  agentId: string;
  /** 回调 Nexus 的地址和共享密钥（NEXUS_DRI_CALLBACK_URL、NEXUS_DRI_CALLBACK_SECRET）；缺一个就不发。 */
  callbackUrl?: string;
  callbackSecret?: string;
};

/** 从环境变量装配；没设 NEXUS_DRI_SERVICE_TOKEN 就是关着（返回 undefined）。配了一半、密钥太短的直接报错，不带值。 */
export function resolveNexusDriEnv(source: NodeJS.ProcessEnv = process.env): NexusDriEnv | undefined {
  const serviceToken = source.NEXUS_DRI_SERVICE_TOKEN?.trim();
  if (!serviceToken) return undefined;
  const tenantId = source.NEXUS_DRI_TENANT_ID?.trim();
  if (!tenantId) throw new Error("设了 NEXUS_DRI_SERVICE_TOKEN 就要设 NEXUS_DRI_TENANT_ID");
  const callbackUrl = source.NEXUS_DRI_CALLBACK_URL?.trim() || undefined;
  const callbackSecret = source.NEXUS_DRI_CALLBACK_SECRET?.trim() || undefined;
  if (callbackSecret && Buffer.byteLength(callbackSecret) < 32) throw new Error("NEXUS_DRI_CALLBACK_SECRET 至少 32 字节");
  return { serviceToken, tenantId, agentId: source.NEXUS_DRI_AGENT_ID?.trim() || NEXUS_DRI_AGENT_ID, callbackUrl, callbackSecret };
}

/** 规范化 JSON：各层对象的键按字典序排、数组保持原顺序、紧凑输出。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export const fingerprintOf = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
/** 请求指纹：去掉 fingerprint 字段后算。 */
export function requestFingerprint(request: Record<string, unknown>): string {
  const { fingerprint: _fingerprint, ...rest } = request;
  return fingerprintOf(rest);
}
/** 回调签名：HMAC-SHA256 签「时间戳.原始正文」。 */
export function callbackSignature(secret: string, timestampMs: string, body: Buffer): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestampMs}.`).update(body).digest("hex")}`;
}

export const NEXUS_DRI_CALLBACK_KIND = "nexus_dri.callback";
const CALLBACK_TIMEOUT_MS = 10_000;

export type NexusDriError = { error: { status: number; code: string; message: string } };
const fail = (status: number, code: string, message: string): NexusDriError => ({ error: { status, code, message } });

type RequestRow = {
  id: string; request_id: string; revision: number; item_id: string; meeting_id: string; fingerprint: string; body: TNexusDriRequest;
  confirmer_world_id: string | null; confirmer_person_id: string | null; expires_at: Date; superseded_at: Date | null;
};
const REQUEST_COLUMNS = "id::text, request_id, revision, item_id, meeting_id, fingerprint, body, confirmer_world_id, confirmer_person_id, expires_at, superseded_at";

export type NexusDriDeps = {
  pool: Pool;
  now: () => Date;
  /** 没配时本人这一侧照常能用（列表为空），回调不发。 */
  env?: NexusDriEnv;
  /** 天枢人员 id → 本体人员 ID。 */
  people: Record<string, string>;
};

export function createNexusDri({ pool, now, env, people }: NexusDriDeps) {
  const q: Query = pool.query.bind(pool);
  const personOf = new Map(Object.entries(people).map(([personId, worldId]) => [worldId, personId]));
  const canCallBack = Boolean(env?.callbackUrl && env.callbackSecret);
  const receiptOf = (row: Pick<RequestRow, "id" | "request_id" | "item_id" | "revision" | "fingerprint">): TNexusDriReceipt =>
    ({ accepted: true, receiptId: row.id, tenantId: env!.tenantId, requestId: row.request_id, itemId: row.item_id, revision: row.revision, fingerprint: row.fingerprint });

  async function transaction<T>(run: (cq: Query) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client.query.bind(client) as Query);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** 收一条待确认项（正文已按 NexusDriRequest 校验过）。 */
  async function receive(request: TNexusDriRequest, idempotencyKey: string | undefined): Promise<{ receipt: TNexusDriReceipt } | NexusDriError> {
    if (idempotencyKey !== nexusDriIdempotencyKey(request.requestId, request.revision)) return fail(400, "IDEMPOTENCY_KEY_MISMATCH", "Idempotency-Key 要是 nexus-dri-delivery:<requestId>:<revision>");
    if (request.recipientTenant !== env!.tenantId) return fail(403, "TENANT_MISMATCH", "recipientTenant 不是天枢这边的租户");
    if (request.agentId !== env!.agentId) return fail(403, "AGENT_MISMATCH", "agentId 不对");
    if (requestFingerprint(request) !== request.fingerprint) return fail(400, "FINGERPRINT_MISMATCH", "fingerprint 和正文对不上");
    const confirmerWorldId = request.proposedConfirmers[0] ?? null;
    const confirmerPersonId = (confirmerWorldId && personOf.get(confirmerWorldId)) || null;
    const at = now();
    return transaction(async (cq) => {
      // 同一个 requestId 的各个 revision 串行处理。
      await cq("SELECT pg_advisory_xact_lock(hashtext($1))", [`nexus-dri:${request.requestId}`]);
      const rows = (await cq(`SELECT ${REQUEST_COLUMNS} FROM nexus_dri_requests WHERE request_id = $1 ORDER BY revision DESC`, [request.requestId])).rows as RequestRow[];
      const same = rows.find((row) => row.revision === request.revision);
      if (same) return same.fingerprint === request.fingerprint ? { receipt: receiptOf(same) } : fail(409, "IDEMPOTENCY_CONFLICT", "这个 revision 已经收过，正文不一样");
      const latest = rows[0];
      if (latest && (latest.item_id !== request.itemId || latest.meeting_id !== request.meetingId)) return fail(409, "ITEM_MISMATCH", "同一个 requestId 的 itemId 或 meetingId 变了");
      if (latest && latest.revision > request.revision) return fail(409, "STALE_REVISION", `已经收到更新的 revision ${latest.revision}`);
      const id = randomUUID();
      await cq(
        `INSERT INTO nexus_dri_requests (id, request_id, revision, item_id, meeting_id, fingerprint, body, confirmer_world_id, confirmer_person_id, expires_at, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::json, $8, $9, $10, $11)`,
        [id, request.requestId, request.revision, request.itemId, request.meetingId, request.fingerprint, JSON.stringify(request), confirmerWorldId, confirmerPersonId, new Date(request.expiresAt), at],
      );
      await cq("UPDATE nexus_dri_requests SET superseded_at = $3 WHERE request_id = $1 AND revision < $2 AND superseded_at IS NULL", [request.requestId, request.revision, at]);
      logEvent({ event: confirmerPersonId ? "nexus_dri.request_received" : "nexus_dri.confirmer_unmapped", nexusRequestId: request.requestId, revision: request.revision, confirmer: confirmerWorldId });
      return { receipt: receiptOf({ id, request_id: request.requestId, item_id: request.itemId, revision: request.revision, fingerprint: request.fingerprint }) };
    });
  }

  async function readReceipt(requestId: string, revision: number): Promise<TNexusDriReceipt | null> {
    const row = (await q("SELECT id::text, request_id, item_id, revision, fingerprint FROM nexus_dri_requests WHERE request_id = $1 AND revision = $2", [requestId, revision])).rows[0];
    return row ? receiptOf(row) : null;
  }

  /** 等这个人确认的：他是负责人、没过期、没被新 revision 作废、还没处理。 */
  async function listFor(personId: string): Promise<TNexusConfirmationItem[]> {
    const rows = (await q(
      `SELECT r.id::text, r.body FROM nexus_dri_requests r
        WHERE r.confirmer_person_id = $1 AND r.superseded_at IS NULL AND r.expires_at > $2
          AND NOT EXISTS (SELECT 1 FROM nexus_dri_confirmations c WHERE c.request_row_id = r.id)
        ORDER BY r.expires_at, r.received_at`,
      [personId, now()],
    )).rows as { id: string; body: TNexusDriRequest }[];
    return rows.map(({ id, body }) => ({
      id, meetingId: body.meetingId, question: body.question, value: body.content.value ?? null, quote: body.source.quote || null,
      createdAt: new Date(body.createdAt).toISOString(), expiresAt: new Date(body.expiresAt).toISOString(),
    }));
  }

  /** 本人确认 / 修改 / 拒绝：存确认记录和要回调的正文，配了回调就排发送任务。 */
  async function decide(personId: string, id: string, input: TNexusConfirmationDecisionRequest): Promise<{ confirmationRef: string } | NexusDriError> {
    return transaction(async (cq) => {
      const row = (await cq(`SELECT ${REQUEST_COLUMNS} FROM nexus_dri_requests WHERE id = $1 FOR UPDATE`, [id])).rows[0] as RequestRow | undefined;
      if (!row) return fail(404, "NOT_FOUND", "没有这一条");
      if (row.confirmer_person_id !== personId || !row.confirmer_world_id) return fail(403, "NOT_CONFIRMER", "只有这件事的负责人本人能确认");
      if ((await cq("SELECT 1 FROM nexus_dri_confirmations WHERE request_row_id = $1", [id])).rowCount) return fail(409, "ALREADY_DECIDED", "已经处理过了");
      if (row.superseded_at) return fail(409, "SUPERSEDED", "这一条已经有新版本");
      const at = now();
      if (row.expires_at.getTime() <= at.getTime()) return fail(409, "EXPIRED", "已经过期");
      const content = row.body.content;
      let amended: { content: TNexusDriContent; fingerprint: string } | undefined;
      if (input.decision === "amended") {
        if (input.value === undefined) return fail(400, "VALUE_REQUIRED", "修改要带改后的内容");
        if (typeof content.value !== "string") return fail(400, "NOT_AMENDABLE", "这一条不能修改，只能确认或拒绝");
        if (input.value === content.value) return fail(400, "VALUE_UNCHANGED", "内容没有改动");
        const amendedContent = { ...content, value: input.value };
        amended = { content: amendedContent, fingerprint: fingerprintOf(amendedContent) };
      }
      const confirmationRef = randomUUID();
      const callback: TNexusDriCallback = {
        callbackId: `tianshu-dri:${confirmationRef}`, requestId: row.request_id, itemId: row.item_id, revision: row.revision, fingerprint: row.fingerprint,
        decision: input.decision, confirmedBy: row.confirmer_world_id, confirmedAt: at.toISOString(), confirmationRef,
        ...(amended ? { content: amended.content } : {}),
      };
      const callbackBody = JSON.stringify(callback);
      if (Buffer.byteLength(callbackBody) > NEXUS_DRI_MAX_BODY_BYTES) return fail(400, "VALUE_TOO_LONG", "改后的内容太长");
      await cq(
        `INSERT INTO nexus_dri_confirmations (id, request_row_id, decision, confirmed_by_person_id, confirmed_by_world_id, confirmed_at, amended_content, amended_fingerprint, callback_id, callback_body)
         VALUES ($1, $2, $3, $4, $5, $6, $7::json, $8, $9, $10)`,
        [confirmationRef, id, input.decision, personId, row.confirmer_world_id, at, amended ? JSON.stringify(amended.content) : null, amended?.fingerprint ?? null, callback.callbackId, callbackBody],
      );
      if (canCallBack) await enqueueJob(cq, { kind: NEXUS_DRI_CALLBACK_KIND, dedupeKey: `${NEXUS_DRI_CALLBACK_KIND}:${confirmationRef}`, payload: { confirmationRef } });
      return { confirmationRef };
    });
  }

  async function readConfirmation(confirmationRef: string): Promise<TNexusDriConfirmationRecord | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(confirmationRef)) return null;
    const row = (await q(
      `SELECT c.decision, c.confirmed_by_world_id, c.confirmed_at, c.amended_content, c.amended_fingerprint, r.request_id, r.item_id, r.revision, r.fingerprint, r.body
         FROM nexus_dri_confirmations c JOIN nexus_dri_requests r ON r.id = c.request_row_id WHERE c.id = $1`,
      [confirmationRef],
    )).rows[0] as { decision: TNexusDriDecision; confirmed_by_world_id: string; confirmed_at: Date; amended_content: TNexusDriContent | null; amended_fingerprint: string | null;
      request_id: string; item_id: string; revision: number; fingerprint: string; body: TNexusDriRequest } | undefined;
    if (!row) return null;
    return {
      confirmationRef, requestId: row.request_id, itemId: row.item_id, revision: row.revision, fingerprint: row.fingerprint,
      decision: row.decision, confirmedBy: row.confirmed_by_world_id, confirmedAt: row.confirmed_at.toISOString(),
      question: row.body.question, content: row.body.content,
      ...(row.amended_content && row.amended_fingerprint ? { amendedContent: row.amended_content, amendedFingerprint: row.amended_fingerprint } : {}),
    };
  }

  /**
   * 发一次回调：正文用存下的原文，时间戳和签名每次重算。200 记已送达；5xx、429 和连不上抛出去，由后台任务按退避重试（同一个 callbackId、同一份正文）；
   * 其余状态是 Nexus 明确拒绝，记失败、不重试。
   */
  async function deliver(confirmationRef: string): Promise<void> {
    if (!env?.callbackUrl || !env.callbackSecret) return;
    const row = (await q("SELECT callback_body, callback_status FROM nexus_dri_confirmations WHERE id = $1", [confirmationRef])).rows[0] as { callback_body: string; callback_status: string } | undefined;
    if (!row || row.callback_status !== "pending") return;
    const body = Buffer.from(row.callback_body, "utf8");
    const timestamp = String(now().getTime());
    const record = (status: "pending" | "delivered" | "failed", httpStatus: number | null, error: string | null) => q(
      `UPDATE nexus_dri_confirmations SET callback_status = $2, callback_http_status = $3, callback_error = $4, callback_attempts = callback_attempts + 1,
         callback_delivered_at = CASE WHEN $2 = 'delivered' THEN $5::timestamptz ELSE NULL END WHERE id = $1`,
      [confirmationRef, status, httpStatus, error, now()],
    );
    let response: Response;
    try {
      response = await fetch(env.callbackUrl, {
        method: "POST", body, redirect: "error", signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
        headers: { "content-type": "application/json", "x-dri-timestamp": timestamp, "x-dri-signature": callbackSignature(env.callbackSecret, timestamp, body) },
      });
    } catch {
      await record("pending", null, "NETWORK_ERROR");
      throw new Error("nexus callback: network error");
    }
    const text = (await response.text().catch(() => "")).slice(0, 1000);
    logEvent({ event: "nexus_dri.callback", confirmationRef, httpStatus: response.status });
    if (response.status === 200) {
      await record("delivered", 200, null);
    } else if (response.status >= 500 || response.status === 429) {
      await record("pending", response.status, text);
      throw new Error(`nexus callback: HTTP ${response.status}`);
    } else {
      await record("failed", response.status, text);
    }
  }

  /** 启动时：对应补上后把之前找不到人的补认；配了回调就把待发、又没有在排任务的确认记录排进去。 */
  async function resume(): Promise<void> {
    await q(
      `UPDATE nexus_dri_requests r SET confirmer_person_id = m.person_id FROM unnest($1::text[], $2::text[]) AS m(world_id, person_id)
        WHERE r.confirmer_person_id IS NULL AND r.confirmer_world_id = m.world_id`,
      [[...personOf.keys()], [...personOf.values()]],
    );
    if (!canCallBack) return;
    const waiting = (await q(
      `SELECT c.id::text FROM nexus_dri_confirmations c WHERE c.callback_status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.kind = $1 AND j.status IN ('pending', 'running') AND j.payload->>'confirmationRef' = c.id::text)`,
      [NEXUS_DRI_CALLBACK_KIND],
    )).rows as { id: string }[];
    for (const { id } of waiting) await enqueueJob(q, { kind: NEXUS_DRI_CALLBACK_KIND, dedupeKey: `${NEXUS_DRI_CALLBACK_KIND}:${id}:${randomUUID()}`, payload: { confirmationRef: id } });
  }

  const jobs: Record<string, JobHandler> = {
    [NEXUS_DRI_CALLBACK_KIND]: async (payload) => deliver((payload as { confirmationRef: string }).confirmationRef),
  };
  return { receive, readReceipt, listFor, decide, readConfirmation, deliver, resume, jobs };
}
export type NexusDri = ReturnType<typeof createNexusDri>;
