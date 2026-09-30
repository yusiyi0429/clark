import type { Pool } from "pg";
import { Value } from "@sinclair/typebox/value";
import type { TPersonalMissionCardPayload } from "@warmap/contracts";
import type { MemoryPerson } from "./companyMemory.js";
import { MissionCardAnnotationCandidate, type MissionCardAnnotationAgent } from "./missionCardAnnotationAgent.js";
import { applyMissionCardRevision, type MissionCardAnnotationRow } from "./missionCardAnnotations.js";
import { fieldText, getPersonalMissionCard, visiblePersonalMissionCard } from "./personalMissionCards.js";
import { canApprove, missionCardWriteProblem, type MissionRoundPerson } from "./missionRounds.js";

export function createMissionCardAnnotationQueue(options: { pool: Pool; agent: MissionCardAnnotationAgent; people: () => MemoryPerson[];
  secret: string; now: () => Date; onError: (error: unknown) => void }) {
  const running = new Map<string, Promise<void>>(), requested = new Set<string>(), abort = new AbortController();
  const q = options.pool.query.bind(options.pool);
  const viewer = (authorId: string): MissionRoundPerson => ({ personId: authorId,
    role: options.people().find((person) => person.personId === authorId)?.roles.includes("ceo") ? "ceo" : "member" });

  async function claim(cardId: string): Promise<MissionCardAnnotationRow | null> {
    const client = await options.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`mission-annotation-card:${cardId}`]);
      const row = (await client.query(`SELECT * FROM mission_card_annotations WHERE card_id=$1 AND status IN ('queued','applying')
        ORDER BY (status='applying') DESC,created_at,id LIMIT 1 FOR UPDATE`, [cardId])).rows[0] as MissionCardAnnotationRow | undefined;
      if (!row || row.status === "applying" && options.now().getTime() - row.updated_at.getTime() < 10 * 60_000) {
        await client.query("COMMIT"); return null;
      }
      const applied = (await client.query("SELECT after_version FROM mission_card_revisions WHERE annotation_id=$1", [row.id])).rows[0];
      if (applied) {
        await client.query("UPDATE mission_card_annotations SET status='applied',applied_version=$2,note=NULL,updated_at=$3 WHERE id=$1", [row.id, applied.after_version, options.now()]);
        await client.query("COMMIT"); return claim(cardId);
      }
      const updated = (await client.query("UPDATE mission_card_annotations SET status='applying',attempts=attempts+1,updated_at=$2 WHERE id=$1 RETURNING *", [row.id, options.now()])).rows[0] as MissionCardAnnotationRow;
      await client.query("COMMIT"); return updated;
    } catch (cause) { await client.query("ROLLBACK").catch(() => undefined); throw cause; }
    finally { client.release(); }
  }

  async function process(cardId: string): Promise<boolean> {
    const row = await claim(cardId);
    if (!row) return false;
    const person = viewer(row.author_id);
    const captured = await visiblePersonalMissionCard(q, person, cardId);
    const sourceRound = captured?.round.window_seq;
    let previousError: string | null = null;
    for (let attempt = row.attempts; attempt <= 2; attempt++) {
      if (abort.signal.aborted) return false;
      if (attempt > row.attempts) await q("UPDATE mission_card_annotations SET attempts=$2,updated_at=$3 WHERE id=$1 AND status='applying'", [row.id, attempt, options.now()]);
      try {
        const visible = await visiblePersonalMissionCard(q, person, cardId);
        if (!visible || visible.card.owner_id !== person.personId && !canApprove(person, visible.round)
          || !!missionCardWriteProblem(visible.round, visible.card, options.now()) || visible.round.window_seq !== sourceRound) {
          const changed = visible && visible.round.window_seq !== sourceRound;
          await q("UPDATE mission_card_annotations SET status=$2,note=$3,updated_at=$4 WHERE id=$1 AND status='applying'",
            [row.id, changed ? "no_change" : "failed", changed ? "审核已重新开放，请重新批注；原备注已保留" : "当前正文只读或没有修改权限；待改批注已保留，请明确处理", options.now()]);
          return true;
        }
        const card = await getPersonalMissionCard(q, options.people(), options.secret, person, cardId, options.now());
        const mission = card && (card.payload as TPersonalMissionCardPayload).card.missions.find((item) => item.missionId === row.mission_id);
        if (!mission) throw new Error("任务已变化，请重新批注");
        const source = fieldText(mission, row.field);
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(3 * 60_000)]);
        const generated = await options.agent.generate({ cardId, missionId: row.mission_id, field: row.field, title: mission.title,
          source, version: mission.version, sourceAtAnnotation: row.source_text, quote: row.quote, prefix: row.prefix, suffix: row.suffix,
          body: row.body, question: row.question, options: row.options, answer: row.answer, authorId: row.author_id,
          clarifications: row.clarification_history.map((item) => ({ ...item,
            authorName: options.people().find((person) => person.personId === item.authorId)?.displayName ?? item.authorId })),
          authorName: options.people().find((item) => item.personId === row.author_id)?.displayName ?? row.author_id, previousError }, signal, q);
        if (signal.aborted) throw signal.reason;
        // 私聊可在生成期间完成同一批注；停止该次工作，避免重复写回或把已完成的批注报成失败。
        if ((await q("SELECT status FROM mission_card_annotations WHERE id=$1", [row.id])).rows[0]?.status !== "applying") return true;
        if (!Value.Check(MissionCardAnnotationCandidate, generated.candidate)) throw new Error("修改建议格式无效");
        const candidate = generated.candidate;
        if (candidate.action === "clarify") {
          if (candidate.proposed !== null || !candidate.question?.trim() || candidate.options.length < 2
            || candidate.options.some((option) => !option.trim())) throw new Error("澄清问题或选项不完整");
          await q(`UPDATE mission_card_annotations SET status='needs_clarification',question=$2,options=$3::jsonb,answer=NULL,note=NULL,updated_at=$4
            WHERE id=$1 AND status='applying'`, [row.id, candidate.question, JSON.stringify(candidate.options), options.now()]);
          return true;
        }
        if (candidate.action === "no_change") {
          if (candidate.proposed !== null || candidate.question !== null || candidate.options.length) throw new Error("无需修改的建议格式无效");
          await q("UPDATE mission_card_annotations SET status='no_change',note=$2,updated_at=$3 WHERE id=$1 AND status='applying'", [row.id, candidate.reason, options.now()]);
          return true;
        }
        if (candidate.proposed === null || candidate.question !== null || candidate.options.length) throw new Error("修改正文的建议格式无效");
        const applied = await applyMissionCardRevision(options.pool, options.people(), options.secret, person, cardId,
          { missionId: row.mission_id, field: row.field, sourceRound: sourceRound!, sourceVersion: mission.version, sourceText: source, proposed: candidate.proposed,
            reason: candidate.reason, annotationId: row.id, clientId: row.id }, options.now);
        if ("error" in applied) {
          if (applied.error.code === "ROUND_CHANGED") {
            await q("UPDATE mission_card_annotations SET status='saved',note=$2,updated_at=$3 WHERE id=$1 AND status='applying'", [row.id, "审核已重新开放，请重新批注；原备注已保留", options.now()]);
            return true;
          }
          if (applied.error.code === "MISSION_CARD_UNCHANGED") {
            await q("UPDATE mission_card_annotations SET status='no_change',note=$2,updated_at=$3 WHERE id=$1 AND status='applying'", [row.id, "原文已满足这条批注", options.now()]);
            return true;
          }
          throw new Error(applied.error.message);
        }
        return true;
      } catch (cause) {
        if (abort.signal.aborted) return false;
        if ((await q("SELECT status FROM mission_card_annotations WHERE id=$1", [row.id])).rows[0]?.status !== "applying") return true;
        previousError = cause instanceof Error ? cause.message : "Co-Agent 暂时无法修改";
      }
    }
    await q("UPDATE mission_card_annotations SET status='failed',note=$2,updated_at=$3 WHERE id=$1 AND status='applying'",
      [row.id, previousError ?? "Co-Agent 暂时无法修改，请重试", options.now()]);
    return true;
  }

  function enqueue(cardId: string): Promise<void> {
    if (abort.signal.aborted) return Promise.resolve();
    requested.add(cardId);
    const existing = running.get(cardId);
    if (existing) return existing;
    const work = (async () => {
      do { requested.delete(cardId); while (!abort.signal.aborted && await process(cardId)) { /* 顺序处理同卡批注。 */ } }
      while (requested.has(cardId) && !abort.signal.aborted);
    })().catch(options.onError).finally(() => {
      running.delete(cardId);
      if (requested.has(cardId) && !abort.signal.aborted) void enqueue(cardId);
    });
    running.set(cardId, work); return work;
  }
  async function recover() {
    const rows = await q(`SELECT DISTINCT card_id FROM mission_card_annotations WHERE status='queued'
      OR (status='applying' AND updated_at<$1)`, [new Date(options.now().getTime() - 10 * 60_000)]);
    for (const row of rows.rows) void enqueue(row.card_id);
  }
  return { enqueue, recover, async close() { abort.abort(new Error("mission annotation queue closing")); await Promise.all(running.values()); } };
}
