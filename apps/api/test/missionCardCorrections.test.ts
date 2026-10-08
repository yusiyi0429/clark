import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { MissionCardCorrectionView, PersonalMissionCardPayload } from "@warmap/contracts";
import { migrate } from "../src/migrate.js";
import { listMissionRoundCards } from "../src/missionRounds.js";
import { createTestApp, createTestDb, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";

const OPENED = "2026-10-01T02:00:00.000Z";
const CLOSED = "2026-10-03T02:00:00.000Z";
const CONFIRMED = "2026-10-04T02:00:00.000Z";
const IN_MONTH = new Date("2026-10-10T02:00:00.000Z");
const LAST_SECOND = new Date("2026-10-31T15:59:59.000Z");
const NEXT_MONTH = new Date("2026-10-31T16:00:00.000Z");
const FIELDS = ["title", "why", "outcome", "successEvidence", "boundaries", "keyPath", "timeBoundary", "tradeoffs", "milestones", "resources", "dependencies", "humanAgentSplit", "risk", "retrospect"];
const get = (t: TestApp, cookie: string, path: string) => t.app.inject({ method: "GET", url: path, headers: { cookie } });
const post = (t: TestApp, cookie: string, path: string, payload: unknown) => t.app.inject({ method: "POST", url: path, headers: { cookie, origin: t.publicOrigin }, payload });

/** Legacy formal rows are deliberately retained for constraints and read-only compatibility tests. */
async function seed(t: Pick<TestApp, "sql">, period = "2026-10") {
  const plan = randomUUID(), round = randomUUID(), mine = randomUUID(), other = randomUUID();
  await t.sql("UPDATE battlefield_config SET owner_id=$1,six_month_outcome='六个月目标' WHERE id='growth'", [TEST_CEO.personId]);
  await t.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
    VALUES ($1,1,$2,'confirmed','公司目标','[{"battlefieldId":"growth","outcome":"本月目标"}]','[]',
    '{"edits":[],"checkedItemIds":[],"feedback":[],"note":""}',
    '{"status":"ready","pendingSince":null,"runId":null,"previousRunIds":[],"error":null,"generatedAt":null}',$3)`, [plan, period, OPENED]);
  await t.sql(`INSERT INTO mission_rounds (id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,window_seq,
      first_opened_at,opened_at,closes_at,confirmed_by,confirmed_at,created_at,updated_at)
    VALUES ($1,5,'growth',$2,$3,'confirmed','placeholder','{}',1,$4,$4,$5,$6,$7,$4,$7)`, [round, period, plan, OPENED, CLOSED, TEST_CEO.personId, CONFIRMED]);
  for (const [card, owner, mission, order] of [[mine, TEST_MEMBER.personId, "mission-mine", 0], [other, TEST_CEO.personId, "mission-other", 1]] as const) {
    await t.sql("INSERT INTO personal_mission_cards (id,round_id,owner_id,sort_order,member_ids,created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6)",
      [card, round, owner, order, JSON.stringify([owner, TEST_CEO.personId]), OPENED]);
    await t.sql(`INSERT INTO missions (id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,why,success_evidence,milestones,
        source_ref,source_document_id,source_revision,source_title,placeholder,personal_mission_card_id,created_at,updated_at)
      VALUES ($1,1,$1,$2,'个人任务',$3,'method','["growth"]','原始结果','保留背景','["证据一","证据二"]','["第一周"]',
        'https://example.test/source','fixture',9,'隔离测试',true,$4,$5,$6)`, [mission, period, owner, card, OPENED, CONFIRMED]);
  }
  return { round, mine, other };
}
async function setup(period = "2026-10", at = IN_MONTH, legacy = false) {
  let now = new Date(CONFIRMED);
  const t = await createTestApp({}, undefined, { monthlyNow: () => now, missionCardReviewAgent: { async generate() { return { candidate: { summary: "根据本人确认的任务、备注与目标完成核对", findings: [] } }; } } });
  const ids = await seed(t, period), ceo = await t.loginCookie(), member = await t.memberCookie();
  if (!legacy) {
    await t.sql("UPDATE mission_rounds SET status='draft',version=1,window_seq=0,confirmed_by=NULL,confirmed_at=NULL,first_opened_at=NULL,opened_at=NULL,closes_at=NULL WHERE id=$1", [ids.round]);
    const round = (await get(t, ceo, `/api/mission-rounds/${ids.round}`)).json().cards[0];
    const open = round.actions.find((action: any) => action.actionType === "mission-round.open");
    const started = await post(t, ceo, "/api/mission-rounds/actions/execute", { actionId: open.actionId });
    expect(started.statusCode, started.body).toBe(200);
    for (const [card, cookie] of [[ids.mine, member], [ids.other, ceo]]) {
      const page = (await get(t, cookie, `/api/mission-cards/${card}`)).json().cards[0].payload;
      const done = await post(t, cookie, `/api/mission-cards/${card}/owner-confirmation`, { confirmed: true, round: 1, missionVersions: Object.fromEntries(page.card.missions.map((mission: any) => [mission.missionId, mission.version])) });
      expect(done.statusCode, done.body).toBe(200);
    }
    await vi.waitFor(async () => expect((await get(t, ceo, `/api/mission-rounds/${ids.round}`)).json().cards[0].payload.coAgentReview.status).toBe("completed"));
    const reviewed = (await get(t, ceo, `/api/mission-rounds/${ids.round}`)).json().cards[0];
    const confirm = reviewed.actions.find((action: any) => action.actionType === "mission-round.confirm");
    const done = await post(t, ceo, "/api/mission-rounds/actions/execute", { actionId: confirm.actionId, input: { note: "本人与组合均已核对" } });
    expect(done.statusCode, done.body).toBe(200);
  }
  now = at;
  return { t, ...ids, ceo, member, setNow(value: Date) { now = value; } };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
const request = (missionId: string, extra: Record<string, unknown> = {}) => ({ clientId: randomUUID(), missionId, field: "outcome", proposed: "更正后的结果", reason: "客户改了交付日期", sourceVersion: 1, ...extra });
const correct = (f: Fixture, cookie: string, payload: unknown, card = f.mine) => post(f.t, cookie, `/api/mission-cards/${card}/corrections`, payload);
const decide = (f: Fixture, id: string, payload: unknown, cookie = f.ceo, card = f.mine) => post(f.t, cookie, `/api/mission-cards/${card}/corrections/${id}/decision`, payload);
const outcome = async (response: Promise<{ statusCode: number; json: () => any }>) => { const res = await response; return [res.statusCode, res.json().code]; };
async function created(response: Promise<{ statusCode: number; json: () => any }>) { const res = await response; expect(res.statusCode, res.json().message).toBe(200); return res.json().correction; }
async function page(f: Fixture, cookie: string, card = f.mine) {
  const res = await get(f.t, cookie, `/api/mission-cards/${card}`); expect(res.statusCode).toBe(200);
  const payload = res.json().cards[0].payload; expect(Value.Check(PersonalMissionCardPayload, payload), [...Value.Errors(PersonalMissionCardPayload, payload)]).toBe(true); return payload;
}
const notices = async (f: Fixture, cookie: string) => (await get(f.t, cookie, "/api/me/mission-cards")).json().rounds;
const summary = async (f: Fixture) => (await get(f.t, f.ceo, `/api/mission-rounds/${f.round}`)).json().cards[0];
const returnCards = (f: Fixture, version: number, cards: string[], reason = "请本人明确验收口径", cookie = f.ceo) => post(f.t, cookie, `/api/mission-rounds/${f.round}/return-cards`, { version, cardIds: cards, reason });

describe("Formal correction requests retain owner control and history", () => {
  it("constrains known fields, bounded content, matching decisions, uniqueness and foreign keys", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const ids = await seed({ sql: async (text, params) => (await db.query(text, params)).rows });
      const insert = (overrides: Record<string, unknown> = {}) => {
        const row = { id: randomUUID(), round_id: ids.round, card_id: ids.mine, mission_id: "mission-mine", field: "outcome", original: "原始结果",
          proposed: "更正后的结果", reason: "原因", author_id: "owner", client_id: randomUUID(), direct: false, status: "pending",
          decided_by: null, decided_at: null, note: null, applied_version: null, created_at: CONFIRMED, ...overrides };
        const keys = Object.keys(row);
        return db.query(`INSERT INTO mission_card_corrections (${keys.join(",")}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(",")})`, Object.values(row));
      };
      const decided = { decided_by: "ceo", decided_at: CONFIRMED }, clientId = randomUUID();
      await insert({ client_id: clientId }); await expect(insert({ client_id: clientId })).rejects.toMatchObject({ code: "23505" });
      await insert({ client_id: clientId, author_id: "ceo", direct: true, status: "applied", applied_version: 2, ...decided });
      await insert({ status: "rejected", note: "本月照旧", ...decided });
      for (const field of FIELDS) await insert({ field });
      for (const invalid of [{ field: "ownerId" }, { proposed: "" }, { proposed: "字".repeat(4001) }, { reason: "" }, { reason: "字".repeat(301) }, { status: "withdrawn" },
        { decided_at: CONFIRMED }, { applied_version: 2 }, { status: "applied", ...decided }, { status: "rejected", ...decided },
        { status: "rejected", note: "", ...decided }, { direct: true }, { direct: true, status: "rejected", note: "不采纳", ...decided }]) await expect(insert(invalid)).rejects.toMatchObject({ code: "23514" });
      for (const invalid of [{ mission_id: "missing" }, { card_id: randomUUID() }, { round_id: randomUUID() }]) await expect(insert(invalid)).rejects.toMatchObject({ code: "23503" });
    });
  });

  it("keeps concurrent owner requests pending without writing any field; the DRI cannot correct another owner's body", async () => {
    const f = await setup(); const { t } = f;
    try {
      const before = (await t.sql("SELECT * FROM missions WHERE id='mission-mine'"))[0], roundBefore = (await summary(f)).version;
      const input = request("mission-mine", { proposed: "  新的预期结果  ", reason: " 客户改了交付日期 " });
      const [asked, replay] = await Promise.all([created(correct(f, f.member, input)), created(correct(f, f.member, input))]);
      expect(replay).toEqual(asked); expect(Value.Check(MissionCardCorrectionView, asked)).toBe(true);
      expect(asked).toMatchObject({ original: "原始结果", proposed: "新的预期结果", reason: "客户改了交付日期", authorId: TEST_MEMBER.personId,
        direct: false, status: "pending", decidedBy: null, decidedAt: null, appliedVersion: null, createdAt: IN_MONTH.toISOString() });
      const list = await created(correct(f, f.member, request("mission-mine", { field: "successEvidence", proposed: " 证据甲\n\n 证据乙 ", reason: "验收口径调整" })));
      expect(list).toMatchObject({ original: "证据一\n证据二", proposed: "证据甲\n证据乙", status: "pending", direct: false });
      expect(await outcome(correct(f, f.ceo, request("mission-mine")))).toEqual([403, "OWNER_RECONFIRMATION_REQUIRED"]);
      expect((await t.sql("SELECT * FROM missions WHERE id='mission-mine'"))[0]).toEqual(before);
      expect((await created(correct(f, f.member, input))).id).toBe(asked.id); expect((await summary(f)).version).toBe(roundBefore);
      expect(await t.sql("SELECT count(*)::int AS n FROM mission_card_corrections")).toEqual([{ n: 2 }]);
    } finally { await t.close(); }
  }, 20_000);

  it("enforces ownership, card/mission binding, source version, normalized changes, bounds and idempotency before writing", async () => {
    const f = await setup(); const { t } = f;
    try {
      expect(await outcome(correct(f, f.member, request("mission-other"), f.other))).toEqual([404, "PERSONAL_MISSION_CARD_NOT_FOUND"]);
      expect(await outcome(correct(f, f.member, request("mission-mine"), "not-a-card"))).toEqual([404, "PERSONAL_MISSION_CARD_NOT_FOUND"]);
      expect(await outcome(correct(f, f.member, request("mission-other")))).toEqual([404, "MISSION_NOT_FOUND"]);
      expect(await outcome(correct(f, f.member, request("mission-mine", { sourceVersion: 2 })))).toEqual([409, "SOURCE_VERSION_CONFLICT"]);
      for (const extra of [{ proposed: " 原始结果 " }, { field: "successEvidence", proposed: "证据一\n\n 证据二 " }])
        expect(await outcome(correct(f, f.member, request("mission-mine", extra)))).toEqual([400, "CORRECTION_UNCHANGED"]);
      for (const extra of [{ reason: "   " }, { proposed: "  " }, { field: "milestones", proposed: "\n" }, { field: "milestones", proposed: Array(31).fill("条").join("\n") }, { field: "milestones", proposed: "字".repeat(501) }, { field: "title", proposed: "字".repeat(201) }])
        expect(await outcome(correct(f, f.member, request("mission-mine", extra)))).toEqual([400, "INVALID_CORRECTION"]);
      expect(await outcome(correct(f, f.member, request("mission-mine", { field: "ownerId" })))).toEqual([400, "INVALID_INPUT"]);
      expect(await t.sql("SELECT id FROM mission_card_corrections")).toEqual([]);
      const first = request("mission-mine"), asked = await created(correct(f, f.member, first));
      expect(await outcome(correct(f, f.member, { ...first, reason: "换原因" }))).toEqual([409, "CLIENT_ID_CONFLICT"]);
      const ownSecond = randomUUID(), nextRound = randomUUID();
      await t.sql("INSERT INTO mission_rounds (id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,window_seq,opened_at,first_opened_at,closes_at,confirmed_at,confirmed_by,created_at,updated_at) SELECT $2,1,battlefield_id,'2026-11',monthly_plan_id,'confirmed','placeholder','{}',1,$3,$3,$3,$3,confirmed_by,$3,$3 FROM mission_rounds WHERE id=$1", [f.round, nextRound, CONFIRMED]);
      await t.sql("INSERT INTO personal_mission_cards (id,round_id,owner_id,sort_order,member_ids,created_at,owner_confirmed_at) VALUES ($1,$2,$3,2,$4::jsonb,$5,$5)", [ownSecond, nextRound, TEST_MEMBER.personId, JSON.stringify([TEST_MEMBER.personId, TEST_CEO.personId]), CONFIRMED]);
      await t.sql("INSERT INTO missions (id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,source_ref,source_document_id,source_revision,source_title,personal_mission_card_id) VALUES ('mission-second',1,'mission-second','2026-11','第二项',$1,'method','[\"growth\"]','原文','fixture://test','test',1,'隔离测试',$2)", [TEST_MEMBER.personId, ownSecond]);
      expect(await outcome(correct(f, f.member, { ...first, missionId: "mission-second" }, ownSecond))).toEqual([409, "CLIENT_ID_CONFLICT"]);
      for (const status of ["reviewing", "open"]) {
        await t.sql("UPDATE mission_rounds SET status=$2,confirmed_at=NULL,confirmed_by=NULL WHERE id=$1", [f.round, status]);
        expect(await outcome(correct(f, f.member, request("mission-mine", { field: "risk", proposed: "新风险" })))).toEqual([409, "CORRECTION_NOT_CONFIRMED"]);
        expect((await created(correct(f, f.member, first))).id).toBe(asked.id);
      }
      expect(await t.sql("SELECT count(*)::int AS n FROM mission_card_corrections")).toEqual([{ n: 1 }]);
    } finally { await t.close(); }
  }, 20_000);

  it("allows only the DRI to reject with a reason, serializes concurrent decisions and blocks applying a pending request", async () => {
    const f = await setup(); const { t } = f;
    try {
      const a = await created(correct(f, f.member, request("mission-mine")));
      expect(await outcome(decide(f, a.id, { decision: "reject", note: "不同意" }, f.member))).toEqual([403, "FORBIDDEN"]);
      expect(await outcome(decide(f, a.id, { decision: "reject", note: "不同意" }, f.member, f.other))).toEqual([404, "PERSONAL_MISSION_CARD_NOT_FOUND"]);
      for (const id of [randomUUID(), "not-a-uuid"]) expect(await outcome(decide(f, id, { decision: "reject", note: "理由" }))).toEqual([404, "CORRECTION_NOT_FOUND"]);
      expect(await outcome(decide(f, a.id, { decision: "reject", note: "理由" }, f.ceo, f.other))).toEqual([404, "CORRECTION_NOT_FOUND"]);
      expect(await outcome(decide(f, a.id, { decision: "apply" }))).toEqual([409, "OWNER_RECONFIRMATION_REQUIRED"]);
      for (const input of [{ decision: "reject" }, { decision: "reject", note: "   " }]) expect(await outcome(decide(f, a.id, input))).toEqual([400, "CORRECTION_NOTE_REQUIRED"]);
      const [rejected, again] = await Promise.all([created(decide(f, a.id, { decision: "reject", note: " 本月照旧 " })), created(decide(f, a.id, { decision: "reject", note: " 本月照旧 " }))]);
      expect(again).toEqual(rejected); expect(rejected).toMatchObject({ status: "rejected", note: "本月照旧", appliedVersion: null, decidedBy: TEST_CEO.personId, stale: false });
      expect(await created(decide(f, a.id, { decision: "reject", note: "另一个原因" }))).toEqual(rejected);
      expect(await outcome(decide(f, a.id, { decision: "apply" }))).toEqual([409, "CORRECTION_DECIDED"]);
      expect((await t.sql("SELECT outcome,version FROM missions WHERE id='mission-mine'"))[0]).toEqual({ outcome: "原始结果", version: 1 });
    } finally { await t.close(); }
  }, 20_000);

  it("projects stale requests against current text; stale never permits apply but can be rejected with history", async () => {
    const f = await setup(); const { t } = f;
    try {
      const input = request("mission-mine"), a = await created(correct(f, f.member, input));
      const b = await created(correct(f, f.member, request("mission-mine", { field: "why", proposed: "新的背景" })));
      // Simulates an imported historical correction; no current actor can bypass owner confirmation.
      await t.sql("UPDATE missions SET outcome='历史更正结果',version=2 WHERE id='mission-mine'");
      const data = await page(f, f.member);
      expect(data.corrections.find((item: any) => item.id === a.id).stale).toBe(true);
      expect(data.corrections.find((item: any) => item.id === b.id).stale).toBe(false);
      expect(await created(correct(f, f.member, input))).toMatchObject({ id: a.id, status: "pending", stale: true });
      expect(await outcome(decide(f, a.id, { decision: "apply" }))).toEqual([409, "OWNER_RECONFIRMATION_REQUIRED"]);
      expect(await created(decide(f, a.id, { decision: "reject", note: "历史原文已变化，请本人核对" }))).toMatchObject({ status: "rejected", stale: false });
      expect((await t.sql("SELECT outcome,version FROM missions WHERE id='mission-mine'"))[0]).toEqual({ outcome: "历史更正结果", version: 2 });
    } finally { await t.close(); }
  }, 20_000);

  it("honors the company month boundary and preserves pending history without continuing to notify", async () => {
    const f = await setup("2026-10", LAST_SECOND);
    try {
      const pending = await created(correct(f, f.member, request("mission-mine")));
      expect((await page(f, f.ceo)).correctionAccess).toEqual({ canRequest: false, canApply: false, canReject: true, closedReason: null });
      f.setNow(NEXT_MONTH);
      expect(await outcome(correct(f, f.member, request("mission-mine", { field: "why", proposed: "新的背景" })))).toEqual([409, "CORRECTION_PERIOD_CLOSED"]);
      for (const cookie of [f.member, f.ceo]) expect((await page(f, cookie)).correctionAccess).toEqual({ canRequest: false, canApply: false, canReject: false, closedReason: "月份已过，这张卡只读" });
      expect(await outcome(decide(f, pending.id, { decision: "reject", note: "本月照旧" }))).toEqual([409, "CORRECTION_PERIOD_CLOSED"]);
      const readonly = await page(f, f.ceo);
      expect(readonly.round).toMatchObject({ todo: null, counts: { corrections: 1 } }); expect(readonly.corrections).toMatchObject([{ id: pending.id, status: "pending" }]);
      expect(await notices(f, f.ceo)).toEqual([]);
    } finally { await f.t.close(); }
    const g = await setup("2026-11", LAST_SECOND);
    try {
      expect((await page(g, g.member)).correctionAccess).toEqual({ canRequest: true, canApply: false, canReject: false, closedReason: null });
      const asked = await created(correct(g, g.member, request("mission-mine"))); g.setNow(NEXT_MONTH);
      expect(await created(decide(g, asked.id, { decision: "reject", note: "仍需本人核对" }))).toMatchObject({ status: "rejected", appliedVersion: null });
    } finally { await g.t.close(); }
  }, 30_000);

  it("projects owner/DRI access, chronological requests, counts and notices using the actual battlefield owner", async () => {
    const f = await setup(); const { t } = f;
    try {
      const a = await created(correct(f, f.member, request("mission-mine")));
      f.setNow(new Date("2026-10-12T02:00:00Z"));
      const later = await created(correct(f, f.member, request("mission-mine", { field: "why", proposed: "新的背景" })));
      const mine = await page(f, f.member), dri = await page(f, f.ceo);
      expect(mine.corrections.map((item: any) => item.id)).toEqual([later.id, a.id]); expect(dri.corrections).toEqual(mine.corrections);
      expect(mine.correctionAccess).toEqual({ canRequest: true, canApply: false, canReject: false, closedReason: null });
      expect(dri.correctionAccess).toEqual({ canRequest: false, canApply: false, canReject: true, closedReason: null });
      expect(mine.round).toMatchObject({ approver: false, todo: null, counts: { corrections: 2 } });
      expect(dri.round).toMatchObject({ approver: true, todo: "2 条更正申请待你处理", counts: { corrections: 2 } });
      expect(dri.round.cards.find((row: any) => row.cardId === f.mine)).toMatchObject({ pendingCorrections: 2, firstPendingCorrectionId: a.id });
      expect(await notices(f, f.member)).toEqual([]); expect(await notices(f, f.ceo)).toMatchObject([{ roundId: f.round, counts: { corrections: 2 } }]);
      expect((await get(t, f.member, `/api/mission-cards/${f.other}`)).statusCode).toBe(404);
      await t.sql("UPDATE battlefield_config SET owner_id=$1 WHERE id='growth'", [TEST_MEMBER.personId]);
      const ownDri = await page(f, f.member);
      expect(ownDri.correctionAccess).toEqual({ canRequest: true, canApply: false, canReject: true, closedReason: null });
      expect(await outcome(decide(f, a.id, { decision: "reject", note: "CEO已不是DRI" }))).toEqual([403, "FORBIDDEN"]);
      expect((await notices(f, f.member))[0].todo).toBe("2 条更正申请待你处理");
      await t.sql("UPDATE battlefield_config SET owner_id=$1 WHERE id='growth'", [TEST_CEO.personId]);
      await created(decide(f, a.id, { decision: "reject", note: "本月照旧" })); await created(decide(f, later.id, { decision: "reject", note: "下月核对" }));
      expect((await page(f, f.ceo)).round).toMatchObject({ todo: null, counts: { corrections: 0 } }); expect(await notices(f, f.ceo)).toEqual([]);
      expect((await get(t, f.ceo, "/api/cards/home")).json().cards.filter((card: any) => card.kind === "mission-round")).toEqual([]);
    } finally { await t.close(); }
  }, 20_000);

  it("returns only selected formal cards with optimistic version, keeps unaffected confirmations and freezes old request decisions", async () => {
    const f = await setup(); const { t } = f;
    try {
      const a = await created(correct(f, f.member, request("mission-mine"))), before = await summary(f);
      expect(await outcome(returnCards(f, before.version, [f.mine], "理由", f.member))).toEqual([403, "ROUND_FORBIDDEN"]);
      expect(await outcome(returnCards(f, before.version - 1, [f.mine]))).toEqual([409, "VERSION_CONFLICT"]);
      expect(await outcome(returnCards(f, before.version, [randomUUID()]))).toEqual([400, "INVALID_RETURN_CARDS"]);
      expect(await outcome(returnCards(f, before.version, [f.mine], "   "))).toEqual([400, "INVALID_INPUT"]);
      const returned = await returnCards(f, before.version, [f.mine], " 请本人明确验收口径 ");
      expect(returned.statusCode, returned.body).toBe(200); expect(returned.json().cards[0].payload).toMatchObject({ phase: "open", round: 2, counts: { unreviewed: 1 } });
      const stamps = await t.sql("SELECT id,owner_confirmed_at,return_reason FROM personal_mission_cards WHERE round_id=$1", [f.round]);
      expect(stamps.find((row) => row.id === f.mine)).toMatchObject({ owner_confirmed_at: null, return_reason: "请本人明确验收口径" });
      expect(stamps.find((row) => row.id === f.other)!.owner_confirmed_at).not.toBeNull();
      expect((await get(t, f.ceo, `/api/mission-cards/${f.mine}`)).statusCode).toBe(404);
      expect((await page(f, f.member)).corrections).toMatchObject([{ id: a.id, status: "pending", reason: "客户改了交付日期" }]);
      expect(await outcome(decide(f, a.id, { decision: "reject", note: "继续处理" }))).toEqual([404, "PERSONAL_MISSION_CARD_NOT_FOUND"]);
      await t.sql("UPDATE battlefield_config SET owner_id=$1 WHERE id='growth'", [TEST_MEMBER.personId]);
      expect(await outcome(decide(f, a.id, { decision: "reject", note: "继续处理" }, f.member))).toEqual([409, "CORRECTION_NOT_CONFIRMED"]);
      expect(await outcome(returnCards(f, before.version, [f.mine], "请本人核对", f.member))).toEqual([409, "VERSION_CONFLICT"]);
    } finally { await t.close(); }
  }, 20_000);

  it("reads legacy confirmations and corrections without inventing owner stamps; such cards cannot be returned", async () => {
    const f = await setup("2026-10", IN_MONTH, true); const { t } = f;
    try {
      const asked = await created(correct(f, f.member, request("mission-mine")));
      const legacy = await page(f, f.ceo), before = await summary(f);
      expect(legacy.confirmation).toMatchObject({ by: TEST_CEO.personId, at: CONFIRMED }); expect(legacy.card.ownerConfirmedAt).toBeNull();
      expect(legacy.corrections).toMatchObject([{ id: asked.id, status: "pending" }]);
      expect(await outcome(returnCards(f, before.version, [f.mine]))).toEqual([409, "LEGACY_CONFIRMATION_REQUIRES_NEW_DRAFT"]);
      expect((await t.sql("SELECT owner_confirmed_at FROM personal_mission_cards")).every((row) => row.owner_confirmed_at === null)).toBe(true);
      expect((await summary(f)).payload.phase).toBe("confirmed");
    } finally { await t.close(); }
  }, 20_000);

  it("limits notices to the current requested company period without replacing historical pending counts", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db); const ids = await seed({ sql: async (text, params) => (await db.query(text, params)).rows });
      await db.query(`INSERT INTO mission_card_corrections (id,round_id,card_id,mission_id,field,original,proposed,reason,author_id,client_id,direct,status,created_at)
        VALUES ($1,$2,$3,'mission-mine','outcome','原始结果','更正后的结果','原因',$4,$5,false,'pending',$6)`, [randomUUID(), ids.round, ids.mine, TEST_MEMBER.personId, randomUUID(), IN_MONTH]);
      const q = db.query.bind(db), list = (personId: string, role: "ceo" | "member", period: string, at: Date) => listMissionRoundCards(q, [], "secret", { personId, role }, period, at);
      expect((await list(TEST_CEO.personId, "ceo", "2026-10", IN_MONTH)).map((card) => card.objectRef.id)).toEqual([ids.round]);
      expect(await list(TEST_MEMBER.personId, "member", "2026-10", IN_MONTH)).toEqual([]); expect(await list(TEST_CEO.personId, "ceo", "2026-11", IN_MONTH)).toEqual([]);
      expect(await list(TEST_CEO.personId, "ceo", "2026-10", NEXT_MONTH)).toEqual([]);
    });
  });
});
