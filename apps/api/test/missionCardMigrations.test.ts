import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.js";
import { createTestDb, type TestDb } from "./helpers.js";

const NOW = "2026-10-01T00:00:00.000Z";

async function seedRound(db: TestDb["db"]) {
  const planId = randomUUID();
  const roundId = randomUUID();
  await db.query(
    `INSERT INTO monthly_plans (id, version, period, status, company_outcome, battlefields, todos, negotiation, generation)
     VALUES ($1, 1, '2026-10', 'confirmed', '本月结果', '[]', '[]', '{}', '{}')`, [planId],
  );
  await db.query(
    `INSERT INTO mission_rounds (id, version, battlefield_id, period, monthly_plan_id, status, draft_origin, draft_source, created_at, updated_at)
     VALUES ($1, 1, 'growth', '2026-10', $2, 'draft', 'placeholder', '{}', $3, $3)`,
    [roundId, planId, NOW],
  );
  return { planId, roundId };
}

describe("Mission Card database invariants", () => {
  it("enforces one round per battlefield/month and a fixed window consistent with its phase", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const { roundId, planId } = await seedRound(db);
      const update = (sql: string) => db.query(`UPDATE mission_rounds SET ${sql} WHERE id = $1`, [roundId]);
      expect((await db.query("SELECT window_seq FROM mission_rounds WHERE id = $1", [roundId])).rows[0].window_seq).toBe(0);
      await expect(db.query(
        `INSERT INTO mission_rounds (id, version, battlefield_id, period, monthly_plan_id, status, draft_origin, draft_source, created_at, updated_at)
         VALUES ($1, 1, 'growth', '2026-10', $2, 'draft', 'placeholder', '{}', $3, $3)`,
        [randomUUID(), planId, NOW],
      )).rejects.toMatchObject({ code: "23505" });
      for (const sql of [
        "opened_at = '2026-10-01T00:00:00Z'",
        "status = 'open'",
        "opened_at = '2026-10-01T00:00:00Z', closes_at = '2026-10-03T00:00:00Z'",
        "status = 'open', opened_at = '2026-10-01T00:00:00Z', closes_at = '2026-10-02T23:59:59.999Z'",
        "period = '2026-13'", "version = 0", "window_seq = -1", "confirmed_at = '2026-10-01T00:00:00Z'",
      ]) await expect(update(sql)).rejects.toMatchObject({ code: "23514" });
      await update("status = 'open', window_seq = 1, first_opened_at = '2026-10-01T00:00:00Z', opened_at = '2026-10-01T00:00:00Z', closes_at = '2026-10-03T00:00:00Z'");
      await update("status = 'reviewing'");
      await expect(update("status = 'confirmed'")).rejects.toMatchObject({ code: "23514" });
      await update("status = 'confirmed', confirmed_at = '2026-10-03T01:00:00Z', confirmed_by = 'ceo'");
      await expect(db.query("DELETE FROM battlefield_config WHERE id = 'growth'")).rejects.toMatchObject({ code: "23503" });
    });
  });

  it("preserves card identity and constrains public feedback, review snapshots and read positions", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const { roundId } = await seedRound(db);
      const cardId = randomUUID();
      const insertCard = (id: string) => db.query(
        "INSERT INTO personal_mission_cards (id, round_id, owner_id, sort_order, member_ids, created_at) VALUES ($1, $2, 'owner', 0, '[\"owner\",\"ceo\"]', $3)",
        [id, roundId, NOW],
      );
      await insertCard(cardId);
      await expect(insertCard(randomUUID())).rejects.toMatchObject({ code: "23505" });
      await db.query(
        `INSERT INTO missions (id, version, code, period, title, owner_id, capability_id, outcome, source_ref, source_document_id, source_revision, source_title, personal_mission_card_id)
         VALUES ('mission-a', 1, 'mission-a', '2026-10', '个人结果', 'owner', 'agents', '结果', 'ref', 'doc', 1, '来源', $1)`, [cardId],
      );
      const fields = (await db.query("SELECT key_path, resources, human_agent_split, retrospect, placeholder FROM missions WHERE id = 'mission-a'")).rows[0];
      expect(fields).toEqual({ key_path: "", resources: "", human_agent_split: "", retrospect: "", placeholder: false });
      const feedback = (overrides: Record<string, unknown> = {}) => {
        const row = {
          id: randomUUID(), round_id: roundId, card_id: cardId, mission_id: null, field: null,
          kind: "comment", author_id: "owner", client_id: randomUUID(), body: "公开意见", quote: null,
          proposed: null, original: null, source_version: null, basis: "draft", window_seq: 1, late: false, created_at: NOW,
          ...overrides,
        };
        const keys = Object.keys(row);
        return db.query(`INSERT INTO mission_card_feedback (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id, seq`, Object.values(row));
      };
      const clientId = randomUUID();
      const comment = await feedback({ client_id: clientId });
      await expect(feedback({ client_id: clientId })).rejects.toMatchObject({ code: "23505" });
      await feedback({ client_id: clientId, author_id: "ceo", late: true, basis: "candidate" });
      const suggestion = { kind: "suggestion", mission_id: "mission-a", field: "outcome", proposed: "改后结果", original: "结果", source_version: 1 };
      await feedback(suggestion);
      await feedback({ kind: "quote", mission_id: "mission-a", field: "outcome", quote: "结果", source_version: 1 });
      for (const invalid of [
        { kind: "other" }, { field: "outcome" }, { quote: "不属于评论" }, { proposed: "不属于评论" },
        { body: "" }, { body: "字".repeat(4001) }, { quote: "字".repeat(2001) }, { window_seq: 0 },
        { ...suggestion, late: true }, { ...suggestion, mission_id: null }, { ...suggestion, field: null },
        { ...suggestion, field: "ownerId" }, { ...suggestion, proposed: null }, { ...suggestion, original: null },
        { ...suggestion, source_version: null }, { ...suggestion, source_version: 0 },
        { kind: "quote", mission_id: "mission-a", field: "outcome", quote: "结果" },
      ]) await expect(feedback(invalid)).rejects.toMatchObject({ code: "23514" });
      for (const field of ["title", "why", "outcome", "successEvidence", "boundaries", "keyPath", "milestones", "resources", "dependencies", "humanAgentSplit", "risk", "retrospect"]) {
        await feedback({ ...suggestion, field });
      }
      const reviewId = randomUUID();
      const review = (id: string) => db.query(
        `INSERT INTO mission_round_reviews (id, round_id, window_seq, snapshot_at, taken_at, feedback_ids, mission_versions)
         VALUES ($1, $2, 1, $3, $3, $4, '{"mission-a":1}')`,
        [id, roundId, NOW, JSON.stringify([comment.rows[0].id])],
      );
      await review(reviewId);
      await expect(review(randomUUID())).rejects.toMatchObject({ code: "23505" });
      const decision = (value: string) => db.query(
        "INSERT INTO mission_review_decisions (review_id, feedback_id, decision, decided_by, decided_at, carried) VALUES ($1, $2, $3, 'ceo', $4, false)",
        [reviewId, comment.rows[0].id, value, NOW],
      );
      await expect(decision("pending")).rejects.toMatchObject({ code: "23514" });
      await decision("accept");
      await expect(decision("decline")).rejects.toMatchObject({ code: "23505" });
      const read = () => db.query("INSERT INTO mission_card_reads (card_id, person_id, last_read_seq, updated_at) VALUES ($1, 'owner', $2, $3)", [cardId, comment.rows[0].seq, NOW]);
      await read();
      await expect(read()).rejects.toMatchObject({ code: "23505" });
    });
  });
});
