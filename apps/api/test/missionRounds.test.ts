import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { MissionRoundSummary, type TCard, type TMissionRoundSummary } from "@warmap/contracts";
import { actionFingerprint, verifyActionId, type ActionScope } from "../src/actionToken.js";
import type { MemoryPerson } from "../src/companyMemory.js";
import { migrate } from "../src/migrate.js";
import {
  canApprove, missionCardMembers, getMissionRoundCard, listMissionRoundCards,
  executeOpenMissionRound, executeReopenMissionRound, closeDueRounds,
  importMissionCardDrafts, executeDraftMissionRound, listMissionRoundDraftCards,
} from "../src/missionRounds.js";
import { createTestDb, type TestDb } from "./helpers.js";

const SECRET = "mission-round-test-signing";
const START = new Date("2026-10-01T02:00:00.321Z");
const HOURS_48 = 48 * 60 * 60 * 1000;
const people: MemoryPerson[] = ["ceo", "dri", "owner", "owner-two", "outsider"].map((personId) => ({
  personId, displayName: `姓名-${personId}`, roles: [personId === "ceo" ? "ceo" : "dri"],
  sourceRef: "test-fixture", updatedAt: START.toISOString(),
}));
const ceo = { personId: "ceo", role: "ceo" as const };
const dri = { personId: "dri", role: "member" as const };
const owner = { personId: "owner", role: "member" as const };
const outsider = { personId: "outsider", role: "member" as const };
type Actor = typeof ceo | typeof owner;
type Fixture = { roundId: string; planId: string; cardIds: string[]; missionIds: string[]; battlefieldId: string };

async function seedDraft(t: TestDb, battlefieldId = "growth"): Promise<Fixture> {
  const planId = randomUUID();
  const roundId = randomUUID();
  await t.db.query(`INSERT INTO battlefield_config (id, version, code, name, owner_id, six_month_outcome)
    VALUES ($1, 7, $2, $3, 'dri', '冻结的六个月目标')
    ON CONFLICT (id) DO UPDATE SET version=7, code=EXCLUDED.code, owner_id='dri', six_month_outcome=EXCLUDED.six_month_outcome`,
  [battlefieldId, battlefieldId === "growth" ? "01" : "02", battlefieldId]);
  await t.db.query(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
    VALUES ($1,3,'2026-10','confirmed','公司结果',$2::jsonb,'[]','{}','{}',$3)
    ON CONFLICT (period) DO UPDATE SET battlefields=monthly_plans.battlefields || EXCLUDED.battlefields`,
  [planId, JSON.stringify([{ battlefieldId, outcome: `${battlefieldId}本月目标` }]), START]);
  const actualPlan = (await t.db.query("SELECT id FROM monthly_plans WHERE period='2026-10'")).rows[0].id as string;
  await t.db.query(`INSERT INTO mission_rounds (id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,created_at,updated_at)
    VALUES ($1,1,$2,'2026-10',$3,'draft','placeholder','{}',$4,$4)`, [roundId, battlefieldId, actualPlan, START]);
  const cardIds: string[] = []; const missionIds: string[] = [];
  for (const [sortOrder, ownerId] of ["owner", "owner-two"].entries()) {
    const cardId = randomUUID(); const missionId = `${battlefieldId}-${ownerId}`;
    cardIds.push(cardId); missionIds.push(missionId);
    await t.db.query(`INSERT INTO personal_mission_cards (id,round_id,owner_id,sort_order,role_label,member_ids,created_at)
      VALUES ($1,$2,$3,$4,'参与 DRI',$5::jsonb,$6)`,
    [cardId, roundId, ownerId, sortOrder, JSON.stringify([ownerId, "dri", "ceo"]), START]);
    await t.db.query(`INSERT INTO missions (id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,dependencies,
      source_ref,source_document_id,source_revision,source_title,placeholder,personal_mission_card_id)
      VALUES ($1,1,$1,'2026-10','草稿任务',$2,'cap-03',$3::jsonb,'待讨论结果','依赖甲\n依赖乙','feishu://fixture','fixture',9,'占位',true,$4)`,
    [missionId, ownerId, JSON.stringify([battlefieldId]), cardId]);
  }
  return { roundId, planId: actualPlan, cardIds, missionIds, battlefieldId };
}

async function card(t: TestDb, f: Fixture, person: Actor = ceo, at = START): Promise<TCard> {
  const result = await getMissionRoundCard(t.db.query.bind(t.db), people, SECRET, person, f.roundId, at);
  expect(result).not.toBeNull();
  expect(Value.Check(MissionRoundSummary, result!.payload)).toBe(true);
  return result!;
}
const summary = (value: TCard) => value.payload as TMissionRoundSummary;
function action(value: TCard, actionType: string): { scope: ActionScope; fingerprint: string } {
  const token = value.actions.find((item) => item.actionType === actionType)!.actionId;
  return { scope: verifyActionId(SECRET, token)!, fingerprint: actionFingerprint(SECRET, token, {}) };
}
async function open(t: TestDb, f: Fixture, person: Actor = ceo, at = START) {
  const request = action(await card(t, f, person, at), "mission-round.open");
  return executeOpenMissionRound(t.pool, people, SECRET, person, request.scope, request.fingerprint, () => at);
}
async function feedback(t: TestDb, f: Fixture, at: Date, late = false): Promise<string> {
  const id = randomUUID();
  await t.db.query(`INSERT INTO mission_card_feedback (id,round_id,card_id,kind,author_id,client_id,body,basis,window_seq,late,created_at)
    VALUES ($1,$2,$3,'comment','owner',$4,'需要核对依赖','draft',1,$5,$6)`,
  [id, f.roundId, f.cardIds[0], randomUUID(), late, at]);
  return id;
}
async function waitForRoundLock(t: TestDb): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const waiting = await t.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%mission_rounds%' LIMIT 1");
    if (waiting.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("轮次写入未等待预期行锁");
}

describe("Mission 轮次仓储与状态机", () => {
  it("derives current approvers and persists a deduplicated member set", () => {
    expect(canApprove(ceo, { battlefield_owner_id: "dri" })).toBe(true);
    expect(canApprove(dri, { battlefield_owner_id: "dri" })).toBe(true);
    expect(canApprove(owner, { battlefield_owner_id: "dri" })).toBe(false);
    expect(missionCardMembers("ceo", "ceo", people)).toEqual(["ceo"]);
    expect(missionCardMembers("owner", "dri", people)).toEqual(["owner", "dri", "ceo"]);
    expect(missionCardMembers("owner", "", people)).toEqual(["owner", "ceo"]);
  });

  it("projects only visible card rows and does not expose unavailable rounds", async () => {
    await createTestDb(async (t) => {
      await migrate(t.db); const f = await seedDraft(t);
      const own = await card(t, f, owner);
      expect(summary(own)).toMatchObject({ phase: "draft", round: 1, goals: null, approver: false, todo: null });
      expect(summary(own).cards.map((item) => item.ownerId)).toEqual(["owner"]);
      expect(own.actions).toEqual([]);
      expect(own.navigation?.[0].href).toBe(`/me/mission-cards/${f.cardIds[0]}`);
      expect(summary(await card(t, f, dri)).cards.map((item) => item.ownerId)).toEqual(["owner", "owner-two"]);
      expect(await getMissionRoundCard(t.db.query.bind(t.db), people, SECRET, outsider, f.roundId, START)).toBeNull();
      expect(await getMissionRoundCard(t.db.query.bind(t.db), people, SECRET, ceo, "bad-id", START)).toBeNull();
      expect(await listMissionRoundCards(t.db.query.bind(t.db), people, SECRET, outsider, "2026-10", START)).toEqual([]);
    });
  });

  it("opens exactly 48 hours, freezes versioned goals, and checks authorization before conflict/replay", async () => {
    await createTestDb(async (t) => {
      await migrate(t.db); const f = await seedDraft(t);
      const initial = await card(t, f); const request = action(initial, "mission-round.open");
      const call = (actor: Actor, scope = request.scope, fingerprint = request.fingerprint) =>
        executeOpenMissionRound(t.pool, people, SECRET, actor, scope, fingerprint, () => START);
      expect(await call(owner)).toMatchObject({ error: { status: 403, code: "ROUND_FORBIDDEN" } });
      expect(await call(outsider)).toMatchObject({ error: { status: 404 } });
      const opened = await call(dri);
      expect(opened).toHaveProperty("card");
      const row = (await t.db.query("SELECT * FROM mission_rounds WHERE id=$1", [f.roundId])).rows[0];
      expect(row).toMatchObject({ status: "open", version: 2, window_seq: 1 });
      expect(row.opened_at).toEqual(START);
      expect(row.first_opened_at).toEqual(START);
      expect(row.closes_at.getTime() - row.opened_at.getTime()).toBe(HOURS_48);
      expect(row.goal_snapshot).toMatchObject({ sixMonthOutcome: "冻结的六个月目标", monthOutcome: "growth本月目标", signedAt: START.toISOString(), battlefieldVersion: 7, monthlyPlanVersion: 3, monthlyPlanId: f.planId });
      expect(await call(ceo)).toMatchObject({ replayed: true, card: { version: 2 } });
      expect(await call(ceo, request.scope, "different-input")).toMatchObject({ conflict: true, latestCard: { version: 2 } });
      expect(await call(ceo, { ...request.scope, objectVersion: 2 }, "repeat-open")).toMatchObject({ error: { code: "ROUND_ALREADY_OPEN" } });
      expect(await call(outsider)).toMatchObject({ error: { status: 404 } });
      await t.db.query("UPDATE battlefield_config SET owner_id='outsider' WHERE id='growth'");
      expect(await call(dri)).toMatchObject({ error: { code: "ROUND_FORBIDDEN" } });
      expect((await t.db.query("SELECT version FROM missions")).rows.every((item) => item.version === 1)).toBe(true);
    });
  });

  it("refuses missing or unsigned targets and empty personal cards", async () => {
    await createTestDb(async (t) => {
      await migrate(t.db); const f = await seedDraft(t);
      await t.db.query("UPDATE monthly_plans SET status='draft'");
      expect(await open(t, f)).toMatchObject({ error: { code: "MONTHLY_PLAN_NOT_CONFIRMED" } });
      await t.db.query("UPDATE monthly_plans SET status='confirmed', battlefields='[]'");
      expect(await open(t, f)).toMatchObject({ error: { code: "ROUND_GOALS_MISSING" } });
      await t.db.query("UPDATE monthly_plans SET battlefields=$1", [JSON.stringify([{ battlefieldId: "growth", outcome: "本月目标" }])]);
      await t.db.query("UPDATE battlefield_config SET six_month_outcome='  ' WHERE id='growth'");
      expect(await open(t, f)).toMatchObject({ error: { code: "ROUND_GOALS_MISSING" } });
      await t.db.query("UPDATE battlefield_config SET six_month_outcome='六个月目标' WHERE id='growth'");
      await t.db.query("DELETE FROM missions WHERE id=$1", [f.missionIds[1]]);
      expect(await open(t, f)).toMatchObject({ error: { code: "ROUND_EMPTY_CARD" } });
      expect((await t.db.query("SELECT status,version FROM mission_rounds")).rows).toEqual([{ status: "draft", version: 1 }]);
    });
  });

  it("reads closed without writing and snapshots only pre-deadline feedback once under concurrent schedulers", async () => {
    await createTestDb(async (t) => {
      await migrate(t.db); const f = await seedDraft(t); await open(t, f);
      const closes = new Date(START.getTime() + HOURS_48);
      const included = await feedback(t, f, new Date(closes.getTime() - 1));
      await feedback(t, f, closes, true);
      await feedback(t, f, new Date(closes.getTime() + 1), true);
      expect(await closeDueRounds(t.pool, () => new Date(closes.getTime() - 1))).toBe(0);
      expect(summary(await card(t, f, ceo, closes)).phase).toBe("closed");
      expect((await t.db.query("SELECT * FROM mission_round_reviews")).rowCount).toBe(0);
      const results = await Promise.all([closeDueRounds(t.pool, () => closes), closeDueRounds(t.pool, () => closes)]);
      expect(results.reduce((sum, count) => sum + count, 0)).toBe(1);
      expect(await closeDueRounds(t.pool, closes)).toBe(0);
      const review = (await t.db.query("SELECT * FROM mission_round_reviews")).rows[0];
      expect(review.feedback_ids).toEqual([included]);
      expect(review.snapshot_at).toEqual(closes);
      expect(review.taken_at).toEqual(closes);
      expect(review.mission_versions).toEqual(Object.fromEntries(f.missionIds.map((id) => [id, 1])));
      expect(summary(await card(t, f, ceo, closes))).toMatchObject({ phase: "reviewing", version: 3, counts: { feedback: 1, pending: 1, late: 2, dependencies: 4 } });
    });
  });

  it("reopens without replacing goals or cards, then carries decisions and includes earlier late notes", async () => {
    await createTestDb(async (t) => {
      await migrate(t.db); const f = await seedDraft(t); await open(t, f);
      const closes = new Date(START.getTime() + HOURS_48);
      const request = { actionType: "mission-round.reopen", objectType: "mission-round", objectId: f.roundId, objectVersion: 2 };
      expect(await executeReopenMissionRound(t.pool, people, SECRET, ceo, request, "early", () => START)).toMatchObject({ error: { code: "ROUND_NOT_CLOSED" } });
      const first = await feedback(t, f, new Date(closes.getTime() - 1));
      await closeDueRounds(t.pool, closes);
      const previous = (await t.db.query("SELECT * FROM mission_round_reviews")).rows[0];
      await t.db.query("INSERT INTO mission_review_decisions (review_id,feedback_id,decision,decided_by,decided_at) VALUES ($1,$2,'accept','dri',$3)", [previous.id, first, closes]);
      await t.db.query("UPDATE mission_round_reviews SET note='旧核对结论' WHERE id=$1", [previous.id]);
      const late = await feedback(t, f, new Date(closes.getTime() + 1), true);
      await t.db.query("UPDATE battlefield_config SET six_month_outcome='新长期目标',version=8 WHERE id='growth'");
      await t.db.query("UPDATE monthly_plans SET battlefields='[]',version=4");
      const nextStart = new Date(closes.getTime() + 1000);
      const reopen = action(await card(t, f, ceo, nextStart), "mission-round.reopen");
      expect(await executeReopenMissionRound(t.pool, people, SECRET, owner, reopen.scope, reopen.fingerprint, () => nextStart)).toMatchObject({ error: { code: "ROUND_FORBIDDEN" } });
      const result = await executeReopenMissionRound(t.pool, people, SECRET, dri, reopen.scope, reopen.fingerprint, () => nextStart);
      expect(result).toHaveProperty("card");
      const row = (await t.db.query("SELECT * FROM mission_rounds")).rows[0];
      expect(row).toMatchObject({ version: 4, window_seq: 2, status: "open", reopens: [{ by: "dri", at: nextStart.toISOString(), closedAt: closes.toISOString() }] });
      expect(row.goal_snapshot.monthOutcome).toBe("growth本月目标");
      expect(row.first_opened_at).toEqual(START);
      expect((await t.db.query("SELECT superseded_at FROM mission_round_reviews")).rows[0].superseded_at).toEqual(nextStart);
      expect(await executeReopenMissionRound(t.pool, people, SECRET, dri, reopen.scope, reopen.fingerprint, () => nextStart)).toMatchObject({ replayed: true, card: { version: 4 } });
      const nextCloses = new Date(nextStart.getTime() + HOURS_48);
      await closeDueRounds(t.pool, nextCloses);
      const latest = (await t.db.query("SELECT * FROM mission_round_reviews ORDER BY window_seq DESC LIMIT 1")).rows[0];
      expect(latest.feedback_ids).toEqual([first, late]);
      expect(latest.note).toBeNull();
      expect((await t.db.query("SELECT feedback_id,decision,decided_by,decided_at,carried FROM mission_review_decisions WHERE review_id=$1", [latest.id])).rows).toEqual([{ feedback_id: first, decision: "accept", decided_by: "dri", decided_at: closes, carried: true }]);
      expect(summary(await card(t, f, ceo, nextCloses)).counts.pending).toBe(1);
      expect((await t.db.query("SELECT id FROM personal_mission_cards ORDER BY sort_order")).rows.map((item) => item.id)).toEqual(f.cardIds);
      await t.db.query("UPDATE mission_rounds SET status='confirmed',confirmed_at=$1,confirmed_by='ceo'", [nextCloses]);
      expect(await executeReopenMissionRound(t.pool, people, SECRET, ceo, { ...request, objectVersion: 5 }, "confirmed", () => nextCloses)).toMatchObject({ error: { code: "ROUND_CONFIRMED" } });
      expect(await listMissionRoundCards(t.db.query.bind(t.db), people, SECRET, ceo, "2026-10", nextCloses)).toEqual([]);
    });
  });

  it("keeps two battlefields independent and commits automatic closure when an action token becomes stale", async () => {
    await createTestDb(async (t) => {
      await migrate(t.db); const one = await seedDraft(t); const two = await seedDraft(t, "another");
      await open(t, one); await open(t, two, ceo, new Date(START.getTime() + 1000));
      const at = new Date(START.getTime() + HOURS_48);
      const stale = { actionType: "mission-round.reopen", objectType: "mission-round", objectId: one.roundId, objectVersion: 2 };
      const result = await executeReopenMissionRound(t.pool, people, SECRET, ceo, stale, "after-close", () => at);
      expect(result).toMatchObject({ conflict: true, latestCard: { version: 3, payload: { phase: "reviewing" } } });
      expect((await t.db.query("SELECT window_seq FROM mission_round_reviews WHERE round_id=$1", [one.roundId])).rowCount).toBe(1);
      expect(summary(await card(t, two, ceo, at))).toMatchObject({ phase: "open", version: 2 });
      expect(await closeDueRounds(t.pool, at)).toBe(0);
    });
  });

  it("takes action time after the row lock and replays simultaneous identical actions", async () => {
    await createTestDb(async (t) => {
      await migrate(t.db); const f = await seedDraft(t);
      const request = action(await card(t, f), "mission-round.open");
      await t.db.query("BEGIN"); await t.db.query("SELECT id FROM mission_rounds WHERE id=$1 FOR UPDATE", [f.roundId]);
      let clockRead = false; let at = START;
      const pending = executeOpenMissionRound(t.pool, people, SECRET, ceo, request.scope, request.fingerprint, () => { clockRead = true; return at; });
      try {
        await waitForRoundLock(t); expect(clockRead).toBe(false);
        at = new Date(START.getTime() + 10_000);
      } finally { await t.db.query("COMMIT"); }
      const [first, replay] = await Promise.all([pending, executeOpenMissionRound(t.pool, people, SECRET, ceo, request.scope, request.fingerprint, () => at)]);
      expect(first).toHaveProperty("card"); expect(replay).toMatchObject({ replayed: true });
      expect((await t.db.query("SELECT opened_at,version FROM mission_rounds")).rows).toEqual([{ opened_at: at, version: 2 }]);
    });
  });

  it("waits for an in-flight pre-deadline shared-lock contribution before snapshotting", async () => {
    await createTestDb(async (t) => {
      await migrate(t.db); const f = await seedDraft(t); await open(t, f);
      const closes = new Date(START.getTime() + HOURS_48);
      await t.db.query("BEGIN"); await t.db.query("SELECT id FROM mission_rounds WHERE id=$1 FOR SHARE", [f.roundId]);
      const contributed = await feedback(t, f, new Date(closes.getTime() - 1));
      const closing = closeDueRounds(t.pool, () => closes);
      try { await waitForRoundLock(t); } finally { await t.db.query("COMMIT"); }
      expect(await closing).toBe(1);
      expect((await t.db.query("SELECT feedback_ids FROM mission_round_reviews")).rows[0].feedback_ids).toEqual([contributed]);
    });
  });

  it("rechecks battlefield authority after waiting for the round lock", async () => {
    await createTestDb(async (t) => {
      await migrate(t.db); const f = await seedDraft(t);
      const request = action(await card(t, f, dri), "mission-round.open");
      await t.db.query("BEGIN"); await t.db.query("SELECT id FROM mission_rounds WHERE id=$1 FOR UPDATE", [f.roundId]);
      const pending = executeOpenMissionRound(t.pool, people, SECRET, dri, request.scope, request.fingerprint, () => START);
      try {
        await waitForRoundLock(t);
        await t.db.query("UPDATE battlefield_config SET owner_id='outsider' WHERE id='growth'");
      } finally { await t.db.query("COMMIT"); }
      expect(await pending).toMatchObject({ error: { status: 403, code: "ROUND_FORBIDDEN" } });
      expect((await t.db.query("SELECT status,version FROM mission_rounds")).rows).toEqual([{ status: "draft", version: 1 }]);
    });
  });
});

const DRAFT_SOURCE = fileURLToPath(new URL("../../../seed/placeholders/2026-10-mission-cards.battlefield-01.json", import.meta.url));
const draftPeople: MemoryPerson[] = ["ceo", "bai-tiantian", "liu-renhao", "sun-mingze", "chen-xinan", "yu-siyi"].map((personId) => ({
  personId, displayName: personId, roles: [personId === "ceo" ? "ceo" : "dri"], sourceRef: "test-fixture", updatedAt: START.toISOString(),
}));
async function importRelations(t: TestDb) {
  await migrate(t.db);
  await t.db.query("UPDATE battlefield_config SET code='01',owner_id='ceo' WHERE id='growth'");
  for (const code of ["03", "04", "05"]) await t.db.query(`INSERT INTO capability_config (id,version,code,name,six_month_outcome)
    VALUES ($1,1,$2,$1,'六个月目标')`, [`cap-${code}`, code]);
  await t.db.query(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
    VALUES ($1,1,'2026-10','confirmed','公司结果','[{"battlefieldId":"growth","outcome":"本月目标"}]','[]','{}','{}',$2)`, [randomUUID(), START]);
}
async function withDraftFile(run: (file: string, directory: string, value: any) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "warmap-mission-drafts-"));
  const file = join(directory, "2026-10-mission-cards.battlefield-01.json");
  const value = JSON.parse(await readFile(DRAFT_SOURCE, "utf8"));
  try { await writeFile(file, JSON.stringify(value)); await run(file, directory, value); }
  finally { await unlink(file); await rmdir(directory); }
}

describe("讨论候选导入", () => {
  it("imports the readonly five-card twelve-Mission source once with provenance and stable relationships", async () => {
    await createTestDb(async (t) => {
      await importRelations(t);
      const first = await importMissionCardDrafts(t.pool, draftPeople, DRAFT_SOURCE, () => START);
      expect(first.imported).toBe(true);
      expect(first.cards.map((item) => item.missionCount)).toEqual([4, 3, 2, 2, 1]);
      expect((await t.db.query("SELECT count(*)::int AS count FROM mission_rounds")).rows).toEqual([{ count: 1 }]);
      const cards = (await t.db.query("SELECT owner_id,member_ids FROM personal_mission_cards ORDER BY sort_order")).rows;
      expect(cards).toHaveLength(5);
      expect(cards.every((item) => JSON.stringify(item.member_ids) === JSON.stringify([item.owner_id, "ceo"]))).toBe(true);
      const missions = (await t.db.query("SELECT * FROM missions ORDER BY code")).rows;
      expect(missions).toHaveLength(12);
      for (const mission of missions) {
        expect(mission.id).toBe(mission.code);
        expect(mission).toMatchObject({ version: 1, placeholder: true, battlefield_ids: ["growth"] });
        expect(mission.source_title).toContain("讨论候选（占位）");
        expect(mission.milestones.every((line: string) => line.startsWith("待定 · "))).toBe(true);
        expect(mission.key_path).toBeTruthy(); expect(mission.human_agent_split).toBeTruthy();
        expect(mission.resources).toBeTruthy(); expect(mission.retrospect).toBeTruthy();
      }
      const before = (await t.db.query("SELECT * FROM mission_rounds")).rows[0];
      expect(before.draft_source).toMatchObject({ schema: "mission-card-drafts.v1", importedAt: START.toISOString(), source: { period: "2026-09" } });
      const again = await importMissionCardDrafts(t.pool, draftPeople, DRAFT_SOURCE, new Date(START.getTime() + 1000));
      expect(again).toMatchObject({ roundId: first.roundId, imported: false });
      expect((await t.db.query("SELECT * FROM mission_rounds")).rows[0]).toEqual(before);
    });
  });

  it("validates the whole file and all references before any draft rows are written", async () => {
    await createTestDb(async (t) => {
      await importRelations(t);
      await withDraftFile(async (file, _directory, original) => {
        for (const [mutate, code, contains] of [
          [(value: any) => { value.schema = "wrong"; }, "INVALID_DRAFT_SCHEMA", "schema"],
          [(value: any) => { value.cards[0].ownerId = "unknown-person"; }, "INVALID_OWNER", "unknown-person"],
          [(value: any) => { value.cards[0].missions[0].capabilityCode = "99"; }, "INVALID_CAPABILITY", "bai-202610-1"],
          [(value: any) => { value.battlefieldCode = "99"; }, "INVALID_BATTLEFIELD", "99"],
          [(value: any) => { value.cards[0].missions[0].battlefieldIds = ["growth", "another"]; }, "INVALID_DRAFT_SCHEMA", "battlefieldIds"],
          [(value: any) => { value.cards[1].ownerId = value.cards[0].ownerId; }, "INVALID_DRAFT_SCHEMA", "Owner"],
        ] as const) {
          const value = structuredClone(original); mutate(value); await writeFile(file, JSON.stringify(value));
          await expect(importMissionCardDrafts(t.pool, draftPeople, file, START)).rejects.toMatchObject({ code, message: expect.stringContaining(contains) });
          expect((await t.db.query("SELECT count(*)::int AS count FROM mission_rounds")).rows[0].count).toBe(0);
        }
        await writeFile(file, JSON.stringify(original));
        await t.db.query("UPDATE monthly_plans SET status='draft'");
        await expect(importMissionCardDrafts(t.pool, draftPeople, file, START)).rejects.toMatchObject({ code: "MONTHLY_PLAN_NOT_CONFIRMED", message: expect.stringContaining("先签发再整理草稿") });
        await t.db.query("UPDATE monthly_plans SET status='confirmed',battlefields='[]'");
        await expect(importMissionCardDrafts(t.pool, draftPeople, file, START)).rejects.toMatchObject({ code: "ROUND_GOALS_MISSING" });
        expect((await t.db.query("SELECT count(*)::int AS count FROM personal_mission_cards")).rows[0].count).toBe(0);
      });
    });
  });

  it("serializes simultaneous imports and rejects changed bytes without overwriting human content", async () => {
    await createTestDb(async (t) => {
      await importRelations(t);
      await withDraftFile(async (file, _directory, value) => {
        const results = await Promise.all([importMissionCardDrafts(t.pool, draftPeople, file, START), importMissionCardDrafts(t.pool, draftPeople, file, START)]);
        expect(results.map((item) => item.imported).sort()).toEqual([false, true]);
        expect(new Set(results.map((item) => item.roundId)).size).toBe(1);
        await t.db.query("UPDATE missions SET title='人工内容' WHERE code='bai-202610-1'");
        await writeFile(file, `${JSON.stringify(value)}\n`);
        await expect(importMissionCardDrafts(t.pool, draftPeople, file, START)).rejects.toMatchObject({ code: "MISSION_DRAFT_SOURCE_CHANGED", status: 409 });
        expect((await t.db.query("SELECT title FROM missions WHERE code='bai-202610-1'")).rows[0].title).toBe("人工内容");
        expect((await t.db.query("SELECT count(*)::int AS count FROM missions")).rows[0].count).toBe(12);
      });
    });
  });

  it("offers slots only after plan sign-off and executes the signed slot with current authority", async () => {
    await createTestDb(async (t) => {
      await importRelations(t);
      await withDraftFile(async (_file, directory) => {
        const list = () => listMissionRoundDraftCards(t.db.query.bind(t.db), draftPeople, SECRET, ceo, "2026-10", START, directory);
        await t.db.query("UPDATE monthly_plans SET status='draft'"); expect(await list()).toEqual([]);
        await t.db.query("UPDATE monthly_plans SET status='confirmed'");
        const slots = await list(); expect(slots).toHaveLength(1);
        expect(slots[0].objectRef).toEqual({ type: "mission-round-slot", id: "growth:2026-10", version: 1 });
        const request = action(slots[0], "mission-round.draft");
        expect(await executeDraftMissionRound(t.pool, draftPeople, SECRET, outsider, request.scope, request.fingerprint, () => START, directory)).toMatchObject({ error: { status: 403 } });
        const first = await executeDraftMissionRound(t.pool, draftPeople, SECRET, ceo, request.scope, request.fingerprint, () => START, directory);
        expect(first).toMatchObject({ card: { kind: "mission-round", payload: { phase: "draft" } } });
        expect(await list()).toEqual([]);
        expect(await executeDraftMissionRound(t.pool, draftPeople, SECRET, ceo, request.scope, request.fingerprint, () => START, directory)).toMatchObject({ replayed: true });
        expect((await t.db.query("SELECT action_fingerprints FROM mission_rounds")).rows[0].action_fingerprints).toEqual([request.fingerprint]);
      });
    });
  });
});
