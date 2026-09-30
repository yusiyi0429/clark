import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  TCreateMissionCardAnnotationRequest, TMissionCardAnnotationView, TMissionCardAnnotationsResponse,
  TMissionCardField, TPersonalMissionCardPayload, TMissionCardRevisionView,
} from "@warmap/contracts";
import type { MemoryPerson } from "./companyMemory.js";
import type { Query } from "./meetingStore.js";
import { canApprove, correctionPeriodClosed, writeMissionFields, type MissionRoundPerson } from "./missionRounds.js";
import { fieldText, getPersonalMissionCard, normalizedProposal, proposalProblem, visiblePersonalMissionCard } from "./personalMissionCards.js";

export type MissionCardAnnotationRow = {
  id: string; card_id: string; mission_id: string; field: TMissionCardField; source_version: number;
  source_text: string; quote: string; prefix: string; suffix: string; start_offset: number; body: string;
  author_id: string; client_id: string; created_at: Date;
  status: TMissionCardAnnotationView["status"]; question: string | null; options: string[]; answer: string | null;
  note: string | null; applied_version: number | null; attempts: number; updated_at: Date;
  clarification_history: { question: string; answer: string; authorId: string; createdAt: string }[];
};
type AnnotationRow = MissionCardAnnotationRow;
type RevisionRow = { id: string; card_id: string; mission_id: string; field: TMissionCardField; before_text: string; after_text: string;
  reason: string; source: "annotation" | "agent"; author_id: string; client_id: string; annotation_id: string | null;
  before_version: number; after_version: number; created_at: Date };
type Failure = { error: { status: number; code: string; message: string } };
type Outcome = { annotation: TMissionCardAnnotationView } | Failure;
const fail = (status: number, code: string, message: string): Failure => ({ error: { status, code, message } });
const notVisible = () => fail(404, "PERSONAL_MISSION_CARD_NOT_FOUND", "任务卡不存在或不可见");

function view(row: AnnotationRow, missions: TPersonalMissionCardPayload["card"]["missions"], people: MemoryPerson[], person: MissionRoundPerson,
  approver: boolean, ownerId?: string, readOnly = false): TMissionCardAnnotationView {
  const mission = missions.find((item) => item.missionId === row.mission_id);
  const canWrite = !readOnly && (approver || (ownerId ?? mission?.ownerId) === person.personId);
  const canRespond = canWrite && (row.author_id === person.personId || approver);
  return {
    id: row.id, cardId: row.card_id, missionId: row.mission_id, field: row.field,
    sourceVersion: row.source_version, sourceText: row.source_text, quote: row.quote,
    prefix: row.prefix, suffix: row.suffix, startOffset: row.start_offset, body: row.body,
    authorId: row.author_id, authorName: people.find((person) => person.personId === row.author_id)?.displayName ?? row.author_id,
    status: row.status, question: row.question, options: row.options, answer: row.answer, note: row.note, appliedVersion: row.applied_version,
    canAnswer: canRespond && row.status === "needs_clarification", canRetry: canRespond && row.status === "failed",
    clarifications: row.clarification_history.map((item) => ({ ...item,
      authorName: people.find((author) => author.personId === item.authorId)?.displayName ?? item.authorId })),
    stale: !mission || fieldText(mission, row.field) !== row.source_text,
    createdAt: row.created_at.toISOString(),
  };
}

/** 每次读取都重新检查卡可见性；成员可见的正文批注不成为群聊消息。 */
export async function listMissionCardAnnotations(q: Query, people: MemoryPerson[], secret: string,
  person: MissionRoundPerson, cardId: string, now: Date): Promise<TMissionCardAnnotationsResponse | null> {
  const card = await getPersonalMissionCard(q, people, secret, person, cardId, now);
  if (!card) return null;
  const missions = (card.payload as TPersonalMissionCardPayload).card.missions;
  const approver = (card.payload as TPersonalMissionCardPayload).round.approver;
  const rows = (await q("SELECT * FROM mission_card_annotations WHERE card_id=$1 ORDER BY created_at,id", [cardId])).rows as AnnotationRow[];
  const payload = card.payload as TPersonalMissionCardPayload;
  return { annotations: rows.map((row) => view(row, missions, people, person, approver, payload.card.ownerId,
    payload.round.phase === "drafting" || correctionPeriodClosed(payload.round, now))), revisions: await listMissionCardRevisions(q, people, secret, person, cardId, now) ?? [] };
}

function sameInput(row: AnnotationRow, cardId: string, input: TCreateMissionCardAnnotationRequest): boolean {
  return row.card_id === cardId && row.mission_id === input.missionId && row.field === input.field
    && row.source_version === input.sourceVersion && row.source_text === input.sourceText && row.quote === input.quote
    && row.prefix === input.prefix && row.suffix === input.suffix && row.start_offset === input.startOffset && row.body === input.body;
}

/** 只保存批注。锁定阶段及 Mission 后核对正在显示的字段，防候选正文在相同 Mission 版本中变化。 */
export async function createMissionCardAnnotation(pool: Pool, people: MemoryPerson[], secret: string,
  person: MissionRoundPerson, cardId: string, request: TCreateMissionCardAnnotationRequest, now: () => Date,
  clarification?: { question: string; options: string[] }): Promise<Outcome> {
  const input = { ...request, body: request.body.trim(), quote: request.quote.trim() };
  const client = await pool.connect();
  const q: Query = (sql, params) => client.query(sql, params);
  const finish = async (outcome: Outcome) => { await client.query("COMMIT"); return outcome; };
  try {
    await client.query("BEGIN");
    await q("SELECT pg_advisory_xact_lock(hashtext($1))", [`mission-annotation:${person.personId}:${input.clientId}`]);
    const visible = await visiblePersonalMissionCard(q, person, cardId);
    if (!visible) return await finish(notVisible());
    await q("SELECT id FROM mission_rounds WHERE id=$1 FOR SHARE", [visible.round.id]);
    if (!await visiblePersonalMissionCard(q, person, cardId)) return await finish(notVisible());
    const locked = await q("SELECT id FROM missions WHERE id=$1 AND personal_mission_card_id=$2 FOR SHARE", [input.missionId, cardId]);
    if (!locked.rowCount) return await finish(fail(404, "MISSION_NOT_FOUND", "任务不存在或不属于这张卡"));
    const card = await getPersonalMissionCard(q, people, secret, person, cardId, now());
    if (!card) return await finish(notVisible());
    const missions = (card.payload as TPersonalMissionCardPayload).card.missions;
    const approver = (card.payload as TPersonalMissionCardPayload).round.approver;
    const prior = (await q("SELECT * FROM mission_card_annotations WHERE author_id=$1 AND client_id=$2", [person.personId, input.clientId])).rows[0] as AnnotationRow | undefined;
    if (prior) return await finish(sameInput(prior, cardId, input)
      ? { annotation: view(prior, missions, people, person, approver, visible.card.owner_id,
        visible.round.status === "drafting" || correctionPeriodClosed(visible.round, now())) }
      : fail(409, "CLIENT_ID_CONFLICT", "同一个批注编号已提交不同的内容"));
    if (!input.body || !input.quote || [input.sourceText, input.quote, input.prefix, input.suffix, input.body].some((text) => text.includes("\u0000")))
      return await finish(fail(400, "INVALID_MISSION_CARD_ANNOTATION", "请填写有效的选中文字和批注"));
    const mission = missions.find((item) => item.missionId === input.missionId);
    if (!mission) return await finish(fail(404, "MISSION_NOT_FOUND", "任务不存在或不属于这张卡"));
    if (mission.version !== input.sourceVersion)
      return await finish(fail(409, "SOURCE_VERSION_CONFLICT", "任务版本已变化，请刷新后重新批注；输入已保留"));
    if (fieldText(mission, input.field) !== input.sourceText)
      return await finish(fail(409, "SOURCE_TEXT_CONFLICT", "这段正文已变化，请重新划选后提交；输入已保留"));
    if (clarification && (!clarification.question.trim() || clarification.question.length > 1000 || clarification.question.includes("\u0000")
      || clarification.options.length < 2 || clarification.options.length > 4 || clarification.options.some((option) => !option.trim() || option.length > 200 || option.includes("\u0000"))))
      return await finish(fail(400, "INVALID_CLARIFICATION", "请提供清楚的问题和 2–4 个选项"));
    const writable = (approver || visible.card.owner_id === person.personId) && visible.round.status !== "drafting"
      && !correctionPeriodClosed(visible.round, now());
    const status = !writable ? "saved" : clarification ? "needs_clarification" : "queued";
    // Markdown 的渲染纯文字与源码不同，quote/context/offset 仅作前端定位提示，不当作源码偏移。
    const inserted = (await q(`INSERT INTO mission_card_annotations
      (id,card_id,mission_id,field,source_version,source_text,quote,prefix,suffix,start_offset,body,author_id,client_id,created_at,updated_at,status,question,options,note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16,$17::jsonb,$18) RETURNING *`,
    [randomUUID(), cardId, input.missionId, input.field, input.sourceVersion, input.sourceText,
      input.quote, input.prefix, input.suffix, input.startOffset, input.body, person.personId, input.clientId, now(), status,
      clarification?.question.trim() ?? null, JSON.stringify(clarification?.options.map((option) => option.trim()) ?? []),
      writable ? null : correctionPeriodClosed(visible.round, now()) ? "批注已保存；月份已过，正文只读"
        : visible.round.status === "drafting" ? "批注已保存；请等待草稿整理完成" : "批注已保存；只有任务负责人或拍板人可以修改正文"])).rows[0] as AnnotationRow;
    return await finish({ annotation: view(inserted, missions, people, person, approver, visible.card.owner_id,
      visible.round.status === "drafting" || correctionPeriodClosed(visible.round, now())) });
  } catch (cause) { await client.query("ROLLBACK").catch(() => undefined); throw cause; }
  finally { client.release(); }
}

function revisionView(row: RevisionRow, people: MemoryPerson[]): TMissionCardRevisionView {
  return { id: row.id, cardId: row.card_id, missionId: row.mission_id, field: row.field,
    before: row.before_text, after: row.after_text, reason: row.reason, source: row.source,
    authorId: row.author_id, authorName: people.find((person) => person.personId === row.author_id)?.displayName ?? row.author_id,
    annotationId: row.annotation_id, beforeVersion: row.before_version, afterVersion: row.after_version, createdAt: row.created_at.toISOString() };
}

export async function listMissionCardRevisions(q: Query, people: MemoryPerson[], _secret: string,
  person: MissionRoundPerson, cardId: string, _now: Date): Promise<TMissionCardRevisionView[] | null> {
  if (!await visiblePersonalMissionCard(q, person, cardId)) return null;
  const rows = (await q("SELECT * FROM mission_card_revisions WHERE card_id=$1 ORDER BY created_at DESC,id DESC", [cardId])).rows as RevisionRow[];
  return rows.map((row) => revisionView(row, people));
}

export type MissionCardRevisionInput = { missionId: string; field: TMissionCardField; sourceVersion: number; sourceText: string;
  proposed: string; reason: string; annotationId?: string; clientId: string };

/** 批注与私聊共用的即时写回。原文和前后版本始终留痕；写前重新检查身份、当前展示原文和版本。 */
export async function applyMissionCardRevision(pool: Pool, people: MemoryPerson[], secret: string, person: MissionRoundPerson,
  cardId: string, request: MissionCardRevisionInput, now: () => Date, source: "annotation" | "agent" = "annotation"):
  Promise<{ revision: TMissionCardRevisionView } | Failure> {
  const client = await pool.connect(); const q: Query = (sql, params) => client.query(sql, params);
  const proposed = normalizedProposal(request.field, request.proposed), reason = request.reason.trim();
  const finish = async <T,>(outcome: T) => { await q("COMMIT"); return outcome; };
  try {
    await q("BEGIN");
    await q("SELECT pg_advisory_xact_lock(hashtext($1))", [`mission-revision:${person.personId}:${request.clientId}`]);
    let visible = await visiblePersonalMissionCard(q, person, cardId);
    if (!visible) return await finish(notVisible());
    await q("SELECT id FROM mission_rounds WHERE id=$1 FOR UPDATE", [visible.round.id]);
    visible = await visiblePersonalMissionCard(q, person, cardId);
    if (!visible) return await finish(notVisible());
    if (visible.card.owner_id !== person.personId && !canApprove(person, visible.round))
      return await finish(fail(403, "MISSION_CARD_READ_ONLY", "只有任务负责人或拍板人可以修改正文"));
    if (correctionPeriodClosed(visible.round, now())) return await finish(fail(409, "MISSION_CARD_PERIOD_CLOSED", "月份已过，正文只读"));
    if (visible.round.status === "drafting") return await finish(fail(409, "MISSION_CARD_DRAFTING", "请等待草稿整理完成后修改"));
    const locked = await q("SELECT id FROM missions WHERE id=$1 AND personal_mission_card_id=$2 FOR UPDATE", [request.missionId, cardId]);
    if (!locked.rowCount) return await finish(fail(404, "MISSION_NOT_FOUND", "任务不存在或不属于这张卡"));
    const prior = (await q("SELECT * FROM mission_card_revisions WHERE author_id=$1 AND client_id=$2", [person.personId, request.clientId])).rows[0] as RevisionRow | undefined;
    if (prior) {
      const same = prior.card_id === cardId && prior.mission_id === request.missionId && prior.field === request.field
        && prior.before_version === request.sourceVersion && prior.before_text === request.sourceText && prior.after_text === proposed
        && prior.reason === reason && prior.source === source && prior.annotation_id === (request.annotationId ?? null);
      return await finish(same ? { revision: revisionView(prior, people) } : fail(409, "CLIENT_ID_CONFLICT", "同一个修改编号已用于不同的内容"));
    }
    const card = await getPersonalMissionCard(q, people, secret, person, cardId, now());
    if (!card) return await finish(notVisible());
    const mission = (card.payload as TPersonalMissionCardPayload).card.missions.find((item) => item.missionId === request.missionId)!;
    if (mission.version !== request.sourceVersion) return await finish(fail(409, "SOURCE_VERSION_CONFLICT", "正文版本已变化，请重新读取后修改"));
    if (fieldText(mission, request.field) !== request.sourceText) return await finish(fail(409, "SOURCE_TEXT_CONFLICT", "这段正文已变化，请重新读取后修改"));
    if (proposed === request.sourceText) return await finish(fail(400, "MISSION_CARD_UNCHANGED", "修改前后的文字相同"));
    const problem = !proposed ? "修改后的文字不能为空" : proposalProblem(request.field, proposed)
      ?? (!["successEvidence", "milestones"].includes(request.field) && proposed.length > 4000 ? "这个字段最多 4000 字" : null);
    if (problem || !reason || reason.length > 1000 || [proposed, reason].some((text) => text.includes("\u0000")))
      return await finish(fail(400, "INVALID_MISSION_CARD_REVISION", problem ?? "请填写有效的修改原因"));
    if (request.annotationId) {
      const annotation = (await q("SELECT * FROM mission_card_annotations WHERE id=$1 AND card_id=$2 FOR UPDATE", [request.annotationId, cardId])).rows[0] as AnnotationRow | undefined;
      if (!annotation || annotation.mission_id !== request.missionId || annotation.field !== request.field || annotation.author_id !== person.personId)
        return await finish(fail(404, "ANNOTATION_NOT_FOUND", "批注不存在或不属于这处正文"));
      if (source === "annotation" && annotation.status !== "applying") return await finish(fail(409, "ANNOTATION_NOT_APPLYING", "批注已处理或不在修改中"));
      if (source === "agent" && annotation.status === "applied") return await finish(fail(409, "ANNOTATION_ALREADY_PROCESSED", "这条批注已经改过正文"));
    }
    const at = now();
    const afterVersion = await writeMissionFields(client, request.missionId, [{ field: request.field, proposed }], at);
    if (visible.round.status === "reviewing") {
      // 即时改写已进入正文；更新快照版本。候选叠加和确认按修订时间判断，不改写人提交的历史建议。
      await q(`UPDATE mission_round_reviews SET mission_versions=jsonb_set(mission_versions,ARRAY[$2]::text[],$3::jsonb)
        WHERE round_id=$1 AND window_seq=$4 AND superseded_at IS NULL`, [visible.round.id, request.missionId, JSON.stringify(afterVersion), visible.round.window_seq]);
    }
    const inserted = (await q(`INSERT INTO mission_card_revisions
      (id,card_id,mission_id,field,before_text,after_text,reason,source,author_id,client_id,annotation_id,before_version,after_version,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [randomUUID(), cardId, request.missionId, request.field, request.sourceText, proposed, reason, source, person.personId,
      request.clientId, request.annotationId ?? null, request.sourceVersion, afterVersion, at])).rows[0] as RevisionRow;
    if (request.annotationId) await q("UPDATE mission_card_annotations SET status='applied',applied_version=$2,note=NULL,updated_at=$3 WHERE id=$1", [request.annotationId, afterVersion, at]);
    await q("UPDATE mission_rounds SET version=version+1,updated_at=$2 WHERE id=$1", [visible.round.id, at]);
    return await finish({ revision: revisionView(inserted, people) });
  } catch (cause) { await q("ROLLBACK").catch(() => undefined); throw cause; }
  finally { client.release(); }
}

export function createMissionCardClarification(pool: Pool, people: MemoryPerson[], secret: string, person: MissionRoundPerson,
  cardId: string, input: TCreateMissionCardAnnotationRequest & { question: string; options: string[] }, now: () => Date) {
  const { question, options, ...annotation } = input;
  return createMissionCardAnnotation(pool, people, secret, person, cardId, annotation, now, { question, options });
}

export async function respondMissionCardAnnotation(pool: Pool, people: MemoryPerson[], secret: string, person: MissionRoundPerson,
  cardId: string, annotationId: string, answer: string | null, now: () => Date): Promise<Outcome> {
  const client = await pool.connect(); const q: Query = (sql, params) => client.query(sql, params);
  const finish = async (outcome: Outcome) => { await q("COMMIT"); return outcome; };
  try {
    await q("BEGIN");
    const visible = await visiblePersonalMissionCard(q, person, cardId);
    if (!visible) return await finish(notVisible());
    const row = (await q("SELECT * FROM mission_card_annotations WHERE id=$1 AND card_id=$2 FOR UPDATE", [annotationId, cardId])).rows[0] as AnnotationRow | undefined;
    if (!row) return await finish(fail(404, "ANNOTATION_NOT_FOUND", "批注不存在"));
    const card = await getPersonalMissionCard(q, people, secret, person, cardId, now());
    if (!card) return await finish(notVisible());
    const payload = card.payload as TPersonalMissionCardPayload;
    const canWrite = visible.card.owner_id === person.personId || payload.round.approver;
    if (!canWrite || row.author_id !== person.personId && !payload.round.approver)
      return await finish(fail(403, "ANNOTATION_RESPONSE_FORBIDDEN", "请由批注作者或拍板人回答"));
    if (correctionPeriodClosed(visible.round, now()) || visible.round.status === "drafting")
      return await finish(fail(409, "MISSION_CARD_READ_ONLY", "这张卡当前只读，批注已保留"));
    const trimmed = answer?.trim() ?? null;
    if (answer !== null && (!trimmed || trimmed.length > 4000 || trimmed.includes("\u0000")))
      return await finish(fail(400, "INVALID_CLARIFICATION_ANSWER", "请填写有效的回答"));
    if (answer !== null && row.answer === trimmed && ["queued", "applying", "applied", "no_change"].includes(row.status))
      return await finish({ annotation: view(row, payload.card.missions, people, person, payload.round.approver, visible.card.owner_id) });
    const expected = answer === null ? "failed" : "needs_clarification";
    if (row.status !== expected) return await finish(fail(409, "ANNOTATION_ALREADY_PROCESSED", answer === null ? "这条批注当前不需要重试" : "这个问题已回答或已失效"));
    const at = now();
    const history = trimmed === null ? row.clarification_history : [...row.clarification_history,
      { question: row.question ?? "", answer: trimmed, authorId: person.personId, createdAt: at.toISOString() }];
    const updated = (await q(`UPDATE mission_card_annotations SET status='queued',answer=COALESCE($2,answer),note=NULL,attempts=0,updated_at=$3,clarification_history=$4::jsonb
      WHERE id=$1 RETURNING *`, [annotationId, trimmed, at, JSON.stringify(history)])).rows[0] as AnnotationRow;
    return await finish({ annotation: view(updated, payload.card.missions, people, person, payload.round.approver, visible.card.owner_id) });
  } catch (cause) { await q("ROLLBACK").catch(() => undefined); throw cause; }
  finally { client.release(); }
}
