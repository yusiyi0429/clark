const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const fs = require('node:fs'); const path = require('node:path');
const passcode = /口令都是 `(\d{4})`/.exec(fs.readFileSync(path.join(__dirname, '../../manual-test/README.md'), 'utf8'))[1];
async function open(browser, loginId) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await ctx.newPage(); page.setDefaultNavigationTimeout(120000);
  await page.goto('http://localhost:3500/access');
  await page.evaluate(async ({ l, p }) => fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginId: l, passcode: p }) }), { l: loginId, p: passcode });
  return page;
}
const call = (page, method, url, body) => page.evaluate(async ({ method, url, body }) => { const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, json: j }; }, { method, url, body });
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const member = await open(browser, 'browsermember');
  const home = await call(member, 'GET', '/api/me/home');
  const task = home.json.myTasks.find((t) => t.title === '灰度发布');
  const detail = await call(member, 'GET', `/api/me/tasks/${task.id}`);
  const ceoOption = detail.json.collaboratorOptions.find((p) => p.name === '验收 CEO');
  if (ceoOption) console.log('invite ceo', (await call(member, 'POST', `/api/me/tasks/${task.id}/collaborators`, { personIds: [ceoOption.personId] })).status);
  const ceo = await open(browser, 'browserceo');
  await ceo.goto('http://localhost:3500/welcome'); await ceo.waitForLoadState('networkidle');
  if (new URL(ceo.url()).pathname === '/welcome') { await ceo.getByRole('button', { name: '先进入工作台' }).click(); await ceo.waitForURL((u) => u.pathname !== '/welcome', { timeout: 60000 }); }
  console.log('ceo api detail', (await call(ceo, 'GET', `/api/me/tasks/${task.id}`)).status);
  await ceo.goto(`http://localhost:3500/me/tasks/${task.id}`); await ceo.waitForLoadState('networkidle'); await ceo.waitForTimeout(1500);
  console.log('ceo landed on', new URL(ceo.url()).pathname);
  await ceo.screenshot({ path: path.join(__dirname, '05b-ceo-invited-1440.png') });
  await ceo.goto('http://localhost:3500/'); await ceo.waitForLoadState('networkidle'); await ceo.waitForTimeout(1500);
  const rail = await ceo.locator('aside').first().innerText().catch(() => '');
  console.log('ceo rail mentions invite:', /邀请你协作/.test(rail));
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
