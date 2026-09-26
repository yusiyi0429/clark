// Real Web/API journey; only the disposable 04c fixture and synthetic accounts.
const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = 'http://localhost:3500';
const endpoint = process.argv[2];
const phase = process.argv[3] || 'setup';
const evidence = __dirname;
const save = (name, data) => fs.writeFileSync(path.join(evidence, name), JSON.stringify(data, null, 2));
const log = (name, facts = {}) => { const line = JSON.stringify({ name, ...facts }); fs.appendFileSync(path.join(evidence, 'browser-journey.log'), line + '\n'); console.log(line); };
const control = (command) => JSON.parse(execFileSync(process.execPath, [path.join(evidence, 'browser-control.cjs'), command], { encoding: 'utf8' }));
async function responseJson(response, status = 200) { assert.equal(response.status(), status); return response.json(); }
async function card(context, id) { return (await responseJson(await context.request.get(root + '/api/mission-cards/' + id))).cards[0]; }
async function action(context, token, viewCardId, input = {}) {
  return context.request.post(root + '/api/mission-rounds/actions/execute', { data: { actionId: token, viewCardId, input }, headers: { origin: root } });
}
async function capture(page, name) {
  await page.waitForTimeout(450);
  const metrics = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth, overlay: !!document.querySelector('[data-nextjs-dialog], .vite-error-overlay'), heading: document.querySelector('h1')?.textContent }));
  assert.equal(metrics.horizontalOverflow, false); assert.equal(metrics.overlay, false);
  await page.screenshot({ path: path.join(evidence, name + '.png') }); log(name, metrics);
}
async function sizes(page, name, target) {
  for (const [width, height] of [[1440, 900], [834, 1194], [390, 844]]) {
    await page.setViewportSize({ width, height });
    if (target) await target.scrollIntoViewIfNeeded();
    await capture(page, `${name}-${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
async function main() {
  const browser = await chromium.connectOverCDP(endpoint);
  let ceoContext, memberContext, ceo, member;
  const existing = browser.contexts().flatMap(context => context.pages().map(page => ({ context, page })));
  if (phase === 'setup') {
    const oldCeo = existing.find(item => item.page.url().includes('/mission-cards/') && !item.page.url().includes('/me/'));
    const oldMember = existing.find(item => item.page.url().includes('/me/mission-cards/'));
    ceoContext = oldCeo?.context ?? await browser.newContext({ viewport: { width: 1440, height: 900 } }); ceo = oldCeo?.page ?? await ceoContext.newPage();
    memberContext = oldMember?.context ?? await browser.newContext({ viewport: { width: 1440, height: 900 } }); member = oldMember?.page ?? await memberContext.newPage();
    for (const [context, loginId] of [[ceoContext, 'browserceo'], [memberContext, 'browsermember']]) {
      await responseJson(await context.request.post(root + '/api/auth/login', { data: { loginId, passcode: '8742' }, headers: { origin: root } }));
    }
    const home = await responseJson(await ceoContext.request.get(root + '/api/cards/home'));
    const draft = home.cards.flatMap(c => c.actions).find(a => a.actionType === 'mission-round.draft');
    const drafted = draft ? (await responseJson(await action(ceoContext, draft.actionId))).cards[0] : home.cards.find(c => c.kind === 'mission-round' && c.payload.roundId); assert(drafted);
    const target = drafted.payload.cards.find(c => c.ownerId === 'sun-mingze'); assert(target);
    const other = drafted.payload.cards.find(c => c.ownerId === 'bai-tiantian'); assert(other);
    await ceo.goto(root + '/mission-cards/' + target.cardId);
    if (drafted.payload.phase === 'draft') {
      await ceo.waitForTimeout(1000);
      await ceo.getByRole('button', { name: '统一开放 48 小时讨论', exact: true }).click();
      await ceo.getByText('全战场已统一开放 48 小时讨论。', { exact: true }).waitFor();
    }
    await member.goto(root + '/me/mission-cards/' + target.cardId);
    await member.waitForTimeout(1000);
    const current = await card(memberContext, target.cardId);
    const mission = current.payload.card.missions[0];
    const field = member.locator(`[data-mission-field="${mission.missionId}:outcome"]`).locator('..');
    await field.getByRole('button', { name: '建议修改', exact: true }).click();
    await member.getByLabel('建议修改：预期结果').fill('10 月 25 日前交付可复验的集成方案，并与交付负责人核对验收证据。');
    await member.getByRole('button', { name: '提交修改建议', exact: true }).click();
    await member.getByText('修改建议已记录，当前正文不变；截止后由拍板人集中处理。', { exact: true }).waitFor();
    // A second public suggestion on the same field exercises the real conflict guard.
    const feedback = async (context, id, body) => responseJson(await context.request.post(root + `/api/mission-cards/${id}/feedback`, { data: { clientId: crypto.randomUUID(), round: 1, ...body }, headers: { origin: root } }));
    const second = await feedback(ceoContext, target.cardId, { kind: 'suggestion', missionId: mission.missionId, field: 'outcome', proposed: '10 月 28 日前完成第二版集成方案并统一核对交接。', body: '建议为跨人员联调保留三天缓冲。', sourceVersion: mission.version });
    await feedback(memberContext, target.cardId, { kind: 'suggestion', missionId: mission.missionId, field: 'milestones', proposed: '10 月 15 日 · 完成接口核对\n\n10 月 25 日 · 联合验收', body: '把待定里程碑改为双方可核对的日期。', sourceVersion: mission.version });
    await feedback(ceoContext, other.cardId, { kind: 'comment', body: '已约定由白田田协调交接，需在本轮共同核对验收时点。' });
    save('browser-before.json', control('inspect'));
    save('browser-targets.json', { cardId: target.cardId, otherCardId: other.cardId, missionId: mission.missionId, secondFeedbackId: second.feedback.id, roundId: drafted.payload.roundId });
    await ceo.reload(); await sizes(ceo, 'open');
    save('browser-cutoff-1.json', control('advance'));
    await ceo.reload(); await member.reload();
    log('setup-complete', { cards: drafted.payload.cards.length, suggestions: 3, comments: 1, firstCutoff: true });
  } else {
    const targets = JSON.parse(fs.readFileSync(path.join(evidence, 'browser-targets.json'), 'utf8'));
    const ceoItem = existing.find(item => item.page.url().includes('/mission-cards/') && !item.page.url().includes('/me/'));
    const memberItem = existing.find(item => item.page.url().includes('/me/mission-cards/'));
    ceoContext = ceoItem?.context ?? await browser.newContext({ viewport: { width: 1440, height: 900 } }); ceo = ceoItem?.page ?? await ceoContext.newPage();
    memberContext = memberItem?.context ?? await browser.newContext({ viewport: { width: 1440, height: 900 } }); member = memberItem?.page ?? await memberContext.newPage();
    for (const [context, loginId] of [[ceoContext, 'browserceo'], [memberContext, 'browsermember']]) await responseJson(await context.request.post(root + '/api/auth/login', { data: { loginId, passcode: '8742' }, headers: { origin: root } }));
    await ceo.goto(root + '/mission-cards/' + targets.cardId); await member.goto(root + '/me/mission-cards/' + targets.cardId);
    const script = require('./browser-review.cjs');
    await script({ browser, ceoContext, memberContext, ceo, member, targets, phase, root, card, action, responseJson, capture, sizes, save, log, control, assert });
  }
  // CDP connection is released with this process; the dedicated agent-browser session owns the browser.
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
