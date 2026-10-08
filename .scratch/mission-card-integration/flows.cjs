const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { Pool } = require('../../apps/api/node_modules/pg');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'run/fixture.json'), 'utf8'));
assert(fixture.ready && /^warmap_test_[a-f0-9]{12}$/.test(fixture.database));
const evidence = path.join(__dirname, 'evidence'); fs.mkdirSync(evidence, { recursive: true });
const pool = new Pool({ connectionString: `postgres://postgres:postgres@localhost:55432/${fixture.database}`, options: '-c default_transaction_read_only=on' });
const memberCard = fixture.cards.find(card => card.ownerId === 'person-fixture-002');
const ceoCard = fixture.cards.find(card => card.ownerId === 'person-fixture-001');
const checks = [], errors = [];
const baseWidth = process.argv.includes('--phone') ? 390 : 1440;
async function actor(browser, member, width = 1440) {
 const context = await browser.newContext({ viewport: { width, height: width < 960 ? 844 : 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
 const page = await context.newPage(); page.setDefaultNavigationTimeout(120000); page.setDefaultTimeout(20000);
 page.on('pageerror', error => errors.push(error.message));
 await page.goto(fixture.web + '/access');
 await page.evaluate(async member => {
  const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(member ? { loginId: 'ceshiy', passcode: '1357' } : { loginId: 'ceshij', passcode: '2468' }) });
  if (!response.ok) throw Error('Disposable fixture login failed');
  // These flow tests start after the separately verified first-view tutorial.
  const mark = await fetch('/api/me/seen-marks/tour:mission-card', { method: 'POST' }); if (!mark.ok) throw Error('Seen fixture setup failed');
 }, member);
 const card = member ? memberCard : ceoCard;
 await page.goto(fixture.web + (member ? '/me' : '') + '/mission-cards/' + card.id);
 await page.getByRole('button', { name: '查看任务使用说明', exact: true }).waitFor();
 return { page, context };
}
async function menu(page) {
 const dialog = page.getByRole('dialog', { name: '任务卡审核进度与操作', exact: true });
 if (!(await dialog.isVisible())) await page.getByRole('button', { name: /查看审核进度与操作/ }).click();
 await dialog.waitFor(); return dialog;
}
async function choose(page, label) { const dialog = await menu(page); await dialog.getByRole('button', { name: label, exact: true }).click(); }
async function layout(page, width, name) {
 await page.setViewportSize({ width, height: width < 960 ? 844 : 1000 });
 try { await page.locator('.ts-detail-header').waitFor(); }
 catch (error) { await page.screenshot({ path: path.join(evidence, `${name}-${width}-failed.png`) }); console.log(JSON.stringify({ width, name, url: page.url(), body: await page.locator('body').innerText() })); throw error; }
 await page.waitForTimeout(400);
 const state = await page.evaluate(() => {
  const header = document.querySelector('.ts-detail-header'); const h = header.getBoundingClientRect();
  const buttons = [...header.querySelectorAll('button')].map(button => {
   const r = button.getBoundingClientRect(); return { label: button.getAttribute('aria-label') || button.textContent.trim(), x: r.x, y: r.y, w: r.width, h: r.height };
  }).filter(button => button.w && button.h);
  return { header: { x: h.x, y: h.y, w: h.width, h: h.height }, buttons, scroll: document.documentElement.scrollWidth, viewport: innerWidth };
 });
 assert.equal(Math.round(state.header.h), 48, JSON.stringify(state));
 assert(state.scroll <= width, 'Horizontal document overflow: ' + JSON.stringify(state));
 for (const button of state.buttons) assert(button.x >= state.header.x - 1 && button.x + button.w <= state.header.x + state.header.w + 1, 'Button outside header: ' + JSON.stringify(button));
 for (let i = 0; i < state.buttons.length; i++) for (let j = i + 1; j < state.buttons.length; j++) {
  const a = state.buttons[i], b = state.buttons[j];
  const overlap = a.x < b.x + b.w - 1 && a.x + a.w > b.x + 1 && a.y < b.y + b.h - 1 && a.y + a.h > b.y + 1;
  assert(!overlap, 'Header buttons overlap: ' + JSON.stringify([a, b]));
 }
 await page.screenshot({ path: path.join(evidence, `${name}-${width}.png`) });
 return state;
}
async function selection(page, card, body) {
 const field = page.locator(`[data-mission-field="${card.missionId}:outcome"]`);
 await field.scrollIntoViewIfNeeded();
 await field.evaluate(node => {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let text;
  while (text = walker.nextNode()) { const at = text.textContent.indexOf('核对'); if (at >= 0) {
   const range = document.createRange(); range.setStart(text, at); range.setEnd(text, at + 2);
   const picked = getSelection(); picked.removeAllRanges(); picked.addRange(range);
   node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return;
  } } throw Error('Selection fixture text not found');
 });
 const toolbar = page.getByRole('toolbar', { name: '选中文字操作', exact: true }); await toolbar.waitFor();
 await toolbar.getByRole('button', { name: '直接批注', exact: true }).click();
 const input = page.getByRole('dialog', { name: '添加批注', exact: true }); await input.waitFor();
 const bounds = await input.boundingBox(), viewport = page.viewportSize();
 assert(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height, 'Inline input outside viewport');
 await input.getByRole('textbox', { name: '批注内容', exact: true }).fill(body);
 await input.getByRole('button', { name: '保存批注', exact: true }).click();
 try { await input.waitFor({ state: 'hidden' }); } catch (error) { console.log(JSON.stringify({ annotationError: await input.innerText() })); throw error; }
}
async function state(card) {
 return (await pool.query('SELECT owner_confirmed_at FROM personal_mission_cards WHERE id=$1', [card.id])).rows[0];
}
async function waitFor(query, expected, timeout = 20000) {
 const start = Date.now(); while (Date.now() - start < timeout) { const result = await query(); if (expected(result)) return result; await new Promise(resolve => setTimeout(resolve, 100)); }
 throw Error('Database state did not reach expected value');
}
(async () => {
 const browser = await chromium.launch({ channel: 'chrome', headless: true });
 try {
  const ceo = await actor(browser, false, baseWidth), member = await actor(browser, true, baseWidth);
  const before = (await pool.query('SELECT status FROM mission_rounds WHERE id=$1', [fixture.round])).rows[0];
  assert(['draft', 'open'].includes(before.status), 'Start this flow with a fresh fixture');
  if (before.status === 'draft') await choose(ceo.page, '下发审核');
  await member.page.reload(); await member.page.getByRole('button', { name: '完成本人审核', exact: true }).waitFor();
  checks.push('CEO issues review through header menu');
  for (const width of baseWidth === 390 ? [320, 390] : [320, 360, 390, 768, 959, 1440]) await layout(member.page, width, 'member-header');
  for (const width of baseWidth === 390 ? [320, 390] : [320, 390, 1440]) await layout(ceo.page, width, 'ceo-header');
  checks.push(baseWidth === 390 ? '48px header and no button overlap at 320/390' : '48px header and no button overlap at 320/360/390/768/959/1440');
  await member.page.setViewportSize({ width: baseWidth, height: baseWidth === 390 ? 844 : 1000 });
  await ceo.page.setViewportSize({ width: baseWidth, height: baseWidth === 390 ? 844 : 1000 });
  await member.page.locator('[data-mission-view] button').click();
  const viewMenu = member.page.getByRole('dialog', { name: '任务视图', exact: true });
  assert(await viewMenu.getByRole('button', { name: /执行拆分/ }).isDisabled());
  await member.page.keyboard.press('Escape'); checks.push('Task views stay in header and execution split is disabled');
  await selection(member.page, memberCard, '请补充双视角的证据对象。');
  await waitFor(() => pool.query('SELECT status FROM mission_card_annotations WHERE card_id=$1 ORDER BY created_at,id', [memberCard.id]), result => result.rows.some(row => row.status === 'applied'));
  await member.page.getByText('核对 CEO 与 DRI 双视角的界面和权限证据。', { exact: true }).first().waitFor();
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM conversation_messages WHERE content LIKE '%请补充双视角的证据对象。%'")).rows[0].n), 0);
  assert.equal((await pool.query('SELECT before_text,after_text FROM mission_card_revisions WHERE card_id=$1', [memberCard.id])).rowCount, 1);
  await member.page.screenshot({ path: path.join(evidence, `direct-annotation-${baseWidth}.png`) });
  checks.push('Direct annotation updates text, saves before/after, and does not enter private chat');
  await selection(member.page, memberCard, '需要澄清走查身份的范围。');
  const clarify = member.page.getByRole('complementary', { name: '明确修改意图', exact: true }); await clarify.waitFor();
  await member.page.getByRole('button', { name: '完成本人审核', exact: true }).waitFor();
  await waitFor(async () => member.page.getByRole('button', { name: '完成本人审核', exact: true }).isDisabled(), value => value === true);
  await clarify.getByRole('button', { name: '自己输入', exact: true }).click();
  await clarify.getByRole('textbox', { name: '补充你的意思', exact: true }).fill('逐项核对 CEO 和 DRI 两种身份。');
  await clarify.getByRole('button', { name: '确认并继续', exact: true }).click();
  await clarify.waitFor({ state: 'hidden' });
  await waitFor(() => pool.query("SELECT count(*)::int AS n FROM mission_card_annotations WHERE card_id=$1 AND status='applied'", [memberCard.id]), result => result.rows[0].n === 2);
  await member.page.getByText('逐项核对 CEO 和 DRI 两种身份。', { exact: true }).first().waitFor();
  checks.push('Clarification blocks review; custom answer immediately updates text and remains in history');
  await selection(member.page, memberCard, '失败：保留这条意见等待更多证据。');
  await waitFor(() => pool.query("SELECT status FROM mission_card_annotations WHERE card_id=$1 AND body LIKE '失败：%'", [memberCard.id]), result => result.rows[0]?.status === 'failed');
  const failed = member.page.locator('[data-failed="true"]').locator('..');
  await failed.getByRole('button', { name: '保留备注，暂不修改', exact: true }).click();
  await failed.getByRole('textbox', { name: '暂不修改的原因', exact: true }).fill('缺少验收材料，保留备注供拍板人核对。');
  await failed.getByRole('button', { name: '确认保留备注', exact: true }).click();
  await waitFor(() => pool.query("SELECT status,note FROM mission_card_annotations WHERE card_id=$1 AND body LIKE '失败：%'", [memberCard.id]), result => result.rows[0]?.status === 'no_change' && result.rows[0].note.includes('缺少验收材料'));
  await waitFor(async () => member.page.getByRole('button', { name: '完成本人审核', exact: true }).isEnabled(), value => value === true);
  checks.push('Explicit retain-note action preserves reason and unblocks review');
  await member.page.getByRole('button', { name: '完成本人审核', exact: true }).click();
  await member.page.getByRole('button', { name: '取消审核确认', exact: true }).waitFor();
  assert((await state(memberCard)).owner_confirmed_at);
  await selectionLocked(member.page, memberCard);
  await member.page.getByRole('toolbar', { name: '选中文字操作', exact: true }).getByRole('button', { name: '引用并对话', exact: true }).click();
  const privateComposer = member.page.locator('[data-conversation-context="mission-card:' + memberCard.id + '"] textarea');
  await waitFor(() => privateComposer.inputValue(), value => value.includes('战役结果'));
  await privateComposer.fill(''); await privateComposer.blur();
  if (baseWidth === 390) await member.page.keyboard.press('Escape');
  checks.push('Selected quote goes to the private Co-Agent composer, including after owner confirmation');
  await member.page.getByRole('button', { name: '取消审核确认', exact: true }).click();
  await member.page.getByRole('button', { name: '完成本人审核', exact: true }).waitFor();
  assert.equal((await state(memberCard)).owner_confirmed_at, null);
  checks.push('Owner confirmation freezes direct edits; cancellation restores review');
  await choose(ceo.page, '开始汇总');
  const confirm = ceo.page.getByRole('alertdialog', { name: '请确认', exact: true }); await confirm.waitFor();
  assert((await confirm.innerText()).includes('测试乙'));
  await confirm.getByRole('button', { name: '开始汇总', exact: true }).click();
  await waitFor(() => pool.query('SELECT status FROM mission_rounds WHERE id=$1', [fixture.round]), result => result.rows[0].status === 'reviewing');
  await choose(ceo.page, '重新开放审核');
  const reopenConfirm = ceo.page.getByRole('alertdialog', { name: '请确认', exact: true });
  await reopenConfirm.getByRole('button', { name: '重新开放审核', exact: true }).click();
  await waitFor(() => pool.query('SELECT status,window_seq FROM mission_rounds WHERE id=$1', [fixture.round]), result => result.rows[0].status === 'open' && result.rows[0].window_seq === 2);
  assert.equal((await state(memberCard)).owner_confirmed_at, null); assert.equal((await state(ceoCard)).owner_confirmed_at, null);
  checks.push('Early summary names unfinished people; reopen clears every owner confirmation');
  const progress = await menu(ceo.page); await progress.getByRole('button', { name: /打开测试乙的/ }).click();
  await ceo.page.waitForURL('**/mission-cards/' + memberCard.id);
  assert((await ceo.page.locator('.ts-detail-header > h1').innerText()).includes('测试乙'));
  const backToMine = await menu(ceo.page); await backToMine.getByRole('button', { name: /打开测试甲的/ }).click();
  await ceo.page.waitForURL('**/mission-cards/' + ceoCard.id);
  checks.push('Header people menu switches cards and preserves common detail layout');
  await member.page.reload();
  await member.page.getByRole('button', { name: '完成本人审核', exact: true }).click();
  await member.page.getByRole('button', { name: '取消审核确认', exact: true }).waitFor();
  await ceo.page.getByRole('button', { name: '完成本人审核', exact: true }).click();
  await waitFor(() => pool.query('SELECT status FROM mission_rounds WHERE id=$1', [fixture.round]), result => result.rows[0].status === 'reviewing');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM mission_round_reviews WHERE round_id=$1 AND superseded_at IS NULL', [fixture.round])).rows[0].n, 1);
  checks.push('Last owner automatically enters review with exactly one current snapshot');
  await choose(ceo.page, '确认前核对');
  const workflow = ceo.page.getByRole('dialog', { name: '任务卡审核进度与操作', exact: true });
  await workflow.getByRole('textbox', { name: '依赖、冲突与协作的核对结论', exact: true }).fill('已核对两种身份的任务边界、交接时间与证据归属；保留备注留待后续补证。');
  await workflow.getByRole('button', { name: '确认本月任务', exact: true }).click();
  await waitFor(() => pool.query('SELECT status FROM mission_rounds WHERE id=$1', [fixture.round]), result => result.rows[0].status === 'confirmed');
  await member.page.reload();
  assert.equal(await member.page.getByRole('button', { name: '完成本人审核', exact: true }).count(), 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM mission_card_revisions WHERE card_id=$1', [memberCard.id])).rows[0].n, 2);
  await member.page.screenshot({ path: path.join(evidence, `confirmed-history-${baseWidth}.png`) });
  checks.push('Final dependency check stays reachable and confirmed card preserves all annotations and history');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  const result = { passed: true, width: baseWidth, checks, unhandledErrors: errors };
  fs.writeFileSync(path.join(__dirname, `run/flows-${baseWidth}.json`), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  await ceo.context.close(); await member.context.close();
 } catch (error) {
  console.error(JSON.stringify({ passed: false, checks, error: String(error) })); throw error;
 } finally { await browser.close(); await pool.end(); }
})().catch(error => { console.error(error); process.exit(1); });

async function selectionLocked(page, card) {
 const field = page.locator(`[data-mission-field="${card.missionId}:outcome"]`);
 await field.scrollIntoViewIfNeeded();
 await field.evaluate(node => { const text = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode(); const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, Math.min(2, text.textContent.length)); const picked = getSelection(); picked.removeAllRanges(); picked.addRange(range); node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
 const toolbar = page.getByRole('toolbar', { name: '选中文字操作', exact: true }); await toolbar.waitFor();
 assert(await toolbar.getByRole('button', { name: '直接批注', exact: true }).isDisabled());
 assert(await toolbar.getByRole('button', { name: '引用并对话', exact: true }).isEnabled());
}
