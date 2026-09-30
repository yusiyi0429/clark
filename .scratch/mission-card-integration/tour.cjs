const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'run/fixture.json'), 'utf8'));
assert(fixture.ready && /^warmap_test_[a-f0-9]{12}$/.test(fixture.database));
const evidence = path.join(__dirname, 'evidence'); fs.mkdirSync(evidence, { recursive: true });
(async () => {
 const browser = await chromium.launch({ channel: 'chrome', headless: true });
 try {
  for (const width of process.argv.includes('--phone') ? [390] : [1440, 390]) {
   const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'no-preference' });
   const page = await context.newPage(); page.setDefaultNavigationTimeout(120000); page.setDefaultTimeout(20000);
   const errors = []; page.on('pageerror', error => errors.push(error.message));
   await page.goto(fixture.web + '/access');
   await page.evaluate(async () => {
    const login = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: 'ceshiy', passcode: '1357' }) });
    if (!login.ok) throw Error('Disposable fixture login failed');
    const reset = await fetch('/api/me/seen-marks/tour:mission-card', { method: 'DELETE' });
    if (!reset.ok) throw Error('Tour fixture reset failed');
   });
   const card = fixture.cards.find(card => card.ownerId === 'person-fixture-002');
   await page.goto(fixture.web + '/me/mission-cards/' + card.id);
   const guide = page.getByRole('dialog', { name: '任务卡怎么用', exact: true }); await guide.waitFor();
   await guide.evaluate(async dialog => {
    const entering = dialog.closest('[data-entering]');
    if (entering) await Promise.allSettled(entering.getAnimations().map(animation => animation.finished));
   });
   await page.keyboard.press('Escape'); assert.equal(await guide.count(), 1);
   assert.equal(await guide.getByRole('button', { name: '开始查看任务', exact: true }).count(), 0);
   const headings = [];
   for (let step = 1; step <= 5; step++) {
    await guide.getByText(`第 ${step} 步，共 5 步`, { exact: true }).waitFor();
    const name = step === 5 ? '开始查看任务' : '下一步';
    await page.waitForFunction(() => {
     const dialog = document.querySelector('[role="dialog"][aria-label="任务卡怎么用"]');
     return dialog && dialog.getAnimations({ subtree: true }).some(animation => animation.effect?.getTiming().iterations !== Infinity && animation.playState === 'running');
    });
    const bounds = await guide.boundingBox();
    if (!(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= (width === 390 ? 844 : 1000))) await page.screenshot({ path: path.join(evidence, `tour-overflow-${width}-${step}.png`) });
    assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= (width === 390 ? 844 : 1000), `Tour outside ${width}px at step ${step}: ${JSON.stringify(bounds)}`);
    if (step === 1) {
     const next = guide.getByRole('button', { name, exact: true });
     assert.equal(await next.getAttribute('aria-disabled'), 'true');
     await next.evaluate(button => button.click());
     assert.equal(await guide.getByText('第 1 步，共 5 步', { exact: true }).count(), 1);
    }
    headings.push(await guide.getByRole('heading').innerText());
    await page.waitForFunction(name => {
     const dialog = document.querySelector('[role="dialog"][aria-label="任务卡怎么用"]');
     return dialog && [...dialog.querySelectorAll('button')].some(button => button.textContent.trim() === name && button.getAttribute('aria-disabled') !== 'true');
    }, name);
    await page.screenshot({ path: path.join(evidence, `tour-${width}-${step}.png`) });
    await guide.getByRole('button', { name, exact: true }).click();
   }
   await guide.waitFor({ state: 'hidden' });
   await page.reload(); await page.getByRole('button', { name: '查看任务使用说明', exact: true }).waitFor();
   assert.equal(await guide.count(), 0, 'Completed tour appeared again');
   await page.getByRole('button', { name: '查看任务使用说明', exact: true }).click(); await guide.waitFor();
   await guide.getByText('第 1 步，共 5 步', { exact: true }).waitFor();
   assert.equal(errors.length, 0, JSON.stringify(errors));
   console.log(JSON.stringify({ passed: true, width, headings, checks: ['actual animations on five pages', 'first view cannot skip', 'viewport fit', 'completion persisted', 'help replay', 'no unhandled browser errors'] }));
   await context.close();
  }
 } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
