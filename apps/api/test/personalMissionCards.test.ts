import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestApp, createTestDb, type TestApp, type TestDb } from "./helpers.js";
import { migrate } from "../src/migrate.js";
import { createPersonalMissionCardFeedback } from "../src/personalMissionCards.js";

const START = "2026-10-01T02:00:00.000Z";
const CLOSE = "2026-10-03T02:00:00.000Z";
async function fixture(t: Pick<TestApp, "sql">) {
  const plan = randomUUID(), round = randomUUID(), card = randomUUID(), other = randomUUID();
  await t.sql("UPDATE battlefield_config SET owner_id='person-fixture-001',six_month_outcome='六个月目标' WHERE id='growth'");
  await t.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
    VALUES ($1,1,'2026-10','confirmed','公司目标','[{"battlefieldId":"growth","outcome":"本月目标"}]','[]','{}','{}',$2)`, [plan, START]);
  await t.sql(`INSERT INTO mission_rounds (id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,created_at,updated_at)
    VALUES ($1,1,'growth','2026-10',$2,'draft','placeholder','{}',$3,$3)`, [round, plan, START]);
  for (const [id, owner, members] of [[card, 'person-fixture-002', ['person-fixture-002', 'person-fixture-001']], [other, 'outsider', ['outsider', 'person-fixture-001']]] as const) {
    await t.sql(`INSERT INTO personal_mission_cards (id,round_id,owner_id,sort_order,member_ids,created_at) VALUES ($1,$2,$3,0,$4::jsonb,$5)`, [id, round, owner, JSON.stringify(members), START]);
    await t.sql(`INSERT INTO missions (id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,success_evidence,source_ref,source_document_id,source_revision,source_title,placeholder,personal_mission_card_id)
      VALUES ($1,1,$1,'2026-10','草稿任务',$2,'method','["growth"]','原始  结果','["证据一","证据二"]','https://example.test/source','fixture',9,'占位 · 沿用 9 月任务卡',true,$3)`, [id, owner, id]);
  }
  return { round, card, other };
}
const get = (t: TestApp, cookie: string, path: string) => t.app.inject({ method: "GET", url: path, headers: { cookie } });
const post = (t: TestApp, cookie: string, path: string, payload: Record<string, unknown>) => t.app.inject({ method: "POST", url: path, headers: { cookie, origin: t.publicOrigin }, payload });
const feedback = (card: string, kind: string, extra: Record<string, unknown> = {}) => ({ clientId: randomUUID(), kind, round: 1, body: "公开意见", ...(kind === "comment" ? {} : { missionId: card, field: "outcome", sourceVersion: 1, ...(kind === "quote" ? { quote: "原始 结果" } : { proposed: "候选结果" }) }), ...extra });
async function open(t: TestApp, cookie: string, card: string) {
  const page = (await get(t, cookie, `/api/mission-cards/${card}`)).json().cards[0];
  return post(t, cookie, '/api/mission-rounds/actions/execute', { actionId: page.actions[0].actionId, viewCardId: card });
}
async function close(t: TestApp, cookie: string, card: string) {
  const page = (await get(t, cookie, `/api/mission-cards/${card}`)).json().cards[0];
  const action = page.actions.find((entry: any) => entry.actionType === 'mission-round.close');
  expect((await post(t, cookie, '/api/mission-rounds/actions/execute', { actionId: action.actionId, viewCardId: card })).statusCode).toBe(200);
}

describe("Personal Mission Card discussion", () => {
  it("limits page/group/feedback/read/private scope to card members and current approvers", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: () => new Date(START) });
    try {
      const f = await fixture(t), ceo = await t.loginCookie(), member = await t.memberCookie();
      expect((await get(t, '', `/api/mission-cards/${f.card}`)).statusCode).toBe(401);
      const mine = await get(t, member, `/api/mission-cards/${f.card}`);
      expect(mine.statusCode).toBe(200);
      expect(mine.json().cards[0]).toMatchObject({ kind: 'personal-mission-card', actions: [], conversation: { scope: `mission-card:${f.card}` }, payload: { card: { ownerId: 'person-fixture-002', shown: 'draft', missions: [{ version: 1, placeholder: true, changedFields: [] }] } } });
      expect(mine.json().cards[0].payload.card.status).toBe('草稿');
      expect((await get(t, ceo, `/api/mission-cards/${f.card}`)).json().cards[0].payload.card.status).toBe(mine.json().cards[0].payload.card.status);
      for (const path of [`/api/mission-cards/${f.other}`, `/api/mission-cards/${f.other}/group`, `/api/conversations/mission-card:${f.other}/messages`]) expect((await get(t, member, path)).statusCode).toBe(404);
      expect((await post(t, member, `/api/mission-cards/${f.other}/feedback`, feedback(f.other, 'comment'))).statusCode).toBe(404);
      expect((await post(t, member, `/api/mission-cards/${f.other}/group/read`, { lastReadSeq: 0 })).statusCode).toBe(404);
      expect((await post(t, member, `/api/conversations/mission-card:${f.other}/messages`, { message: '不可见卡' })).statusCode).toBe(404);
      expect((await t.app.inject({ method: 'POST', url: `/api/mission-cards/${f.card}/feedback`, headers: { cookie: member, origin: 'https://elsewhere.invalid' }, payload: feedback(f.card, 'comment') })).statusCode).toBe(403);
      expect((await get(t, ceo, `/api/mission-cards/${f.other}`)).statusCode).toBe(200);
      await t.sql("UPDATE battlefield_config SET owner_id='person-fixture-002' WHERE id='growth'");
      expect((await get(t, member, `/api/mission-cards/${f.other}`)).json().cards[0].actions).toHaveLength(1);
      expect((await open(t, member, f.card)).json().cards[0]).toMatchObject({ kind: 'personal-mission-card', payload: { round: { phase: 'open' } } });
      await t.sql("UPDATE battlefield_config SET owner_id='person-fixture-001' WHERE id='growth'");
      for (const path of [`/api/mission-cards/${f.other}`, `/api/mission-cards/${f.other}/group`, `/api/conversations/mission-card:${f.other}/messages`]) expect((await get(t, member, path)).statusCode).toBe(404);
      expect((await post(t, member, `/api/mission-cards/${f.other}/group/read`, { lastReadSeq: 0 })).statusCode).toBe(404);
      expect((await post(t, member, `/api/conversations/mission-card:${f.other}/messages`, { message: '拍板权已撤销' })).statusCode).toBe(404);
    } finally { await t.close(); }
  });

  for (const phase of ['draft', 'open', 'closed', 'reviewing', 'confirmed']) {
    for (const kind of ['comment', 'quote', 'suggestion']) it(`${phase} × ${kind} enforces the writing table`, async () => {
      let clock = new Date(START);
      const t = await createTestApp({}, undefined, { monthlyNow: () => clock });
      try {
        const f = await fixture(t), ceo = await t.loginCookie(), member = await t.memberCookie();
        if (phase !== 'draft') await open(t, ceo, f.card);
        if (['closed','reviewing','confirmed'].includes(phase)) clock = new Date(CLOSE);
        // 保留已写截止时间、尚未落快照的边界态覆盖；新开放流程不自动写截止。
        if (phase === 'closed') await t.sql('UPDATE mission_rounds SET closes_at=$1 WHERE id=$2', [CLOSE, f.round]);
        if (['reviewing','confirmed'].includes(phase)) await close(t, ceo, f.card);
        if (['reviewing','confirmed'].includes(phase)) await post(t, member, `/api/mission-cards/${f.card}/feedback`, feedback(f.card, 'comment'));
        if (phase === 'confirmed') await t.sql("UPDATE mission_rounds SET status='confirmed',confirmed_at=$1,confirmed_by='person-fixture-001' WHERE id=$2", [CLOSE, f.round]);
        const res = await post(t, member, `/api/mission-cards/${f.card}/feedback`, feedback(f.card, kind));
        const accepted = phase === 'open' || (['closed','reviewing'].includes(phase) && kind !== 'suggestion');
        expect(res.statusCode).toBe(accepted ? 200 : 409);
        if (accepted) expect(res.json().feedback).toMatchObject({ kind, late: phase !== 'open', basis: phase === 'open' ? 'draft' : 'candidate', ...(kind === 'suggestion' ? { original: '原始  结果', sourceVersion: 1 } : {}) });
        else expect(res.json().code).toBe(phase === 'draft' ? 'ROUND_NOT_OPEN' : phase === 'confirmed' ? 'ROUND_CONFIRMED' : 'ROUND_CLOSED');
        if (phase === 'closed') expect(await t.sql('SELECT id FROM mission_round_reviews WHERE round_id=$1', [f.round])).toHaveLength(1);
      } finally { await t.close(); }
    });
  }

  it("validates anchors, versions, quote text, field types and normalized list proposals; retries are immutable", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: () => new Date(START) });
    try {
      const f = await fixture(t), ceo = await t.loginCookie(), member = await t.memberCookie(); await open(t, ceo, f.card);
      const send = (input: Record<string, unknown>) => post(t, member, `/api/mission-cards/${f.card}/feedback`, input);
      for (const [extra, status] of [[{ sourceVersion: 2 },409], [{ quote: '不存在' },409], [{ missionId: f.other },404], [{ field: 'ownerId' },400], [{ sourceVersion: undefined },400]] as const) expect((await send(feedback(f.card, 'quote', extra))).statusCode).toBe(status);
      for (const proposed of [' ', Array(31).fill('条').join('\n'), '字'.repeat(501)]) expect((await send(feedback(f.card, 'suggestion', { field: 'milestones', proposed }))).statusCode).toBe(400);
      expect((await send(feedback(f.card, 'suggestion', { field: 'title', proposed: '字'.repeat(201) }))).statusCode).toBe(400);
      expect((await send(feedback(f.card, 'comment', { quote: '原始结果' }))).statusCode).toBe(400);
      for (const anchor of [{ missionId: f.card }, { field: 'outcome' }]) expect((await send(feedback(f.card, 'comment', anchor))).statusCode).toBe(400);
      expect((await send(feedback(f.card, 'quote', { field: 'successEvidence', quote: '证据一 证据二' }))).statusCode).toBe(200);
      const input = feedback(f.card, 'suggestion', { field: 'milestones', proposed: ' 第一项\n\n第二项  ' });
      const [first, again] = await Promise.all([send(input), send(input)]);
      expect(first.statusCode).toBe(200); expect(again.json().feedback.id).toBe(first.json().feedback.id);
      expect(first.json().feedback.proposed).toBe('第一项\n第二项');
      expect((await send({ ...input, body: '改动正文' })).statusCode).toBe(409);
      expect((await t.sql('SELECT version FROM mission_rounds WHERE id=$1', [f.round]))[0].version).toBe(2);
      expect((await send(feedback(f.card, 'comment', { round: 2 }))).statusCode).toBe(409);
    } finally { await t.close(); }
  });

  it("quotes the candidate after cutoff while reopening quotes the draft; retains one opening and confirmation history", async () => {
    let clock = new Date(START);
    const t = await createTestApp({}, undefined, { monthlyNow: () => clock });
    try {
      const f = await fixture(t), ceo = await t.loginCookie(), member = await t.memberCookie();
      expect((await get(t, member, `/api/mission-cards/${f.card}/group`)).json().entries).toEqual([]);
      await open(t, ceo, f.card);
      const proposal = (await post(t, member, `/api/mission-cards/${f.card}/feedback`, feedback(f.card, 'suggestion'))).json().feedback;
      clock = new Date(CLOSE);
      await close(t, ceo, f.card);
      await post(t, member, `/api/mission-cards/${f.card}/feedback`, feedback(f.card, 'comment'));
      const review = (await t.sql('SELECT id FROM mission_round_reviews WHERE round_id=$1', [f.round]))[0];
      await t.sql("INSERT INTO mission_review_decisions (review_id,feedback_id,decision,decided_by,decided_at) VALUES ($1,$2,'accept','person-fixture-001',$3)", [review.id, proposal.id, CLOSE]);
      const page = (await get(t, member, `/api/mission-cards/${f.card}`)).json().cards[0];
      expect(page.payload.card.missions[0]).toMatchObject({ outcome: '候选结果', changedFields: ['outcome'], version: 1 });
      expect(page.payload.card.status).toContain('候选版本 · 相比草稿 1 处改动');
      expect((await post(t, member, `/api/mission-cards/${f.card}/feedback`, feedback(f.card, 'quote'))).statusCode).toBe(409);
      expect((await post(t, member, `/api/mission-cards/${f.card}/feedback`, feedback(f.card, 'quote', { quote: '候选结果' }))).statusCode).toBe(200);
      const before = (await get(t, ceo, `/api/mission-cards/${f.card}`)).json().cards[0];
      await post(t, ceo, '/api/mission-rounds/actions/execute', { actionId: before.actions[0].actionId, viewCardId: f.card });
      expect((await post(t, member, `/api/mission-cards/${f.card}/feedback`, feedback(f.card, 'quote', { round: 2 }))).statusCode).toBe(200);
      const group = (await get(t, member, `/api/mission-cards/${f.card}/group`)).json();
      expect(group.entries.filter((e: any) => e.type === 'opening')).toHaveLength(1);
      expect(group.entries[0].type).toBe('divider'); expect(group.entries[1].type).toBe('opening');
      expect(group.entries[1].text).toContain('占位');
      expect(group.entries.filter((e: any) => e.type === 'divider').map((e: any) => e.text).join('\n')).toContain('重新开放审核');
      await t.sql("UPDATE mission_rounds SET status='confirmed',confirmed_at=$1,confirmed_by='person-fixture-001' WHERE id=$2", [CLOSE, f.round]);
      expect((await get(t, member, `/api/mission-cards/${f.card}/group`)).json().entries.some((e: any) => e.type === 'divider' && e.text.includes('确认了本月 Mission Card'))).toBe(true);
    } finally { await t.close(); }
  });

  it("replays after closure without another write, rejects cross-card reuse, and rechecks visibility before replay", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: () => new Date(START) });
    try {
      const f = await fixture(t), ceo = await t.loginCookie(), member = await t.memberCookie(); await open(t, ceo, f.card);
      const input = feedback(f.card, 'comment');
      const first = (await post(t, member, `/api/mission-cards/${f.card}/feedback`, input)).json().feedback;
      await t.sql("UPDATE mission_rounds SET status='confirmed',confirmed_at=$1,confirmed_by='person-fixture-001' WHERE id=$2", [CLOSE, f.round]);
      expect((await post(t, member, `/api/mission-cards/${f.card}/feedback`, input)).json().feedback.id).toBe(first.id);
      await t.sql("UPDATE personal_mission_cards SET member_ids='[\"person-fixture-001\"]' WHERE id=$1", [f.card]);
      expect((await post(t, member, `/api/mission-cards/${f.card}/feedback`, input)).statusCode).toBe(404);
      const ceoInput = feedback(f.card, 'comment');
      await t.sql("UPDATE mission_rounds SET status='open',confirmed_at=NULL,confirmed_by=NULL WHERE id=$1", [f.round]);
      expect((await post(t, ceo, `/api/mission-cards/${f.card}/feedback`, ceoInput)).statusCode).toBe(200);
      expect((await post(t, ceo, `/api/mission-cards/${f.other}/feedback`, ceoInput)).statusCode).toBe(409);
      expect((await t.sql('SELECT count(*)::int AS n FROM mission_card_feedback'))[0].n).toBe(2);
    } finally { await t.close(); }
  });

  it("counts only others' feedback, clamps monotonic reads and keeps each person's Agent private and outside Review", async () => {
    let clock = new Date(START); let context: unknown;
    const t = await createTestApp({}, { async run(input) { context = input.currentObject; return { assistantMessage: '私下回复', runtimeEntries: [] }; } }, { monthlyNow: () => clock });
    try {
      const f = await fixture(t), ceo = await t.loginCookie(), member = await t.memberCookie(); await open(t, ceo, f.card);
      const mine = (await post(t, member, `/api/mission-cards/${f.card}/feedback`, feedback(f.card, 'comment'))).json().feedback;
      const theirs = (await post(t, ceo, `/api/mission-cards/${f.card}/feedback`, feedback(f.card, 'comment'))).json().feedback;
      expect((await get(t, member, `/api/mission-cards/${f.card}/group`)).json().unread).toBe(1);
      expect((await get(t, member, `/api/mission-cards/${f.card}/group?after=${mine.seq}`)).json().entries.filter((e: any) => e.type === 'message')).toHaveLength(1);
      expect((await post(t, member, `/api/mission-cards/${f.card}/group/read`, { lastReadSeq: 999999 })).json()).toEqual({ lastReadSeq: theirs.seq, unread: 0 });
      expect((await post(t, member, `/api/mission-cards/${f.card}/group/read`, { lastReadSeq: 0 })).json().lastReadSeq).toBe(theirs.seq);
      const scope = `/api/conversations/mission-card:${f.card}/messages`;
      expect((await post(t, member, scope, { message: '私下讨论承诺' })).statusCode).toBe(200);
      expect((await get(t, member, scope)).json().messages).toHaveLength(2);
      expect((await get(t, ceo, scope)).json().messages).toHaveLength(0);
      expect(JSON.stringify(context)).toContain('公开意见'); expect(JSON.stringify(context)).not.toContain('开放到');
      clock = new Date(CLOSE);
      await close(t, ceo, f.card);
      await post(t, member, `/api/mission-cards/${f.card}/feedback`, feedback(f.card, 'comment'));
      expect((await t.sql('SELECT feedback_ids FROM mission_round_reviews WHERE round_id=$1', [f.round]))[0].feedback_ids).toEqual([mine.id, theirs.id]);
    } finally { await t.close(); }
  });

  it("takes submission time after waiting for the round lock and snapshots exactly once for concurrent due writers", async () => {
    await createTestDb(async (t) => {
      await migrate(t.db);
      const f = await fixture({ sql: async (sql, params) => (await t.db.query(sql, params)).rows });
      await t.db.query("UPDATE mission_rounds SET status='open',window_seq=1,first_opened_at=$1,opened_at=$1,closes_at=$2 WHERE id=$3", [START, CLOSE, f.round]);
      let clockRead = false; let clock = new Date(new Date(CLOSE).getTime() - 1);
      await t.db.query('BEGIN'); await t.db.query('SELECT id FROM mission_rounds WHERE id=$1 FOR UPDATE', [f.round]);
      const submit = () => createPersonalMissionCardFeedback(t.pool, [], 'test', { personId: 'person-fixture-002', role: 'member' }, f.card, feedback(f.card, 'comment') as any, () => { clockRead = true; return clock; });
      const first = submit();
      try {
        await waitForLock(t); expect(clockRead).toBe(false); clock = new Date(CLOSE);
      } finally { await t.db.query('COMMIT'); }
      const results = await Promise.all([first, submit()]);
      for (const result of results) expect(result).toMatchObject({ feedback: { late: true, createdAt: CLOSE, basis: 'candidate' } });
      expect((await t.db.query('SELECT feedback_ids FROM mission_round_reviews WHERE round_id=$1', [f.round])).rows).toEqual([{ feedback_ids: [] }]);
    });
  });
});

async function waitForLock(t: TestDb) {
  for (let i = 0; i < 100; i++) {
    const waiting = await t.admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'", [t.database]);
    if (waiting.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Feedback did not wait on the held round lock');
}
