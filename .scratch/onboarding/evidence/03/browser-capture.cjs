// Uses an already-running dedicated agent-browser CDP endpoint; never owns/stops other browsers.
const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const [endpoint, identity = 'member', label = identity, route = '/me'] = process.argv.slice(2);
const people = { member: ['browsermember', '孙铭泽'], dri: ['browserdri', '林知行'], nocard: ['browsernocard', '何望舒'], empty: ['browserempty', '顾清和'] };
const root = 'http://localhost:3500';
if (!endpoint || !people[identity] || !/^[a-z0-9-]+$/.test(label) || (!route.startsWith('/me') && route !== '/evidence-03-radar')) {
  console.error('Usage: node browser-capture.cjs <CDP endpoint> member|dri|nocard|empty <file-label> [/me/path]');
  process.exit(2);
}
const save = (name, value) => fs.writeFileSync(path.join(__dirname, name), JSON.stringify(value, null, 2) + '\n');
async function main() {
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page = context.pages().find(item => item.url().startsWith(root)) || await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(root + '/access');
  const login = await page.evaluate(async loginId => {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginId, passcode: '8742' }) });
    return { status: response.status };
  }, people[identity][0]);
  assert.equal(login.status, 200, 'Synthetic login failed');
  await page.goto(root + route);
  await page.waitForURL(root + route);
  await page.getByRole('region', { name: '执行事项', exact: true }).waitFor({ state: 'attached' });
  await page.evaluate(() => document.fonts.ready);
  const metrics = [];
  for (const [width, height] of [[1440, 900], [1280, 800], [834, 1194], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(400);
    const observed = await page.evaluate(() => {
      const tasks = document.querySelector('[aria-label="执行事项"]');
      const rect = tasks?.getBoundingClientRect();
      return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
        overflow: document.documentElement.scrollWidth > innerWidth, overlay: !!document.querySelector('[data-nextjs-dialog],.vite-error-overlay'),
        tasksTop: rect?.top ?? null, tasksInFirstScreen: !!rect && rect.top >= 0 && rect.top < innerHeight,
        heading: document.querySelector('h1')?.textContent,
        bodyText: document.body.innerText,
      };
    });
    const screenshot = `${label}-${width}.png`;
    await page.screenshot({ path: path.join(__dirname, screenshot) });
    metrics.push({ screenshot, ...observed });
    assert.equal(observed.overflow, false, `Horizontal overflow at ${width}`);
    assert.equal(observed.overlay, false, `Runtime error overlay at ${width}`);
    if ((route === '/me' || route === '/evidence-03-radar') && width >= 1280) assert.equal(observed.tasksInFirstScreen, true, `Tasks below first screen at ${width}`);
  }
  const facts = await page.evaluate(async () => {
    const home = await (await fetch('/api/me/home')).json();
    const rounds = await (await fetch('/api/me/mission-cards')).json();
    const forbidden = await fetch('/api/me/battlefields/private-field');
    return { work: home.work, tasks: home.myTasks?.map(item => ({ title: item.title, status: item.status })), notices: rounds.rounds?.length, forbiddenBattlefieldStatus: forbidden.status };
  });
  save(`browser-${label}-metrics.json`, { identity, route, metrics, facts, errors });
  assert.deepEqual(errors, []);
  assert.equal(facts.forbiddenBattlefieldStatus, 404);
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log(JSON.stringify({ label, screenshots: metrics.map(item => item.screenshot), facts, errors }));
  // CDP attachment belongs to agent-browser. Caller closes that session during cleanup.
}
main().then(() => process.exit(0)).catch(error => { console.error(error.stack); process.exit(1); });
