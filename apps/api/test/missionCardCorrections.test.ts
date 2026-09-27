import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { MissionCardCorrectionView, PersonalMissionCardPayload } from "@warmap/contracts";
import { migrate } from "../src/migrate.js";
import { listMissionRoundCards } from "../src/missionRounds.js";
import { createTestApp, createTestDb, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";

const OPENED = "2026-10-01T02:00:00.000Z";
const CLOSED = "2026-10-03T02:00:00.000Z";
const CONFIRMED = "2026-10-04T02:00:00.000Z"; // 公司时区 10/4 10:00
const IN_MONTH = new Date("2026-10-10T02:00:00.000Z");
const LAST_SECOND = new Date("2026-10-31T15:59:59.000Z"); // 公司时区 10/31 23:59:59
const NEXT_MONTH = new Date("2026-10-31T16:00:00.000Z"); // 公司时区 11/1 00:00
const FIELDS = ["title", "why", "outcome", "successEvidence", "boundaries", "keyPath", "milestones", "resources", "dependencies", "humanAgentSplit", "risk", "retrospect"];

/** 已确定的一轮：测试乙一张卡、另一位 Owner 一张卡；测试甲是 CEO，也是本战场 DRI。 */
async function seed(t: Pick<TestApp, "sql">, period = "2026-10") {
  const plan = randomUUID(), round = randomUUID(), mine = randomUUID(), other = randomUUID();
  await t.sql("UPDATE battlefield_config SET owner_id=$1,six_month_outcome='六个月目标' WHERE id='growth'", [TEST_CEO.personId]);
  // 完整的 negotiation／generation：CEO 首页的月度通知会投影它们。
  await t.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
    VALUES ($1,1,$2,'confirmed','公司目标','[{"battlefieldId":"growth","outcome":"本月目标"}]','[]',
    '{"edits":[],"checkedItemIds":[],"feedback":[],"note":""}',
    '{"status":"ready","pendingSince":null,"runId":null,"previousRunIds":[],"error":null,"generatedAt":null}',$3)`, [plan, period, OPENED]);
  await t.sql(`INSERT INTO mission_rounds (id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,window_seq,
      first_opened_at,opened_at,closes_at,confirmed_by,confirmed_at,created_at,updated_at)
    VALUES ($1,5,'growth',$2,$3,'confirmed','placeholder','{}',1,$4,$4,$5,$6,$7,$4,$7)`, [round, period, plan, OPENED, CLOSED, TEST_CEO.personId, CONFIRMED]);
  for (const [card, owner, mission, order] of [[mine, TEST_MEMBER.personId, "mission-mine", 0], [other, "another-owner", "mission-other", 1]] as const) {
    await t.sql("INSERT INTO personal_mission_cards (id,round_id,owner_id,sort_order,member_ids,created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6)",
      [card, round, owner, order, JSON.stringify([owner, TEST_CEO.personId]), OPENED]);
    await t.sql(`INSERT INTO missions (id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,why,success_evidence,milestones,
        source_ref,source_document_id,source_revision,source_title,placeholder,personal_mission_card_id,created_at,updated_at)
      VALUES ($1,1,$1,$2,'个人任务',$3,'method','["growth"]','原始结果','保留背景','["证据一","证据二"]','["第一周"]',
        'https://example.test/source','fixture',9,'占位',true,$4,$5,$6)`, [mission, period, owner, card, OPENED, CONFIRMED]);
  }
  return { round, mine, other };
}

async function setup(period = "2026-10", at = IN_MONTH) {
  let now = at;
  const t = await createTestApp({}, undefined, { monthlyNow: () => now });
  const ids = await seed(t, period);
  return { t, ...ids, ceo: await t.loginCookie(), member: await t.memberCookie(), setNow: (value: Date) => { now = value; } };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
const get = (t: TestApp, cookie: string, path: string) => t.app.inject({ method: "GET", url: path, headers: { cookie } });
const post = (t: TestApp, cookie: string, path: string, payload: unknown) => t.app.inject({ method: "POST", url: path, headers: { cookie, origin: t.publicOrigin }, payload });
const request = (missionId: string, extra: Record<string, unknown> = {}) => ({
  clientId: randomUUID(), missionId, field: "outcome", proposed: "更正后的结果", reason: "客户改了交付日期", sourceVersion: 1, ...extra,
});
const correct = (f: Fixture, cookie: string, payload: unknown, card = f.mine) => post(f.t, cookie, `/api/mission-cards/${card}/corrections`, payload);
const decide = (f: Fixture, id: string, payload: unknown, cookie = f.ceo, card = f.mine) => post(f.t, cookie, `/api/mission-cards/${card}/corrections/${id}/decision`, payload);
const outcome = async (response: Promise<{ statusCode: number; json: () => any }>) => { const res = await response; return [res.statusCode, res.json().code]; };
async function created(response: Promise<{ statusCode: number; json: () => any }>) {
  const res = await response; expect(res.statusCode).toBe(200); return res.json().correction;
}
async function page(f: Fixture, cookie: string, card = f.mine) {
  const res = await get(f.t, cookie, `/api/mission-cards/${card}`); expect(res.statusCode).toBe(200);
  const payload = res.json().cards[0].payload; expect(Value.Check(PersonalMissionCardPayload, payload)).toBe(true); return payload;
}
async function notices(f: Fixture, cookie: string) {
  const res = await get(f.t, cookie, "/api/me/mission-cards"); expect(res.statusCode).toBe(200); return res.json().rounds;
}

describe("Corrections to a confirmed personal Mission Card (GAP-04)", () => {
  it("constrains stored corrections: known field, bounded text, a decision matching the status, direct only when applied", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const ids = await seed({ sql: async (text, params) => (await db.query(text, params)).rows });
      const insert = (overrides: Record<string, unknown> = {}) => {
        const row = { id: randomUUID(), round_id: ids.round, card_id: ids.mine, mission_id: "mission-mine", field: "outcome", original: "原始结果",
          proposed: "更正后的结果", reason: "原因", author_id: "owner", client_id: randomUUID(), direct: false, status: "pending",
          decided_by: null, decided_at: null, note: null, applied_version: null, created_at: CONFIRMED, ...overrides };
        const keys = Object.keys(row);
        return db.query(`INSERT INTO mission_card_corrections (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(row));
      };
      const decided = { decided_by: "ceo", decided_at: CONFIRMED };
      const clientId = randomUUID();
      await insert({ client_id: clientId });
      await expect(insert({ client_id: clientId })).rejects.toMatchObject({ code: "23505" });
      await insert({ client_id: clientId, author_id: "ceo", direct: true, status: "applied", applied_version: 2, ...decided });
      await insert({ status: "rejected", note: "本月照旧", ...decided });
      for (const field of FIELDS) await insert({ field });
      for (const invalid of [
        { field: "ownerId" }, { proposed: "" }, { proposed: "字".repeat(4001) }, { reason: "" }, { reason: "字".repeat(301) }, { status: "withdrawn" },
        { decided_at: CONFIRMED }, { applied_version: 2 }, { status: "applied", ...decided }, { status: "rejected", ...decided },
        { status: "rejected", note: "", ...decided }, { direct: true }, { direct: true, status: "rejected", note: "不采纳", ...decided },
      ]) await expect(insert(invalid)).rejects.toMatchObject({ code: "23514" });
      for (const invalid of [{ mission_id: "missing" }, { card_id: randomUUID() }, { round_id: randomUUID() }]) await expect(insert(invalid)).rejects.toMatchObject({ code: "23503" });
    });
  });

  it("keeps the Owner's request pending on the current text and writes the approver's direct correction to one field, once", async () => {
    const f = await setup(); const { t } = f;
    try {
      const before = (await t.sql("SELECT * FROM missions WHERE id='mission-mine'"))[0];
      const asked = await created(correct(f, f.member, request("mission-mine", { proposed: "  新的预期结果  ", reason: " 客户改了交付日期 " })));
      expect(Value.Check(MissionCardCorrectionView, asked)).toBe(true);
      expect(asked).toMatchObject({ missionId: "mission-mine", field: "outcome", original: "原始结果", proposed: "新的预期结果", reason: "客户改了交付日期",
        authorId: TEST_MEMBER.personId, authorName: "测试乙", direct: false, status: "pending", decidedBy: null, decidedByName: null, decidedAt: null,
        note: null, appliedVersion: null, stale: false, createdAt: IN_MONTH.toISOString() });
      expect((await t.sql("SELECT * FROM missions WHERE id='mission-mine'"))[0]).toEqual(before);
      // 拍板人直接更正列表字段：按行拆分、只改这一个字段、版本只 +1；并发与事后重放都返回同一条。
      const input = request("mission-mine", { field: "successEvidence", proposed: " 证据甲\n\n 证据乙 ", reason: "验收口径改了" });
      const [direct, again] = await Promise.all([created(correct(f, f.ceo, input)), created(correct(f, f.ceo, input))]);
      expect(again.id).toBe(direct.id);
      expect(direct).toMatchObject({ field: "successEvidence", original: "证据一\n证据二", proposed: "证据甲\n证据乙", authorId: TEST_CEO.personId,
        direct: true, status: "applied", decidedBy: TEST_CEO.personId, decidedByName: "测试甲", decidedAt: IN_MONTH.toISOString(), appliedVersion: 2, stale: false });
      expect((await t.sql("SELECT * FROM missions WHERE id='mission-mine'"))[0]).toEqual({ ...before, version: 2, success_evidence: ["证据甲", "证据乙"], updated_at: IN_MONTH });
      expect((await created(correct(f, f.ceo, input))).id).toBe(direct.id);
      expect((await t.sql("SELECT version FROM missions ORDER BY id")).map((row) => row.version)).toEqual([2, 1]);
      expect(await t.sql("SELECT count(*)::int AS n FROM mission_card_corrections")).toEqual([{ n: 2 }]);
      expect((await t.sql("SELECT version FROM mission_rounds WHERE id=$1", [f.round]))[0].version).toBe(5);
    } finally { await t.close(); }
  });

  it("refuses corrections in the documented order with their codes and writes nothing for them", async () => {
    const f = await setup(); const { t } = f;
    try {
      expect(await outcome(correct(f, f.member, request("mission-other"), f.other))).toEqual([404, "PERSONAL_MISSION_CARD_NOT_FOUND"]);
      expect(await outcome(correct(f, f.member, request("mission-mine"), "not-a-card"))).toEqual([404, "PERSONAL_MISSION_CARD_NOT_FOUND"]);
      expect(await outcome(correct(f, f.member, request("mission-other")))).toEqual([404, "MISSION_NOT_FOUND"]);
      expect(await outcome(correct(f, f.member, request("mission-mine", { sourceVersion: 2 })))).toEqual([409, "SOURCE_VERSION_CONFLICT"]);
      for (const extra of [{ proposed: " 原始结果 " }, { field: "successEvidence", proposed: "证据一\n\n 证据二 " }]) {
        expect(await outcome(correct(f, f.member, request("mission-mine", extra)))).toEqual([400, "CORRECTION_UNCHANGED"]);
      }
      for (const extra of [{ reason: "   " }, { proposed: "  " }, { field: "milestones", proposed: " \n \n" }, { field: "milestones", proposed: Array(31).fill("条").join("\n") },
        { field: "milestones", proposed: "字".repeat(501) }, { field: "title", proposed: "字".repeat(201) }]) {
        expect(await outcome(correct(f, f.member, request("mission-mine", extra)))).toEqual([400, "INVALID_CORRECTION"]);
      }
      expect(await outcome(correct(f, f.member, request("mission-mine", { field: "ownerId" })))).toEqual([400, "INVALID_INPUT"]);
      expect(await t.sql("SELECT id FROM mission_card_corrections")).toEqual([]);
      // 幂等键：同一 clientId 换内容或换卡都冲突。
      const first = request("mission-mine");
      const asked = await created(correct(f, f.member, first));
      expect(await outcome(correct(f, f.member, { ...first, reason: "换了原因" }))).toEqual([409, "CLIENT_ID_CONFLICT"]);
      const mineByCeo = request("mission-mine", { field: "why", proposed: "新的背景" });
      await created(correct(f, f.ceo, mineByCeo));
      expect(await outcome(correct(f, f.ceo, { ...mineByCeo, missionId: "mission-other" }, f.other))).toEqual([409, "CLIENT_ID_CONFLICT"]);
      // 还没确定：讨论中、截止后都不走更正；重放在状态判断之前。
      for (const status of ["reviewing", "open"]) {
        await t.sql("UPDATE mission_rounds SET status=$2,confirmed_at=NULL,confirmed_by=NULL WHERE id=$1", [f.round, status]);
        expect(await outcome(correct(f, f.member, request("mission-mine", { field: "risk", proposed: "新风险" })))).toEqual([409, "CORRECTION_NOT_CONFIRMED"]);
        expect((await created(correct(f, f.member, first))).id).toBe(asked.id);
      }
      expect(await t.sql("SELECT field,status FROM mission_card_corrections ORDER BY field")).toEqual([{ field: "outcome", status: "pending" }, { field: "why", status: "applied" }]);
    } finally { await t.close(); }
  });

  it("lets only the approver decide: apply writes back once, reject needs a reason, repeats return the result and opposite repeats are refused", async () => {
    const f = await setup(); const { t } = f;
    try {
      const a = await created(correct(f, f.member, request("mission-mine")));
      const b = await created(correct(f, f.member, request("mission-mine", { field: "milestones", proposed: " 第一周\n\n第二周 ", reason: "拆成两周" })));
      expect(await outcome(decide(f, a.id, { decision: "apply" }, f.member, f.other))).toEqual([404, "PERSONAL_MISSION_CARD_NOT_FOUND"]);
      expect(await outcome(decide(f, a.id, { decision: "apply" }, f.member))).toEqual([403, "FORBIDDEN"]);
      for (const id of [randomUUID(), "not-a-uuid"]) expect(await outcome(decide(f, id, { decision: "apply" }))).toEqual([404, "CORRECTION_NOT_FOUND"]);
      expect(await outcome(decide(f, a.id, { decision: "apply" }, f.ceo, f.other))).toEqual([404, "CORRECTION_NOT_FOUND"]);
      const [applied, again] = await Promise.all([created(decide(f, a.id, { decision: "apply" })), created(decide(f, a.id, { decision: "apply" }))]);
      expect(again).toEqual(applied);
      expect(applied).toMatchObject({ id: a.id, status: "applied", direct: false, decidedBy: TEST_CEO.personId, decidedByName: "测试甲",
        decidedAt: IN_MONTH.toISOString(), note: null, appliedVersion: 2, stale: false });
      expect((await t.sql("SELECT outcome,version FROM missions WHERE id='mission-mine'"))[0]).toEqual({ outcome: "更正后的结果", version: 2 });
      expect(await outcome(decide(f, a.id, { decision: "reject", note: "改主意了" }))).toEqual([409, "CORRECTION_DECIDED"]);
      for (const payload of [{ decision: "reject" }, { decision: "reject", note: "   " }]) expect(await outcome(decide(f, b.id, payload))).toEqual([400, "CORRECTION_NOTE_REQUIRED"]);
      const rejected = await created(decide(f, b.id, { decision: "reject", note: " 本月照旧 " }));
      expect(rejected).toMatchObject({ status: "rejected", note: "本月照旧", appliedVersion: null, decidedBy: TEST_CEO.personId, stale: false });
      expect(await created(decide(f, b.id, { decision: "reject", note: "另一个原因" }))).toEqual(rejected);
      expect(await outcome(decide(f, b.id, { decision: "apply" }))).toEqual([409, "CORRECTION_DECIDED"]);
      expect((await t.sql("SELECT milestones,version FROM missions WHERE id='mission-mine'"))[0]).toEqual({ milestones: ["第一周"], version: 2 });
      // 采纳列表字段同样按行拆分；采纳时可以附一句说明。
      const c = await created(correct(f, f.member, request("mission-mine", { field: "milestones", proposed: "第一周\n 第二周", reason: "拆成两周", sourceVersion: 2 })));
      expect(await created(decide(f, c.id, { decision: "apply", note: " 同意 " }))).toMatchObject({ status: "applied", note: "同意", appliedVersion: 3 });
      expect((await t.sql("SELECT milestones,version FROM missions WHERE id='mission-mine'"))[0]).toEqual({ milestones: ["第一周", "第二周"], version: 3 });
      expect((await t.sql("SELECT version FROM mission_rounds WHERE id=$1", [f.round]))[0].version).toBe(5);
    } finally { await t.close(); }
  });

  it("marks a request stale once its field changes and refuses to apply it, while other fields' requests still apply", async () => {
    const f = await setup(); const { t } = f;
    try {
      const input = request("mission-mine");
      const a = await created(correct(f, f.member, input));
      const b = await created(correct(f, f.member, request("mission-mine", { field: "why", proposed: "新的背景" })));
      expect((await created(correct(f, f.ceo, request("mission-mine", { proposed: "拍板人的新结果", reason: "按最新情况" })))).appliedVersion).toBe(2);
      const card = await page(f, f.member);
      expect(card.corrections.find((item: any) => item.id === a.id).stale).toBe(true);
      expect(card.corrections.find((item: any) => item.id === b.id).stale).toBe(false);
      expect(await created(correct(f, f.member, input))).toMatchObject({ id: a.id, status: "pending", stale: true });
      expect(await outcome(decide(f, a.id, { decision: "apply" }))).toEqual([409, "CORRECTION_STALE"]);
      expect(await t.sql("SELECT status FROM mission_card_corrections WHERE id=$1", [a.id])).toEqual([{ status: "pending" }]);
      expect((await t.sql("SELECT outcome,version FROM missions WHERE id='mission-mine'"))[0]).toEqual({ outcome: "拍板人的新结果", version: 2 });
      expect(await created(decide(f, b.id, { decision: "apply" }))).toMatchObject({ status: "applied", appliedVersion: 3 });
      expect(await created(decide(f, a.id, { decision: "reject", note: "已按最新情况直接更正" }))).toMatchObject({ status: "rejected", stale: false });
    } finally { await t.close(); }
  });

  it("closes a card from the company month's first second after it, but keeps an early-confirmed next-month card correctable", async () => {
    const f = await setup("2026-10", LAST_SECOND);
    try {
      const pending = await created(correct(f, f.member, request("mission-mine")));
      expect((await page(f, f.ceo)).correctionAccess).toEqual({ canRequest: false, canApply: true, closedReason: null });
      f.setNow(NEXT_MONTH);
      for (const cookie of [f.member, f.ceo]) {
        expect(await outcome(correct(f, cookie, request("mission-mine", { field: "why", proposed: "新的背景" })))).toEqual([409, "CORRECTION_PERIOD_CLOSED"]);
        expect((await page(f, cookie)).correctionAccess).toEqual({ canRequest: false, canApply: false, closedReason: "月份已过，这张卡只读" });
      }
      expect(await outcome(decide(f, pending.id, { decision: "apply" }))).toEqual([409, "CORRECTION_PERIOD_CLOSED"]);
      const readonly = await page(f, f.ceo);
      expect(readonly.round).toMatchObject({ todo: null, counts: { corrections: 1 } });
      // 月份过了没法再处理：拍板人那一行回到「已确定」，待处理数照实保留。
      expect(readonly.round.cards.find((row: any) => row.cardId === f.mine)).toMatchObject({ line: "已确定", pendingCorrections: 1 });
      expect(readonly.corrections).toMatchObject([{ id: pending.id, status: "pending" }]);
      expect(await notices(f, f.ceo)).toEqual([]);
      expect((await f.t.sql("SELECT version FROM missions WHERE id='mission-mine'"))[0].version).toBe(1);
    } finally { await f.t.close(); }
    const g = await setup("2026-11", LAST_SECOND);
    try {
      expect((await page(g, g.member)).correctionAccess).toEqual({ canRequest: true, canApply: false, closedReason: null });
      const asked = await created(correct(g, g.member, request("mission-mine")));
      expect((await notices(g, g.ceo)).map((round: any) => [round.period, round.todo])).toEqual([["2026-11", "1 条更正申请待你处理"]]);
      g.setNow(NEXT_MONTH);
      expect(await created(decide(g, asked.id, { decision: "apply" }))).toMatchObject({ status: "applied", appliedVersion: 2 });
    } finally { await g.t.close(); }
  });

  it("projects history, access for the approver, the Owner and a DRI approver, the corrected status line, counts, todo and rows", async () => {
    const f = await setup(); const { t } = f;
    try {
      const a = await created(correct(f, f.member, request("mission-mine")));
      f.setNow(new Date("2026-10-11T02:00:00.000Z"));
      const direct = await created(correct(f, f.ceo, request("mission-mine", { field: "risk", proposed: "新增风险", reason: "发现新风险" })));
      f.setNow(new Date("2026-10-12T02:00:00.000Z"));
      const later = await created(correct(f, f.member, request("mission-mine", { field: "why", proposed: "新的背景", sourceVersion: 2 })));
      const mine = await page(f, f.member);
      expect(mine.corrections.map((item: any) => item.id)).toEqual([later.id, direct.id, a.id]);
      expect(mine.corrections[1]).toMatchObject({ direct: true, status: "applied", authorName: "测试甲", decidedByName: "测试甲", reason: "发现新风险" });
      expect(mine.correctionAccess).toEqual({ canRequest: true, canApply: false, closedReason: null });
      expect(mine.card.status).toBe("已确定 · 测试甲 10/4 10:00 · 更正 1 处");
      expect(mine.round).toMatchObject({ phase: "confirmed", approver: false, todo: null, counts: { corrections: 2 } });
      expect(mine.round.cards).toEqual([expect.objectContaining({ cardId: f.mine, line: "已确定", pendingCorrections: 2, firstPendingCorrectionId: a.id })]);
      const approver = await page(f, f.ceo);
      expect(approver.corrections).toEqual(mine.corrections);
      expect(approver.correctionAccess).toEqual({ canRequest: false, canApply: true, closedReason: null });
      expect(approver.card.status).toBe(mine.card.status);
      expect(approver.round).toMatchObject({ approver: true, todo: "2 条更正申请待你处理", counts: { corrections: 2 } });
      expect(approver.round.cards.map((row: any) => [row.cardId, row.line, row.pendingCorrections, row.firstPendingCorrectionId]))
        .toEqual([[f.mine, "2 条更正申请", 2, a.id], [f.other, "已确定", 0, null]]);
      expect((await get(t, f.member, `/api/mission-cards/${f.other}`)).statusCode).toBe(404);
      // 本战场 DRI 同样是拍板人。
      await t.sql("UPDATE battlefield_config SET owner_id=$1 WHERE id='growth'", [TEST_MEMBER.personId]);
      const dri = await page(f, f.member);
      expect(dri.correctionAccess).toEqual({ canRequest: false, canApply: true, closedReason: null });
      expect(dri.round.todo).toBe("2 条更正申请待你处理");
      await t.sql("UPDATE battlefield_config SET owner_id=$1 WHERE id='growth'", [TEST_CEO.personId]);
      await created(decide(f, a.id, { decision: "reject", note: "本月照旧" }));
      await created(decide(f, later.id, { decision: "apply" }));
      const done = await page(f, f.ceo);
      expect(done.card.status).toBe("已确定 · 测试甲 10/4 10:00 · 更正 2 处");
      expect(done.round).toMatchObject({ todo: null, counts: { corrections: 0 } });
      expect(done.round.cards[0]).toMatchObject({ line: "已确定", pendingCorrections: 0, firstPendingCorrectionId: null });
      // 还没确定的卡没有更正入口。
      await t.sql("UPDATE mission_rounds SET status='reviewing',confirmed_at=NULL,confirmed_by=NULL WHERE id=$1", [f.round]);
      const draft = await page(f, f.ceo, f.other);
      expect(draft.corrections).toEqual([]);
      expect(draft.correctionAccess).toEqual({ canRequest: false, canApply: false, closedReason: "还没确定：讨论中请用修改建议" });
    } finally { await t.close(); }
  });

  it("brings a confirmed round back to the approver's notices while requests wait, never to the Owner", async () => {
    const f = await setup(); const { t } = f;
    try {
      const rounds = async (cookie: string) => (await get(t, cookie, "/api/cards/home")).json().cards.filter((card: any) => card.kind === "mission-round");
      expect(await notices(f, f.ceo)).toEqual([]);
      const a = await created(correct(f, f.member, request("mission-mine")));
      expect(await notices(f, f.member)).toEqual([]);
      const approver = await notices(f, f.ceo);
      expect(approver).toMatchObject([{ roundId: f.round, phase: "confirmed", todo: "1 条更正申请待你处理", counts: { corrections: 1 } }]);
      expect(approver[0].cards.find((row: any) => row.cardId === f.mine)).toMatchObject({ line: "1 条更正申请", pendingCorrections: 1, firstPendingCorrectionId: a.id });
      expect((await rounds(f.ceo)).map((card: any) => card.payload)).toEqual(approver);
      await t.sql("UPDATE battlefield_config SET owner_id=$1 WHERE id='growth'", [TEST_MEMBER.personId]);
      expect((await notices(f, f.member)).map((round: any) => round.todo)).toEqual(["1 条更正申请待你处理"]);
      await t.sql("UPDATE battlefield_config SET owner_id=$1 WHERE id='growth'", [TEST_CEO.personId]);
      await created(decide(f, a.id, { decision: "reject", note: "本月照旧" }));
      expect(await notices(f, f.ceo)).toEqual([]);
      expect(await rounds(f.ceo)).toEqual([]);
    } finally { await t.close(); }
  });

  it("applies the same notice rule when the list is limited to one month", async () => {
    await createTestDb(async (t) => {
      await migrate(t.db);
      const ids = await seed({ sql: async (text, params) => (await t.db.query(text, params)).rows });
      await t.db.query(`INSERT INTO mission_card_corrections (id,round_id,card_id,mission_id,field,original,proposed,reason,author_id,client_id,direct,status,created_at)
        VALUES ($1,$2,$3,'mission-mine','outcome','原始结果','更正后的结果','原因',$4,$5,false,'pending',$6)`, [randomUUID(), ids.round, ids.mine, TEST_MEMBER.personId, randomUUID(), IN_MONTH]);
      const q = t.db.query.bind(t.db);
      const list = (personId: string, role: "ceo" | "member", period: string, at: Date) => listMissionRoundCards(q, [], "secret", { personId, role }, period, at);
      expect((await list(TEST_CEO.personId, "ceo", "2026-10", IN_MONTH)).map((card) => card.objectRef.id)).toEqual([ids.round]);
      expect(await list(TEST_MEMBER.personId, "member", "2026-10", IN_MONTH)).toEqual([]);
      expect(await list(TEST_CEO.personId, "ceo", "2026-11", IN_MONTH)).toEqual([]);
      expect(await list(TEST_CEO.personId, "ceo", "2026-10", NEXT_MONTH)).toEqual([]);
    });
  });
});
