import type { Pool } from "pg";
import type { TLocalPermissionBrief, TLocalQuestionRequestView, TCreateLocalDeviceRequest, TCreateLocalDeviceResponse, TLocalDeviceView, TLocalHold, TLocalOutputView, TLocalPlanEntry, TLocalRunActivity,
  TLocalRunBrief, TLocalRunMessage, TLocalRunPlanProgress, TLocalRunView, TLocalSessionStatus } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { issueLocalToken } from "./personalTokens.js";

/**
 * 本机程序在云端的那一侧（V2 设计第 4、5 节）：配对出来的设备和它们的令牌，以及本机报上来的执行摘要、产出的读取。
 * 和 10/29 下线的本机采集器不是一回事：本机程序只跑本人点了「开始」的事，只报这次执行的结果，云端从不指挥本机。
 */

type DeviceRow = { owner_id: string; id: string; token_id: string; name: string; os: TLocalDeviceView["os"]; app_version: string | null;
  last_sync_at: Date | null; revoked_at: Date | null; created_at: Date };
const deviceView = (row: DeviceRow): TLocalDeviceView => ({ id: row.id, name: row.name, os: row.os, appVersion: row.app_version,
  lastSyncAt: row.last_sync_at?.toISOString() ?? null, createdAt: row.created_at.toISOString() });

/** 配对：同一台电脑（同一个 deviceId）再配对时吊销旧令牌、换一把新的；令牌只在这一次返回。 */
export async function createLocalDevice(pool: Pool, ownerId: string, input: TCreateLocalDeviceRequest, pepper: string, now: Date): Promise<TCreateLocalDeviceResponse> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`local-device:${ownerId}:${input.deviceId}`]);
    const old = (await client.query("SELECT token_id FROM local_devices WHERE owner_id=$1 AND id=$2", [ownerId, input.deviceId])).rows[0] as { token_id: string } | undefined;
    if (old) await client.query("UPDATE personal_tokens SET revoked_at=$2 WHERE id=$1 AND revoked_at IS NULL", [old.token_id, now]);
    const name = input.name.trim();
    const token = await issueLocalToken(client, ownerId, `本机 · ${name}`, pepper, now);
    const row = (await client.query(`INSERT INTO local_devices(owner_id,id,token_id,name,os,created_at) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT (owner_id,id) DO UPDATE SET token_id=EXCLUDED.token_id,name=EXCLUDED.name,os=EXCLUDED.os,revoked_at=NULL RETURNING *`,
    [ownerId, input.deviceId, token.id, name, input.os, now])).rows[0] as DeviceRow;
    await client.query("COMMIT");
    return { device: deviceView(row), token: token.token };
  } catch (cause) { await client.query("ROLLBACK").catch(() => undefined); throw cause; }
  finally { client.release(); }
}

export async function listLocalDevices(q: Query, ownerId: string): Promise<TLocalDeviceView[]> {
  return ((await q("SELECT * FROM local_devices WHERE owner_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC", [ownerId])).rows as DeviceRow[]).map(deviceView);
}

/** 吊销：设备和它的令牌一起，令牌立刻失效。 */
export async function revokeLocalDevice(pool: Pool, ownerId: string, deviceId: string, now: Date): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = (await client.query("UPDATE local_devices SET revoked_at=$3 WHERE owner_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING token_id",
      [ownerId, deviceId, now])).rows[0] as { token_id: string } | undefined;
    if (row) await client.query("UPDATE personal_tokens SET revoked_at=$2 WHERE id=$1 AND revoked_at IS NULL", [row.token_id, now]);
    await client.query("COMMIT");
    return Boolean(row);
  } catch (cause) { await client.query("ROLLBACK").catch(() => undefined); throw cause; }
  finally { client.release(); }
}

/** 令牌对应的设备（没吊销的）。 */
export async function deviceOfToken(q: Query, tokenId: string): Promise<{ ownerId: string; id: string } | null> {
  const row = (await q("SELECT owner_id,id FROM local_devices WHERE token_id=$1 AND revoked_at IS NULL", [tokenId])).rows[0] as { owner_id: string; id: string } | undefined;
  return row ? { ownerId: row.owner_id, id: row.id } : null;
}

export type RunRow = { id: string; owner_id: string; device_id: string; device_name: string | null; kind: "card" | "topic" | "plan" | "verify"; task_id: string | null; topic_id: string | null;
  plan_task_id: string | null;
  title: string | null; model_label: string | null; state: TLocalSessionStatus; plan: TLocalPlanEntry[]; plan_progress: TLocalRunPlanProgress | null;
  last_activity: TLocalRunActivity | null;
  timeline: TLocalRunActivity[]; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost_usd: string | null;
  /** hold：停着等额度恢复（本机状态条目带的）；money：网关模型真花的钱，按币种累计。 */
  hold: TLocalHold | null; money: Record<string, number>;
  /** 最近一次状态里在问本人（idle 带 question）或在等批准的那一步（waiting_permission 带 permission）；没有为 null（迁移 242）。 */
  ask: RunAsk | null;
  started_at: Date; running_at: Date | null; ended_at: Date | null; updated_at: Date };
export type RunAsk = { kind: "question"; request: TLocalQuestionRequestView } | { kind: "permission"; request: TLocalPermissionBrief };
/** 真在问本人（不是一轮做完停下）。 */
export const askingQuestion = (run: Pick<RunRow, "state" | "ask">) => run.state === "idle" && run.ask?.kind === "question";
export const RUN_SELECT = `SELECT r.*,d.name AS device_name FROM local_runs r LEFT JOIN local_devices d ON d.owner_id=r.owner_id AND d.id=r.device_id`;

export function runBrief(row: RunRow): TLocalRunBrief {
  return {
    id: row.id, deviceId: row.device_id, deviceName: row.device_name ?? "本机", state: row.state, modelLabel: row.model_label,
    plan: row.plan_progress ?? { done: 0, total: 0, step: 0, current: null },
    lastActivity: row.last_activity,
    cost: { inputTokens: row.tokens.input, outputTokens: row.tokens.output, costUsd: row.cost_usd === null ? null : Number(row.cost_usd) },
    startedAt: row.started_at.toISOString(), updatedAt: row.updated_at.toISOString(), endedAt: row.ended_at?.toISOString() ?? null,
  };
}
export const runView = (row: RunRow, messages: TLocalRunMessage[] = []): TLocalRunView => ({ ...runBrief(row), planEntries: row.plan, timeline: row.timeline, messages });

/** 详情里的几次执行：带上每次执行里本人说的话和回执（本机同步的 user_message、receipt；还没收到原话的不列），每次最近 50 句、按先后。 */
export async function runViews(q: Query, rows: RunRow[]): Promise<TLocalRunView[]> {
  const found = rows.length ? (await q(`SELECT run_id::text,message_id::text,text,attachments,sent_at,receipt FROM (
      SELECT m.*,row_number() OVER (PARTITION BY run_id ORDER BY sent_at DESC,message_id) AS n FROM local_run_messages m
      WHERE run_id=ANY($1::uuid[]) AND text IS NOT NULL) m WHERE n<=50 ORDER BY sent_at,message_id`, [rows.map((row) => row.id)])).rows as
    { run_id: string; message_id: string; text: string; attachments: string[]; sent_at: Date; receipt: TLocalRunMessage["receipt"] }[] : [];
  const byRun = new Map<string, TLocalRunMessage[]>();
  for (const row of found) byRun.set(row.run_id, [...(byRun.get(row.run_id) ?? []),
    { messageId: row.message_id, text: row.text, attachments: row.attachments, at: row.sent_at.toISOString(), receipt: row.receipt }]);
  return rows.map((row) => runView(row, byRun.get(row.id)));
}

/** 某张卡或某个专题最近的几次执行，新的在前。卡只算执行会话（验收员的会话也挂这张卡，不算）。 */
export async function recentRuns(q: Query, subject: { taskId: string } | { topicId: string }, limit: number): Promise<RunRow[]> {
  const [column, id, kind] = "taskId" in subject ? ["task_id", subject.taskId, "card"] : ["topic_id", subject.topicId, "topic"];
  return (await q(`${RUN_SELECT} WHERE r.${column}=$1 AND r.kind=$3 ORDER BY r.started_at DESC,r.id LIMIT $2`, [id, limit, kind])).rows as RunRow[];
}

/** 每张卡（或专题）最近一次某种会话（kind）；ids 里没有的不在结果里。 */
export async function latestRuns(q: Query, column: "task_id" | "topic_id", ids: string[], kind: RunRow["kind"]): Promise<Map<string, RunRow>> {
  if (!ids.length) return new Map();
  const rows = (await q(`SELECT DISTINCT ON (r.${column}) r.*,d.name AS device_name FROM local_runs r
    LEFT JOIN local_devices d ON d.owner_id=r.owner_id AND d.id=r.device_id
    WHERE r.${column}=ANY($1::uuid[]) AND r.kind=$2 ORDER BY r.${column},r.started_at DESC,r.id`, [ids, kind])).rows as RunRow[];
  return new Map(rows.map((row) => [(column === "task_id" ? row.task_id : row.topic_id)!, row]));
}

export type OutputRow = { id: string; owner_id: string; run_id: string; task_id: string | null; topic_id: string | null; kind: "artifact" | "evidence";
  evidence_kind: TLocalOutputView["evidenceKind"]; title: string; file_name: string | null; mime: string | null; size_bytes: number | null;
  storage_key: string | null; url: string | null; text: string | null; extracted_text: string | null; created_at: Date };
export const outputView = (row: OutputRow): TLocalOutputView => ({ id: row.id, runId: row.run_id, kind: row.kind, evidenceKind: row.evidence_kind,
  title: row.title, fileName: row.file_name, mimeType: row.mime, sizeBytes: row.size_bytes, url: row.url, text: row.text, createdAt: row.created_at.toISOString() });

/** 本人的一份产出（打开原文件用）。 */
export async function ownOutput(q: Query, ownerId: string, id: string): Promise<OutputRow | null> {
  return (await q("SELECT * FROM local_outputs WHERE id=$1 AND owner_id=$2", [id, ownerId])).rows[0] as OutputRow | undefined ?? null;
}
