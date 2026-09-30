import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { TCreateMissionCardCorrectionRequest, TDecideMissionCardCorrectionRequest, TMissionCardCorrectionView } from "@warmap/contracts";
import type { MemoryPerson } from "./companyMemory.js";
import type { Query } from "./meetingStore.js";
import { canApprove, correctionPeriodClosed, type MissionRoundPerson } from "./missionRounds.js";
import { currentMissions, fieldText, normalizedProposal, projectCorrection, proposalProblem, visiblePersonalMissionCard, type CorrectionRow } from "./personalMissionCards.js";

type Failure = { error: { status: number; code: string; message: string } };
type Outcome = { correction: TMissionCardCorrectionView } | Failure;
const fail = (status: number, code: string, message: string): Failure => ({ error: { status, code, message } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notVisible = () => fail(404, "PERSONAL_MISSION_CARD_NOT_FOUND", "任务卡不存在或不可见");
const periodClosed = () => fail(409, "CORRECTION_PERIOD_CLOSED", "月份已过，这张卡只读；要改的放进下个月的任务卡");

/**
 * 已确定任务卡的更正只保留本人的申请；实质改文必须退回本人确认，不绕过冻结。
 * 同一 author+clientId 重放返回同一条，内容不同则冲突。
 */
export async function createMissionCardCorrection(
  pool: Pool, people: MemoryPerson[], secret: string, person: MissionRoundPerson, cardId: string,
  request: TCreateMissionCardCorrectionRequest, now: () => Date,
): Promise<Outcome> {
  const client = await pool.connect(); const q: Query = (sql, params) => client.query(sql, params);
  const proposed = normalizedProposal(request.field, request.proposed), reason = request.reason.trim();
  const finish = async (outcome: Outcome) => { await client.query("COMMIT"); return outcome; };
  try {
    await client.query("BEGIN");
    // Serializes retries of one author/client pair, including reuse across cards.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`mission-correction:${person.personId}:${request.clientId}`]);
    const visible = await visiblePersonalMissionCard(q, person, cardId);
    if (!visible) return await finish(notVisible());
    // 原文、版本的判断与写回都在这把 Mission 行锁之下。
    const locked = await q("SELECT id FROM missions WHERE id=$1 AND personal_mission_card_id=$2 FOR UPDATE", [request.missionId, cardId]);
    if (!locked.rowCount) return await finish(fail(404, "MISSION_NOT_FOUND", "个人任务不存在或不属于这张卡"));
    const missions = await currentMissions(q, cardId, people, secret);
    const prior = (await q("SELECT * FROM mission_card_corrections WHERE author_id=$1 AND client_id=$2", [person.personId, request.clientId])).rows[0] as CorrectionRow | undefined;
    if (prior) {
      const same = prior.card_id === cardId && prior.mission_id === request.missionId && prior.field === request.field
        && prior.proposed === proposed && prior.reason === reason;
      return await finish(same ? { correction: projectCorrection(prior, missions, people) } : fail(409, "CLIENT_ID_CONFLICT", "同一个 client_id 已提交不同的更正"));
    }
    const { round } = visible; const at = now();
    if (visible.card.owner_id !== person.personId) return await finish(fail(403, "OWNER_RECONFIRMATION_REQUIRED", "请退回这张任务卡，由本人处理修改并重新确认"));
    if (round.status !== "confirmed") return await finish(fail(409, "CORRECTION_NOT_CONFIRMED", "任务尚未最终确定，请本人在准备期间批注或与 Agent 沟通"));
    if (correctionPeriodClosed(round, at)) return await finish(periodClosed());
    const mission = missions.find((item) => item.missionId === request.missionId)!;
    if (mission.version !== request.sourceVersion) return await finish(fail(409, "SOURCE_VERSION_CONFLICT", "页面版本已变化，请刷新后重新提交"));
    const problem = proposed ? proposalProblem(request.field, proposed) : "请填写改后的文字";
    if (problem) return await finish(fail(400, "INVALID_CORRECTION", problem));
    const original = fieldText(mission, request.field);
    if (proposed === original) return await finish(fail(400, "CORRECTION_UNCHANGED", "新文字和原文一样"));
    if (!reason) return await finish(fail(400, "INVALID_CORRECTION", "请写明更正原因"));
    const inserted = (await q(`INSERT INTO mission_card_corrections
      (id,round_id,card_id,mission_id,field,original,proposed,reason,author_id,client_id,direct,status,decided_by,decided_at,applied_version,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [randomUUID(), round.id, cardId, mission.missionId, request.field, original, proposed, reason, person.personId, request.clientId,
      false, "pending", null, null, null, at])).rows[0] as CorrectionRow;
    return await finish({ correction: projectCorrection(inserted, missions, people) });
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

/** 拍板人逐条处理申请。加锁顺序与直接更正一致：先 Mission 行，再更正行。 */
export async function decideMissionCardCorrection(
  pool: Pool, people: MemoryPerson[], secret: string, person: MissionRoundPerson, cardId: string, correctionId: string,
  request: TDecideMissionCardCorrectionRequest, now: () => Date,
): Promise<Outcome> {
  const client = await pool.connect(); const q: Query = (sql, params) => client.query(sql, params);
  const note = request.note?.trim() || null;
  const finish = async (outcome: Outcome) => { await client.query("COMMIT"); return outcome; };
  try {
    await client.query("BEGIN");
    const visible = await visiblePersonalMissionCard(q, person, cardId);
    if (!visible) return await finish(notVisible());
    if (!canApprove(person, visible.round)) return await finish(fail(403, "FORBIDDEN", "只有本战场 DRI 能处理更正申请"));
    const target = UUID.test(correctionId)
      ? (await q("SELECT mission_id FROM mission_card_corrections WHERE id=$1 AND card_id=$2", [correctionId, cardId])).rows[0] as { mission_id: string } | undefined : undefined;
    if (!target) return await finish(fail(404, "CORRECTION_NOT_FOUND", "更正不存在或不属于这张卡"));
    await q("SELECT id FROM missions WHERE id=$1 FOR UPDATE", [target.mission_id]);
    const row = (await q("SELECT * FROM mission_card_corrections WHERE id=$1 FOR UPDATE", [correctionId])).rows[0] as CorrectionRow;
    const at = now();
    if (visible.round.status !== "confirmed") return await finish(fail(409, "CORRECTION_NOT_CONFIRMED", "任务已退回本人处理，原申请与决定保留在历史中"));
    if (correctionPeriodClosed(visible.round, at)) return await finish(periodClosed());
    const missions = await currentMissions(q, cardId, people, secret);
    if (row.status !== "pending") {
      const same = row.status === (request.decision === "apply" ? "applied" : "rejected");
      return await finish(same ? { correction: projectCorrection(row, missions, people) } : fail(409, "CORRECTION_DECIDED", "这条更正已经处理过"));
    }
    if (request.decision === "reject") {
      if (!note) return await finish(fail(400, "CORRECTION_NOTE_REQUIRED", "不采纳要写一句原因"));
      const rejected = (await q("UPDATE mission_card_corrections SET status='rejected',decided_by=$2,decided_at=$3,note=$4 WHERE id=$1 RETURNING *",
        [row.id, person.personId, at, note])).rows[0] as CorrectionRow;
      return await finish({ correction: projectCorrection(rejected, missions, people) });
    }
    return await finish(fail(409, "OWNER_RECONFIRMATION_REQUIRED", "采纳更正需退回这张任务卡，由本人处理修改并重新确认"));
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}
