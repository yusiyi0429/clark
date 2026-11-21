import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { TCreateWorkIntake, TWorkIntakeChange, TWorkIntakeEntry } from "@warmap/contracts";
import { sseEvents } from "./homeTurn.js";
import { currentSessionVersion } from "./memberAccess.js";
import type { Query } from "./meetingStore.js";
import { ownProject } from "./projects.js";
import { SESSION_COOKIE, createSessionToken } from "./session.js";
import { CardError } from "./taskCards.js";
import { logEvent } from "./observability.js";
import type { ChatConversation } from "./chatService.js";

type State = TWorkIntakeEntry["state"];
type IntakeRow = { id: string; owner_id: string; scope: string; message: string; page_path: string | null; attachments: { id: string }[];
  state: State; priority: boolean; created_at: Date; changed_at: Date; last_error: string | null; accepted_at: Date | null };
const view = (r: IntakeRow): TWorkIntakeEntry => ({ id: r.id, scope: r.scope, message: r.message, state: r.state, priority: r.priority,
  createdAt: r.created_at.toISOString(), updatedAt: r.changed_at.toISOString(), error: r.last_error });

export function intakeStatusAfterTurn(status: number, code: string | null, received: boolean): State {
  if (status === 409 && code === "TURN_IN_PROGRESS") return "queued";
  return status === 200 && received ? "delivered" : "failed";
}
export async function checkIntakeScope(q: Query, owner: string, scope: string) {
  if (scope !== "global") await ownProject(q, owner, scope.slice("project:".length));
}

// 首页可能跨日换段。一次重试仍须发往第一次选定的 Chat 对话，才能复用原有的请求回执。
export async function intakeSegment(q: Query, owner: string, id: string, proposed?: ChatConversation): Promise<ChatConversation | undefined> {
  const row = proposed
    ? (await q(`UPDATE work_intake SET chat_segment=COALESCE(chat_segment,$3::jsonb)
        WHERE id=$1 AND owner_id=$2 AND scope='global' RETURNING chat_segment`, [id, owner, JSON.stringify(proposed)])).rows[0]
    : (await q("SELECT chat_segment FROM work_intake WHERE id=$1 AND owner_id=$2 AND scope='global'", [id, owner])).rows[0];
  if (!row) throw new CardError(404, "INTAKE_NOT_FOUND", "没有这条待发需求");
  return row.chat_segment ?? undefined;
}
export async function registerIntake(q: Query, owner: string, input: TCreateWorkIntake) {
  await checkIntakeScope(q, owner, input.scope);
  const message = input.message.trim();
  if (!message) throw new CardError(400, "EMPTY_MESSAGE", "请写下要接着做什么");
  // 相同 id 只允许重放同一条消息。每次重试返回当前状态，包括等待发送的原记录。
  const result = await q(`INSERT INTO work_intake AS i(id,owner_id,scope,message,attachments,page_path) VALUES ($1,$2,$3,$4,$5::jsonb,$6)
    ON CONFLICT (id) DO UPDATE SET message=i.message WHERE i.owner_id=EXCLUDED.owner_id AND i.scope=EXCLUDED.scope
    AND i.message=EXCLUDED.message AND i.attachments=EXCLUDED.attachments AND i.page_path IS NOT DISTINCT FROM EXCLUDED.page_path RETURNING *`,
    [input.id, owner, input.scope, message, JSON.stringify(input.attachments), input.pagePath ?? null]);
  if (!result.rows[0]) throw new CardError(409, "ID_CONFLICT", "这条消息的标识已用于其他内容");
  return view(result.rows[0] as IntakeRow);
}
export async function listIntake(q: Query, owner: string, scope: string): Promise<TWorkIntakeEntry[]> {
  await checkIntakeScope(q, owner, scope);
  // 待处理项全部可见。最近送达的用于页面恢复和历史核对。
  const rows = (await q(`SELECT * FROM (SELECT * FROM work_intake WHERE owner_id=$1 AND scope=$2 AND state IN ('queued','sending','failed')
    UNION ALL (SELECT * FROM work_intake WHERE owner_id=$1 AND scope=$2 AND state IN ('delivered','cancelled') ORDER BY position DESC LIMIT 30)) i
    ORDER BY priority DESC, position`, [owner, scope])).rows as IntakeRow[];
  return rows.map(view);
}
export async function changeIntake(q: Query, owner: string, id: string, action: TWorkIntakeChange["action"]) {
  const row = (await q("SELECT scope FROM work_intake WHERE owner_id=$1 AND id=$2", [owner, id])).rows[0];
  if (!row) throw new CardError(404, "NOT_FOUND", "没有这条待发需求");
  await checkIntakeScope(q, owner, row.scope);
  const change = { first: "priority=true", cancel: "state='cancelled'", retry: "state='queued',last_error=NULL" }[action];
  const allowed = action === "retry" ? ["failed"] : action === "cancel" ? ["queued","failed"] : ["queued"];
  const updated = (await q(`UPDATE work_intake SET ${change},changed_at=now() WHERE id=$1 AND owner_id=$2 AND state=ANY($3::text[]) RETURNING *`, [id, owner, allowed])).rows[0];
  if (!updated) throw new CardError(409, "INTAKE_CHANGED", "发送状态已变化，请查看最新进度");
  return view(updated as IntakeRow);
}

export const INTAKE_JOB = "work.intake";
type DispatchDeps = { app: FastifyInstance; pool: Pool; env: { publicOrigin: string; sessionSecret: string } };
/** 只在领取的短事务内锁定目标。模型执行期间将连接还给池，租约到期后可以用原消息 id 接续。 */
async function claimIntake(deps: DispatchDeps, owner: string, scope: string, claim: string): Promise<IntakeRow | null> {
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('work.intake'),hashtext($1))", [JSON.stringify([owner,scope])]);
    const result = await client.query(`WITH next AS (
      SELECT id FROM work_intake WHERE owner_id=$1 AND scope=$2 AND state IN ('sending','queued')
      ORDER BY (state='sending') DESC, priority DESC,position LIMIT 1 FOR UPDATE)
      UPDATE work_intake i SET state='sending',claim_id=$3,lease_until=now()+interval '3 minutes',changed_at=now()
      FROM next WHERE i.id=next.id AND (i.state='queued' OR i.lease_until < now()) RETURNING i.*`, [owner,scope,claim]);
    await client.query("COMMIT");
    return (result.rows[0] as IntakeRow | undefined) ?? null;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally { client.release(); }
}

export async function deliverIntake(deps: DispatchDeps, owner: string, scope: string): Promise<State | null> {
  const claim = randomUUID();
  const row = await claimIntake(deps, owner, scope, claim);
  if (!row) return null;
  const q: Query = deps.pool.query.bind(deps.pool);
  const heartbeat = setInterval(() => {
    void q("UPDATE work_intake SET lease_until=now()+interval '3 minutes' WHERE id=$1 AND claim_id=$2", [row.id,claim]).catch((cause: Error) =>
      logEvent({event: "work.intake.heartbeat", error: cause.message}));
  }, 60_000);
  heartbeat.unref();
  try {
    let state: State = "failed";
    let error: string | null = null;
    try {
      await checkIntakeScope(q, owner, scope);
      const version = await currentSessionVersion(q, owner);
      if (version === null) throw new Error("本人账号无法接收这条消息");
      if (row.accepted_at) {
        await q("UPDATE work_intake SET state='delivered',last_error=NULL,claim_id=NULL,lease_until=NULL,changed_at=now() WHERE id=$1 AND claim_id=$2", [row.id,claim]);
        return "delivered";
      }
      const cookie = SESSION_COOKIE + "=" + createSessionToken(deps.env.sessionSecret, 300, { pid: owner, v: version, view: "member" });
      const response = await deps.app.inject({ method: "POST", url: "/api/conversations/" + encodeURIComponent(scope) + "/messages", payloadAsStream: true,
        headers: { cookie, origin: deps.env.publicOrigin, accept: "text/event-stream", "content-type": "application/json", "x-work-intake-claim": claim },
        payload: JSON.stringify({ message: row.message, attachments: row.attachments, queuedInputId: row.id, ...(row.page_path ? { pagePath: row.page_path } : {}) }) });
      const stream = response.stream();
      let received = false;
      let code: string | null = null;
      if (response.statusCode === 200) {
        for await (const event of sseEvents(stream)) {
          if (event.type !== "error" && (event.runId || event.type === "receipt" || event.type === "done")) received = true;
          if (event.type === "error" && !received) error = String(event.message ?? "这次发送失败");
        }
      } else {
        let raw = "";
        for await (const chunk of stream) raw += String(chunk);
        const details = (() => { try { return JSON.parse(raw); } catch { return {}; } })();
        code = details.code ?? null;
        error = details.message ?? "消息未送达";
      }
      state = intakeStatusAfterTurn(response.statusCode, code, received);
    } catch (cause) { error = cause instanceof Error ? cause.message : "消息未送达"; }
    await q("UPDATE work_intake SET state=$2,last_error=$3,claim_id=NULL,lease_until=NULL,changed_at=now() WHERE id=$1 AND claim_id=$4",
      [row.id,state,state === "failed" ? (error ?? "未收到对话回执").slice(0,500) : null,claim]);
    return state;
  } finally {
    clearInterval(heartbeat);
  }
}
const active = new WeakMap<FastifyInstance, Set<string>>();
export function wakeIntake(deps: DispatchDeps, owner: string, scope: string) {
  const running = active.get(deps.app) ?? new Set<string>();
  active.set(deps.app,running);
  const key = JSON.stringify([owner,scope]);
  if (running.has(key) || running.size >= 3) return;
  running.add(key);
  void (async () => {
    for (let count = 0; count < 8; count++) {
      const state = await deliverIntake(deps, owner, scope);
      if (!state || state === "queued") break;
    }
  })().catch((cause: Error) => logEvent({ event: "work.intake.error", error: cause.message }))
    .finally(() => running.delete(key));
}
export async function scanIntake(deps: DispatchDeps) {
  const pending = (await deps.pool.query(`SELECT owner_id,scope FROM work_intake WHERE state IN ('queued','sending')
    GROUP BY owner_id,scope HAVING NOT bool_or(state='sending' AND lease_until >= now()) ORDER BY max(changed_at), owner_id, scope LIMIT 12`)).rows;
  for (const row of pending) wakeIntake(deps, row.owner_id, row.scope);
}
