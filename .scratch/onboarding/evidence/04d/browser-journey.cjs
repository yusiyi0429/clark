// Disposable database, synthetic identities, actual Web/API; no production credentials.
const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = 'http://localhost:3500';
const endpoint = process.argv[2], phase = process.argv[3] || 'setup';
const save = (name, value) => fs.writeFileSync(path.join(__dirname, name), JSON.stringify(value, null, 2));
const log = (name, facts = {}) => { const line = JSON.stringify({ name, ...facts }); fs.appendFileSync(path.join(__dirname, 'browser-journey.log'), line + '\n'); console.log(line); };
const control = command => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'browser-control.cjs'), command], { encoding: 'utf8' }));
async function json(response, status = 200) { assert.equal(response.status(), status, (await response.text()).slice(0, 200)); return response.json(); }
async function get(page, url) { return page.evaluate(async url => { const response = await fetch(url); if (!response.ok) throw new Error('GET ' + response.status); return response.json(); }, url); }
async function post(page, url, data) { return page.evaluate(async ({url,data}) => { const response = await fetch(url, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}); if (!response.ok) throw new Error('POST ' + response.status + ' ' + await response.text()); return response.json(); }, {url,data}); }
const card = async (context, id) => (await get(context, '/api/mission-cards/' + id)).cards[0];
const action = (context, actionId, viewCardId, input = {}) => post(context, '/api/mission-rounds/actions/execute', { actionId, viewCardId, input });
async function capture(page, name) {
  await page.waitForTimeout(350);
  const metrics = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, overflow: document.documentElement.scrollWidth > innerWidth, overlay: !!document.querySelector('[data-nextjs-dialog],.vite-error-overlay'), heading: document.querySelector('h1')?.textContent }));
  assert.equal(metrics.overflow, false); assert.equal(metrics.overlay, false);
  await page.screenshot({ path: path.join(__dirname, name + '.png') }); log(name, metrics);
}
async function sizes(page, name) {
  for (const [width, height] of [[1440, 900], [834, 1194], [390, 844]]) { await page.setViewportSize({ width, height }); await capture(page, name + '-' + width); }
  await page.setViewportSize({ width: 1440, height: 900 });
}
async function startWelcome(page) { await page.goto(root + '/welcome'); await page.getByRole('button', { name: '开始', exact: true }).click(); await page.getByRole('button', { name: '下一步', exact: true }).waitFor(); }
async function main() {
  const browser = await chromium.connectOverCDP(endpoint);
  const memberBrowser = await chromium.connectOverCDP('ws://127.0.0.1:49930/devtools/browser/0301b75b-bbff-4c51-a85a-553d6a96bfd5');
  let ceo = browser.contexts()[0].pages().find(p => p.url().startsWith(root)) || await browser.contexts()[0].newPage();
  let member = memberBrowser.contexts()[0].pages().find(p => p.url().startsWith(root)) || await memberBrowser.contexts()[0].newPage();
  for (const page of [ceo, member]) page.on('pageerror', error => log('page-error', { message: error.message }));
  if (phase === 'setup') {
    for (const [page, loginId] of [[ceo, 'browserceo'], [member, 'browsermember']]) { await page.goto(root + '/access'); await post(page, '/api/auth/login', { loginId, passcode: '8742' }); }
    await startWelcome(ceo); await ceo.getByRole('button', { name: '下一步', exact: true }).click();
    await ceo.getByRole('button', { name: '整理 10 月个人卡', exact: true }).waitFor(); await sizes(ceo, 'ceo-next-draft');
    await ceo.getByRole('button', { name: '整理 10 月个人卡', exact: true }).click();
    await ceo.getByRole('alertdialog', { name: '请确认' }).waitFor(); await sizes(ceo, 'ceo-draft-confirm');
    await ceo.getByRole('alertdialog').getByRole('button', { name: '整理个人卡草稿', exact: true }).click();
    await ceo.getByRole('button', { name: '统一开放 48 小时讨论', exact: true }).waitFor();
    const home = await get(ceo, '/api/cards/home'); const round = home.cards.find(c => c.kind === 'mission-round').payload;
    const mine = round.cards.find(c => c.ownerId === 'sun-mingze'), other = round.cards.find(c => c.ownerId === 'bai-tiantian');
    save('browser-targets.json', { cardId: mine.cardId, otherCardId: other.cardId, roundId: round.roundId });
    await ceo.getByRole('button', { name: '返回总览', exact: true }).click(); await ceo.locator('[data-notice-group="mission-card"]').waitFor();
    await sizes(ceo, 'ceo-draft-notice');
    await startWelcome(member); await member.getByRole('region', { name: '我的本月卡' }).waitFor(); await sizes(member, 'member-work-draft');
    await ceo.locator('[data-notice-group="mission-card"]').getByRole('button', { name: /白田田.*查看详情/ }).click();
    await ceo.getByRole('button', { name: '统一开放 48 小时讨论', exact: true }).click(); await ceo.getByText('全战场已统一开放 48 小时讨论。', { exact: true }).waitFor();
    await member.bringToFront(); await member.evaluate(() => window.dispatchEvent(new Event('focus')));
    await member.getByText(/草稿 · 讨论中/).waitFor(); await sizes(member, 'member-work-open');
    await member.getByRole('button', { name: '下一步', exact: true }).click(); await member.getByRole('button', { name: '查看我的 10 月卡', exact: true }).waitFor(); await sizes(member, 'member-next-open');
    await member.getByRole('button', { name: '查看我的 10 月卡', exact: true }).click(); await member.waitForURL('**/me/mission-cards/' + mine.cardId + '*');
    await member.getByRole('button', { name: '返回总览', exact: true }).click(); await member.locator('[data-notice-group="mission-card"]').waitFor();
    assert.equal(await member.locator('[data-notice-group="mission-card"] li').count(), 1); await sizes(member, 'member-open-notice');
    await ceo.getByRole('button', { name: '返回总览', exact: true }).click(); await sizes(ceo, 'ceo-open-notice');
    assert.equal(await ceo.locator('[data-notice-group="mission-card"] li').count(), 5);
    for (const [context, id, body] of [[member, mine.cardId, '请共同核对本月交接时间。'], [ceo, other.cardId, '需要明确跨人员的验收安排。']]) await post(context, '/api/mission-cards/' + id + '/feedback', { clientId: crypto.randomUUID(), round: 1, kind: 'comment', body });
    await member.locator('[data-notice-group="mission-card"]').getByRole('button', { name: /孙铭泽.*查看详情/ }).click(); await member.waitForURL('**/me/mission-cards/' + mine.cardId);
    await member.getByRole('button', { name: '返回总览', exact: true }).click();
    await member.waitForFunction(() => document.activeElement?.getAttribute('aria-label')?.includes('孙铭泽'));
    const focus = await member.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    assert.match(focus || '', /孙铭泽/); log('member-return-focus', { focus });
    save('browser-before.json', control('inspect')); log('setup-complete');
  } else {
    const targets = JSON.parse(fs.readFileSync(path.join(__dirname, 'browser-targets.json'), 'utf8'));
    assert(ceo && member);
    if (phase === 'visual') {
      save('browser-visual-review.json', control('advance'));
      await ceo.goto(root + '/'); await member.goto(root + '/me');
      await ceo.getByRole('button', {name:'2 条待你处理',exact:true}).waitFor();
      await sizes(ceo,'ceo-review-notice'); await sizes(member,'member-review-notice');
      await ceo.getByRole('button', {name:'2 条待你处理',exact:true}).click();
      await ceo.getByRole('button',{name:'重新开启 48 小时',exact:true}).click();
      await ceo.getByRole('alertdialog').getByRole('button',{name:'重新开启 48 小时',exact:true}).click();
      await ceo.getByText('已重新开启 48 小时讨论，已有公开意见保留。',{exact:true}).waitFor();
      await ceo.getByRole('button',{name:'返回总览',exact:true}).click();
      await member.evaluate(()=>window.dispatchEvent(new Event('focus')));
      await member.getByText('第 2 轮',{exact:true}).first().waitFor();
      await sizes(ceo,'ceo-reopened-notice'); await sizes(member,'member-reopened-notice');
      const cdp=await member.context().newCDPSession(member);
      await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'},{name:'prefers-reduced-transparency',value:'reduce'}]});
      await member.setViewportSize({width:390,height:844}); await capture(member,'member-reduced-motion-transparency-390');
      await cdp.send('Emulation.setEmulatedMedia',{features:[]});
      save('browser-visual-final.json',control('inspect')); log('reopen-second-round-synced');
    } else if (phase === 'near') {
      save('browser-near.json', control('near'));
      await member.goto(root + '/me/mission-cards/' + targets.cardId);
      await ceo.goto(root + '/');
      await member.locator('.ts-detail-header time[data-tone="paper"]').waitFor();
      await member.evaluate(() => {
        window.__clockSamples = []; let previous = '';
        const sample = () => { const values = [...document.querySelectorAll('time[data-tone]')].map(n => ({ tone: n.dataset.tone, value: n.querySelector('span:not([aria-hidden])')?.textContent })); const text = JSON.stringify(values); if (text !== previous) { window.__clockSamples.push({ at: performance.now(), values }); previous = text; } window.__clockFrame = requestAnimationFrame(sample); }; sample();
      });
      await sizes(member, 'member-last-minute'); await sizes(ceo, 'ceo-last-minute');
      await member.waitForFunction(() => [...document.querySelectorAll('time[data-tone="paper"]')].some(n => n.textContent.includes('已截止')), null, { timeout: 85000 });
      save('browser-clock-samples.json', await member.evaluate(() => { cancelAnimationFrame(window.__clockFrame); return window.__clockSamples; }));
      await sizes(member, 'member-cutoff'); await sizes(ceo, 'ceo-cutoff-notice');
      await ceo.getByRole('button', { name: '2 条待你处理', exact: true }).waitFor({ timeout: 70000 });
      await sizes(ceo, 'ceo-review-notice');
      await member.getByRole('button', { name: '返回总览', exact: true }).click(); await sizes(member, 'member-review-notice');
      assert.equal(await member.locator('[data-notice-group="mission-card"] li').count(), 1);
      log('natural-cutoff-complete');
    } else if (phase === 'confirm') {
      control('welcome-member'); control('welcome-ceo');
      for (const [page, name, label] of [[member, 'member', '查看我的 10 月卡'], [ceo, 'ceo', '查看 10 月个人卡']]) {
        await startWelcome(page);
        if (name === 'member') { await sizes(page, 'member-work-review-final'); await page.setViewportSize({width:390,height:844}); await page.getByRole('region', {name:'我的本月卡'}).scrollIntoViewIfNeeded(); await capture(page,'member-work-review-scrolled-390'); await page.setViewportSize({width:1440,height:900}); }
        await page.getByRole('button', {name:'下一步',exact:true}).click(); await sizes(page,name+'-next-review');
        await page.getByRole('button',{name:label,exact:true}).click(); await page.waitForURL('**/mission-cards/*');
        await page.goto(root + (name === 'member' ? '/me' : '/'));
      }
      await ceo.getByRole('button', { name: '2 条待你处理', exact: true }).click();
      await ceo.waitForFunction(() => document.activeElement?.id?.startsWith('feedback-'));
      log('first-pending-focused', { id: await ceo.evaluate(() => document.activeElement.id) });
      await ceo.getByRole('button', { name: '已纳入核对', exact: true }).first().click();
      let mine = await card(ceo, targets.cardId);
      for (const feedback of mine.payload.feedback.filter(f => !f.decision)) { const a = feedback.actions.find(a => a.actionType === 'mission-round.decide'); await action(ceo, a.actionId, targets.cardId, { decision: 'accept' }); }
      await ceo.goto(root + '/'); await ceo.getByRole('button', { name: '意见已全部处理，待你确认', exact: true }).waitFor(); await sizes(ceo, 'ceo-confirm-ready-notice');
      await ceo.getByRole('button', { name: '意见已全部处理，待你确认', exact: true }).click();
      await ceo.getByRole('button', { name: '确认前核对', exact: true }).click();
      await ceo.getByLabel('跨人员依赖、冲突与协作的核对结论').fill('各位已核对交接时间、验收证据和依赖边界，同意本月承诺。');
      await ceo.getByRole('button', { name: '确认本月 Mission Card', exact: true }).click(); await ceo.getByText('本月 Mission Card 已确定，确认记录与公开意见保留可查。', { exact: true }).waitFor();
      await ceo.getByRole('button', { name: '返回总览', exact: true }).click(); await ceo.locator('[data-notice-group="mission-card"]').waitFor({ state: 'detached' }); await sizes(ceo, 'ceo-confirmed-home');
      await member.bringToFront(); await member.evaluate(() => window.dispatchEvent(new Event('focus'))); await member.locator('[data-notice-group="mission-card"]').waitFor({ state: 'detached' }); await sizes(member, 'member-confirmed-home');
      control('welcome-member'); await startWelcome(member); await member.getByText(/已确定/).first().waitFor(); await sizes(member, 'member-work-confirmed');
      await member.getByRole('button', { name: '下一步', exact: true }).click(); await member.getByRole('button', { name: '进入工作台', exact: true }).click();
      await member.waitForURL(root + '/me');
      await member.goto(root + '/me/mission-cards/' + targets.cardId); await sizes(member, 'member-confirmed-card');
      const result = await get(member, '/api/me/mission-cards'); assert.equal(result.rounds.length, 0);
      const onboard = await get(member, '/api/me/onboarding'); assert.equal(onboard.work.missionCards[0].phase, 'confirmed');
      save('browser-final.json', control('inspect')); log('confirmation-removed-notices-retained-card');
    }
  }
  // Dedicated agent-browser owns the browser; close it during final cleanup.
}
main().then(() => process.exit(0)).catch(error => { console.error(error.stack); process.exit(1); });




