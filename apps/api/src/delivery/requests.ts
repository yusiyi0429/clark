import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  TActionDescriptor, TDraftRequestAnswerResponse, TDraftRequestRequest, TDraftRequestResponse, TPrepareRequestQuestionResponse,
  TRequestBox, TRequestClarification, TRequestListItem, TRequestPerson, TRequestStep, TRequestView,
} from "@warmap/contracts";
import { signActionId, type ActionScope } from "../actionToken.js";
import type { Query } from "../meetingStore.js";
import { insertNotification } from "../notifications.js";
import { withTimeout, type RequestAgent } from "./requestAgent.js";

/**
 * 送达通道（⑨ 传话）：请求、接收人、卡上问答的读写。
 * - 只有发起人和（发出后的）接收人看得到；其他人一律当作不存在。
 * - version 跟着标题和说明走：发出时校验 actionId 里的版本，发出去的就是预览那一版；答案补进说明时加一。
 */
type RequestRow = {
  id: string; kind: TRequestView["kind"]; initiator_id: string; prompt: string; title: string; body: string;
  clarifications: TRequestClarification[]; candidate_ids: string[]; status: TRequestView["status"]; version: number;
  created_at: Date; sent_at: Date | null;
};
type RecipientRow = { person_id: string; status: "pending" | "done"; done_by: string | null; done_at: Date | null };
type QuestionRow = {
  id: string; asker_id: string; question: string; answer: string | null; answer_draft: string | null;
  answered_at: Date | null; merged_into_body: boolean; created_at: Date;
};
export type RequestError = { error: { status: number; code: string; message: string } };
const failure = (status: number, code: string, message: string): RequestError => ({ error: { status, code, message } });
const NOT_FOUND = failure(404, "REQUEST_NOT_FOUND", "请求不存在或不可见");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nameOf = (names: Map<string, string>, id: string) => names.get(id) ?? id;
const step = (label: string, status: TRequestStep["status"], result: string | null = null): TRequestStep => ({ label, status, result });
const squash = (text: string) => text.replace(/\s+/g, "");

export async function getRequestRow(q: Query, id: string): Promise<RequestRow | null> {
  if (!UUID.test(id)) return null;
  return ((await q("SELECT * FROM requests WHERE id = $1", [id])).rows[0] as RequestRow | undefined) ?? null;
}
const readRecipients = async (q: Query, id: string) =>
  (await q("SELECT person_id, status, done_by, done_at FROM request_recipients WHERE request_id = $1 ORDER BY person_id", [id])).rows as RecipientRow[];
const readQuestions = async (q: Query, id: string) =>
  (await q("SELECT * FROM request_questions WHERE request_id = $1 ORDER BY created_at, id", [id])).rows as QuestionRow[];

/** 发起人任何时候都看得到；接收人只在发出之后。 */
async function visibleRow(q: Query, id: string, viewerId: string): Promise<{ row: RequestRow; recipients: RecipientRow[] } | null> {
  const row = await getRequestRow(q, id);
  if (!row) return null;
  const recipients = await readRecipients(q, row.id);
  if (row.initiator_id === viewerId) return { row, recipients };
  if (row.status !== "draft" && recipients.some((recipient) => recipient.person_id === viewerId)) return { row, recipients };
  return null;
}

function sign(secret: string, row: RequestRow, actionType: string, label: string, itemId?: string): TActionDescriptor {
  const scope: ActionScope = { actionType, objectType: "request", objectId: row.id, objectVersion: row.version, ...(itemId ? { itemId } : {}) };
  return { actionId: signActionId(secret, scope), actionType, label, ...(itemId ? { itemId } : {}) };
}

export async function projectRequest(q: Query, row: RequestRow, viewerId: string, names: Map<string, string>,
  people: TRequestPerson[], secret: string, recipients?: RecipientRow[]): Promise<TRequestView> {
  const rows = recipients ?? await readRecipients(q, row.id);
  const questions = await readQuestions(q, row.id);
  const isInitiator = row.initiator_id === viewerId;
  const mine = rows.find((recipient) => recipient.person_id === viewerId);
  const draft = row.status === "draft";
  const actions: TActionDescriptor[] = [];
  if (isInitiator && draft) actions.push(sign(secret, row, "request.send", "发送"));
  if (mine?.status === "pending" && !draft) {
    actions.push(sign(secret, row, "request.ask", "发送", viewerId));
    actions.push(sign(secret, row, "request.mark_done", "标记完成", viewerId));
  }
  if (isInitiator && !draft) for (const question of questions) if (question.answer === null) actions.push(sign(secret, row, "request.answer", "发出回答", question.id));
  return {
    id: row.id, kind: row.kind, status: row.status, version: row.version, title: row.title, body: row.body, prompt: row.prompt,
    initiator: { personId: row.initiator_id, displayName: nameOf(names, row.initiator_id) },
    createdAt: row.created_at.toISOString(), sentAt: row.sent_at?.toISOString() ?? null,
    recipients: rows.map((recipient) => ({ personId: recipient.person_id, displayName: nameOf(names, recipient.person_id), status: recipient.status,
      doneByName: recipient.done_by ? nameOf(names, recipient.done_by) : null, doneAt: recipient.done_at?.toISOString() ?? null })),
    candidates: draft ? row.candidate_ids.map((personId) => ({ personId, displayName: nameOf(names, personId) })) : [],
    directory: draft && isInitiator ? people.filter((person) => person.personId !== viewerId) : [],
    clarifications: row.clarifications,
    questions: questions.map((question) => ({ id: question.id, askerId: question.asker_id, askerName: nameOf(names, question.asker_id),
      question: question.question, answer: question.answer, answerDraft: isInitiator ? question.answer_draft : null,
      answeredAt: question.answered_at?.toISOString() ?? null, mergedIntoBody: question.merged_into_body, createdAt: question.created_at.toISOString() })),
    viewer: { isInitiator, isRecipient: Boolean(mine), myStatus: mine?.status ?? null },
    actions,
  };
}

/** 打开即把这条请求给我的通知标为已读（待办卡本身就是那条通知的去处）。 */
export async function readRequest(q: Query, id: string, viewerId: string, names: Map<string, string>, people: TRequestPerson[], secret: string): Promise<TRequestView | null> {
  const visible = await visibleRow(q, id, viewerId);
  if (!visible) return null;
  await q("UPDATE notifications SET read_at = now() WHERE person_id = $1 AND object_type = 'request' AND object_id = $2 AND read_at IS NULL", [viewerId, visible.row.id]);
  return projectRequest(q, visible.row, viewerId, names, people, secret, visible.recipients);
}

/** 起草或按回答重写：Agent 只出候选，草稿只有发起人自己看得到，发出要再点「发送」。 */
export async function draftRequest(pool: Pool, agent: RequestAgent, input: TDraftRequestRequest, viewerId: string,
  names: Map<string, string>, people: TRequestPerson[], secret: string): Promise<TDraftRequestResponse | RequestError> {
  const q: Query = (sql, params) => pool.query(sql, params);
  const existing = input.requestId ? await getRequestRow(q, input.requestId) : null;
  if (input.requestId && (!existing || existing.initiator_id !== viewerId)) return NOT_FOUND;
  if (existing && existing.status !== "draft") return failure(409, "REQUEST_ALREADY_SENT", "请求已经发出");
  const answered = (input.clarifications ?? existing?.clarifications ?? []).filter((item) => item.answer?.trim());
  const id = existing?.id ?? randomUUID();
  let draft;
  try {
    draft = await withTimeout((signal) => agent.draft({
      prompt: input.prompt, clarifications: answered, current: existing ? { title: existing.title, body: existing.body } : null,
      people: people.filter((person) => person.personId !== viewerId), initiator: nameOf(names, viewerId),
    }, { requestId: id, personId: viewerId }, signal));
  } catch { return failure(503, "REQUEST_DRAFT_FAILED", "起草没有成功，请重试"); }
  const title = draft.title?.trim().slice(0, 200), body = draft.body?.trim().slice(0, 20000);
  if (!title || !body) return failure(503, "REQUEST_DRAFT_FAILED", "起草没有成功，请重试");
  const allowed = new Set(people.map((person) => person.personId));
  const candidates = [...new Set(draft.recipientIds)].filter((personId) => allowed.has(personId) && personId !== viewerId);
  const asked = new Set(answered.map((item) => squash(item.question)));
  const fresh = draft.questions.map((question) => question.trim()).filter((question) => question && !asked.has(squash(question)))
    .slice(0, 3).map((question) => ({ question: question.slice(0, 300), answer: null }));
  const clarifications = [...answered.map((item) => ({ question: item.question, answer: item.answer!.trim() })), ...fresh].slice(0, 10);
  const saved = existing
    ? await q(`UPDATE requests SET prompt = $2, title = $3, body = $4, clarifications = $5::jsonb, candidate_ids = $6::jsonb,
        version = version + 1, updated_at = now() WHERE id = $1 AND status = 'draft' RETURNING *`,
    [id, input.prompt, title, body, JSON.stringify(clarifications), JSON.stringify(candidates)])
    : await q(`INSERT INTO requests (id, kind, initiator_id, prompt, title, body, clarifications, candidate_ids)
        VALUES ($1, 'relay', $2, $3, $4, $5, $6::jsonb, $7::jsonb) RETURNING *`,
    [id, viewerId, input.prompt, title, body, JSON.stringify(clarifications), JSON.stringify(candidates)]);
  const row = saved.rows[0] as RequestRow | undefined;
  if (!row) return failure(409, "REQUEST_ALREADY_SENT", "请求已经发出");
  return {
    request: await projectRequest(q, row, viewerId, names, people, secret, []),
    steps: [step("起草请求", "done"), step("查歧义", "done", fresh.length ? `${fresh.length} 处要你定` : "没有歧义"), step("等你确认", "current")],
  };
}

export async function listRequests(q: Query, viewerId: string, box: TRequestBox, names: Map<string, string>): Promise<TRequestListItem[]> {
  const aggregates = `(SELECT COALESCE(json_agg(person_id ORDER BY person_id), '[]'::json) FROM request_recipients WHERE request_id = r.id) AS recipient_ids,
    (SELECT count(*)::int FROM request_recipients WHERE request_id = r.id AND status = 'done') AS done_count,
    (SELECT count(*)::int FROM request_questions WHERE request_id = r.id AND answer IS NULL) AS open_questions,
    EXISTS (SELECT 1 FROM notifications n WHERE n.person_id = $1 AND n.object_type = 'request' AND n.object_id = r.id::text AND n.read_at IS NULL) AS unread`;
  const rows = (box === "inbox"
    ? await q(`SELECT r.*, rr.status AS my_status, ${aggregates} FROM request_recipients rr JOIN requests r ON r.id = rr.request_id
        WHERE rr.person_id = $1 AND r.status <> 'draft' ORDER BY rr.status = 'pending' DESC, r.sent_at DESC LIMIT 100`, [viewerId])
    : await q(`SELECT r.*, NULL AS my_status, ${aggregates} FROM requests r WHERE r.initiator_id = $1
        ORDER BY r.status = 'done', r.created_at DESC LIMIT 100`, [viewerId])).rows as (RequestRow & {
    my_status: "pending" | "done" | null; recipient_ids: string[]; done_count: number; open_questions: number; unread: boolean;
  })[];
  return rows.map((row) => ({
    id: row.id, title: row.title, status: row.status, initiatorName: nameOf(names, row.initiator_id),
    createdAt: row.created_at.toISOString(), sentAt: row.sent_at?.toISOString() ?? null, myStatus: row.my_status,
    recipientNames: row.recipient_ids.map((personId) => nameOf(names, personId)), recipientsDone: row.done_count, openQuestions: row.open_questions, unread: row.unread,
  }));
}

/**
 * 接收人提问前的四步：定位待办 → 查有没有人问过 → 整理问题 → 等你确认。
 * 说明或已有问答里有答案就停在第二步、直接给答案；答案文字取库里的原文，不取模型复述，模型只负责指到哪一处。
 * 模型没查成也不拦着提问：第二步如实写「没查成」，按原话整理。
 */
export async function prepareQuestion(q: Query, agent: RequestAgent, id: string, viewerId: string, question: string,
  names: Map<string, string>): Promise<TPrepareRequestQuestionResponse | RequestError> {
  const visible = await visibleRow(q, id, viewerId);
  if (!visible) return NOT_FOUND;
  const { row, recipients } = visible;
  if (row.status === "draft" || !recipients.some((recipient) => recipient.person_id === viewerId)) return failure(403, "FORBIDDEN", "只有接收人可以提问");
  const answered = (await readQuestions(q, row.id)).filter((item): item is QuestionRow & { answer: string } => item.answer !== null);
  const located = step("定位待办", "done", `${nameOf(names, row.initiator_id)}：${row.title}`);
  let lookup;
  try {
    lookup = await withTimeout((signal) => agent.lookup({
      title: row.title, body: row.body, question, initiator: nameOf(names, row.initiator_id),
      answered: answered.map((item) => ({ questionId: item.id, question: item.question, answer: item.answer })),
    }, { requestId: row.id, personId: viewerId }, signal));
  } catch {
    return { steps: [located, step("查有没有人问过", "done", "没查成"), step("整理问题", "done"), step("等你确认", "current")], answer: null, question };
  }
  const organized = lookup.question?.trim() || question;
  const hit = lookup.match === "question" ? answered.find((item) => item.id === lookup.questionId) : undefined;
  const quote = lookup.match === "body" && lookup.quote?.trim() && squash(row.body).includes(squash(lookup.quote)) ? lookup.quote.trim() : null;
  if (hit) return {
    steps: [located, step("查有没有人问过", "done", `已有人问过，${nameOf(names, row.initiator_id)}答过`), step("整理问题", "pending"), step("等你确认", "pending")],
    answer: { source: "question", text: hit.answer, questionId: hit.id }, question: organized,
  };
  if (quote) return {
    steps: [located, step("查有没有人问过", "done", "说明里写了"), step("整理问题", "pending"), step("等你确认", "pending")],
    answer: { source: "body", text: quote, questionId: null }, question: organized,
  };
  return { steps: [located, step("查有没有人问过", "done", "没人问过"), step("整理问题", "done"), step("等你确认", "current")], answer: null, question: organized };
}

/** 发起人的 Agent 先起草回答，存成草稿；发起人确认后走 request.answer 才发出。 */
export async function draftAnswer(q: Query, agent: RequestAgent, id: string, questionId: string, viewerId: string,
  names: Map<string, string>): Promise<TDraftRequestAnswerResponse | RequestError> {
  const row = await getRequestRow(q, id);
  if (!row || row.initiator_id !== viewerId || row.status === "draft" || !UUID.test(questionId)) return NOT_FOUND;
  const questions = await readQuestions(q, row.id);
  const target = questions.find((item) => item.id === questionId);
  if (!target) return NOT_FOUND;
  if (target.answer !== null) return failure(409, "REQUEST_QUESTION_ANSWERED", "这个问题已经回答过了");
  let answer: string;
  try {
    answer = (await withTimeout((signal) => agent.answer({
      title: row.title, body: row.body, question: target.question, asker: nameOf(names, target.asker_id),
      answered: questions.flatMap((item) => item.answer === null ? [] : [{ question: item.question, answer: item.answer }]),
    }, { requestId: row.id, personId: viewerId }, signal))).answer?.trim().slice(0, 2000);
  } catch { return failure(503, "REQUEST_ANSWER_DRAFT_FAILED", "起草没有成功，请重试或直接写"); }
  if (!answer) return failure(503, "REQUEST_ANSWER_DRAFT_FAILED", "起草没有成功，请重试或直接写");
  await q("UPDATE request_questions SET answer_draft = $2 WHERE id = $1 AND answer IS NULL", [questionId, answer]);
  return { steps: [step("读问题", "done"), step("起草回答", "done"), step("等你确认", "current")], answer };
}

/** 答案补进说明的格式：说明末尾追加一段，接收人看说明就能看到。 */
export const supplementOf = (question: string, answer: string) => `\n\n**补充 · ${question}**\n${answer}`;

/**
 * request.send / ask / answer / mark_done。只有 send 校验版本（发出的必须是预览那一版）；
 * 其余三项针对的是问题或本人的那一行，说明改过不影响，重放按各自的幂等规则返回当前视图。
 */
export async function executeRequestAction(pool: Pool, viewerId: string, scope: ActionScope, input: unknown, fingerprint: string,
  allowed: Set<string>): Promise<{ ok: true } | RequestError> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await executeInTransaction(client, viewerId, scope, input, fingerprint, allowed);
    await client.query("error" in result ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function executeInTransaction(client: PoolClient, viewerId: string, scope: ActionScope, input: unknown, fingerprint: string,
  allowed: Set<string>): Promise<{ ok: true } | RequestError> {
  const q: Query = (sql, params) => client.query(sql, params);
  if (!UUID.test(scope.objectId)) return NOT_FOUND;
  const row = (await q("SELECT * FROM requests WHERE id = $1 FOR UPDATE", [scope.objectId])).rows[0] as RequestRow | undefined;
  if (!row) return NOT_FOUND;
  const recipients = await readRecipients(q, row.id);
  const isInitiator = row.initiator_id === viewerId;
  const mine = row.status === "draft" ? undefined : recipients.find((recipient) => recipient.person_id === viewerId);
  if (!isInitiator && !mine) return NOT_FOUND;

  if (scope.actionType === "request.send") {
    if (!isInitiator) return failure(403, "FORBIDDEN", "只有发起人可以发送");
    if (scope.objectVersion !== row.version) return failure(409, "VERSION_CONFLICT", "草稿已经改过，请看过最新预览再发送");
    if (row.status !== "draft") return { ok: true };
    if (row.clarifications.some((item) => item.answer === null)) return failure(409, "REQUEST_CLARIFICATION_PENDING", "还有问题没回答");
    const ids = [...new Set((input as { recipientIds: string[] }).recipientIds)];
    if (ids.some((personId) => personId === viewerId || !allowed.has(personId))) return failure(400, "INVALID_RECIPIENT", "接收人不在名单里");
    await q("UPDATE requests SET status = 'open', sent_at = now(), updated_at = now() WHERE id = $1", [row.id]);
    for (const personId of ids) {
      await q("INSERT INTO request_recipients (request_id, person_id) VALUES ($1, $2)", [row.id, personId]);
      await insertNotification(client, { personId, kind: "request_received", objectType: "request", objectId: row.id, actorId: viewerId });
    }
    return { ok: true };
  }

  if (scope.actionType === "request.ask") {
    if (!mine || scope.itemId !== viewerId) return failure(403, "FORBIDDEN", "只有接收人可以提问");
    if (mine.status === "done") return failure(409, "REQUEST_ALREADY_DONE", "已经标记完成");
    await q(`INSERT INTO request_questions (id, request_id, asker_id, question, fingerprint) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (fingerprint) DO NOTHING`, [randomUUID(), row.id, viewerId, (input as { question: string }).question.trim(), fingerprint]);
    return { ok: true };
  }

  if (scope.actionType === "request.answer") {
    if (!isInitiator) return failure(403, "FORBIDDEN", "只有发起人可以回答");
    const question = (await q("SELECT * FROM request_questions WHERE id = $1 AND request_id = $2 FOR UPDATE", [scope.itemId ?? "", row.id])).rows[0] as QuestionRow | undefined;
    if (!question) return NOT_FOUND;
    const answer = (input as { answer: string }).answer.trim();
    if (question.answer !== null) return question.answer === answer ? { ok: true } : failure(409, "REQUEST_QUESTION_ANSWERED", "这个问题已经回答过了");
    await q("UPDATE request_questions SET answer = $2, answered_at = now(), merged_into_body = TRUE WHERE id = $1", [question.id, answer]);
    await q("UPDATE requests SET body = body || $2, version = version + 1, updated_at = now() WHERE id = $1", [row.id, supplementOf(question.question, answer)]);
    await insertNotification(client, { personId: question.asker_id, kind: "request_answered", objectType: "request", objectId: row.id, itemId: question.id, actorId: viewerId });
    return { ok: true };
  }

  if (scope.actionType === "request.mark_done") {
    if (!mine || scope.itemId !== viewerId) return failure(403, "FORBIDDEN", "只有接收人可以标记完成");
    if (mine.status === "done") return { ok: true };
    await q("UPDATE request_recipients SET status = 'done', done_by = $3, done_at = now() WHERE request_id = $1 AND person_id = $2", [row.id, viewerId, viewerId]);
    await q(`UPDATE requests SET status = 'done', updated_at = now() WHERE id = $1
      AND NOT EXISTS (SELECT 1 FROM request_recipients WHERE request_id = $1 AND status = 'pending')`, [row.id]);
    await insertNotification(client, { personId: row.initiator_id, kind: "request_done", objectType: "request", objectId: row.id, actorId: viewerId });
    return { ok: true };
  }
  return failure(404, "UNKNOWN_ACTION", "未注册的 actionType");
}
