import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createAcceptanceApp, actors } from './fixture.mts';
import { deliverIntake } from '../../../apps/api/src/workIntake.js';

const f = await createAcceptanceApp();
const base = '/api/me/work-intake';
try {
  const [a, b, c] = [await f.login(0), await f.login(1), await f.login(2)];
  const owner = actors[0].personId;
  const deps = { app: f.app, pool: f.pool, env: f.env };
  const ok = (response: any, status = 200) => { assert.equal(response.statusCode, status, response.body); return response.json(); };
  const sleeping = async (scope: string, id: string) => await f.pool.query(`INSERT INTO work_intake(id,owner_id,scope,message,state,claim_id,lease_until)
    VALUES($1,$2,$3,'既有会话仍占用','sending',$4,now()+interval '2 minutes')`, [id, owner, scope, randomUUID()]);
  const state = async (id: string) => (await f.pool.query('SELECT state,last_error FROM work_intake WHERE id=$1', [id])).rows[0];
  const until = async (id: string, expected: string) => {
    const deadline = Date.now() + 16_000;
    let actual = await state(id);
    while (actual?.state !== expected && Date.now() < deadline) { await delay(50); actual = await state(id); }
    assert.equal(actual?.state, expected, JSON.stringify(actual));
    return actual;
  };

  const project = ok(await f.call(a, 'POST', '/api/me/projects', {name:'收件范围验证'}), 201);
  const scope = `project:${project.projectId}`;
  const pgate = randomUUID(); await sleeping(scope, pgate);
  const cancelled = randomUUID();
  const form = { id: cancelled, scope, message:'登记的追加要求', attachments: [] };
  assert.equal(ok(await f.call(a, 'POST', base, form)).state, 'queued');
  assert.equal(ok(await f.call(a, 'POST', base, form)).id, cancelled);
  ok(await f.call(a, 'POST', base, {...form, message:'不同内容'}), 409);
  const originals = ok(await f.call(a, 'GET', `${base}?scope=${encodeURIComponent(scope)}`)).items;
  assert.deepEqual(originals.map((row: any) => row.id), [pgate, cancelled]);
  for (const who of [b,c]) {
    ok(await f.call(who, 'GET', `${base}?scope=${encodeURIComponent(scope)}`), 404);
    ok(await f.call(who, 'PATCH', `${base}/${cancelled}`, {action:'cancel'}), 404);
  }
  assert.equal(ok(await f.call(a, 'PATCH', `${base}/${cancelled}`, {action:'first'})).priority, true);
  assert.equal(ok(await f.call(a, 'PATCH', `${base}/${cancelled}`, {action:'cancel'})).state, 'cancelled');
  assert.equal((await state(pgate)).state, 'sending');
  ok(await f.call(a, 'PATCH', `${base}/${cancelled}`, {action:'retry'}), 409);

  const retry = randomUUID();
  ok(await f.call(a, 'POST', base, {id: retry,scope, message:'独立重试',attachments:[]}));
  await f.pool.query("UPDATE work_intake SET state='delivered',lease_until=NULL,claim_id=NULL WHERE id=$1", [pgate]);
  await f.pool.query('UPDATE projects SET owner_id=$1 WHERE id=$2', [actors[1].personId,project.projectId]);
  await deliverIntake(deps,owner,scope);
  assert.ok((await until(retry,'failed')).last_error);
  ok(await f.call(a, 'GET', `${base}?scope=${encodeURIComponent(scope)}`), 404);
  await f.pool.query('UPDATE projects SET owner_id=$1 WHERE id=$2', [owner,project.projectId]);
  // Recover an input already accepted by the conversation before the queue worker crashed.
  await f.pool.query('INSERT INTO conversation_input_receipts(owner_id,scope,client_id,run_id) VALUES($1,$2,$3,$4)', [owner,scope,retry,randomUUID()]);
  assert.equal(ok(await f.call(a, 'PATCH', `${base}/${retry}`, {action:'retry'})).state, 'queued');
  await until(retry,'delivered');
  await deliverIntake(deps,owner,scope);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM conversation_input_receipts WHERE client_id=$1',[retry])).rows[0].n,1);
  console.log(JSON.stringify({ intakePassed:true, memberSessions:3, preexistingLiveLeasePreserved:true, ownScopeOnly:true,
    replaySameId:true, changedPayloadRejected:true, priorityAndCancel:true, revokedScopeFailed:true, retryExistingReceiptDeliveredOnce:true }));
} finally { await f.close(); }
