// Claude 验收工单 05：自起无头 Chrome，只访问 localhost:3500 时间机器（一次性库）。
// 用法：node claude-05.cjs flow|phone
const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const fs = require('node:fs');
const path = require('node:path');

const root = 'http://localhost:3500';
const readme = fs.readFileSync(path.join(__dirname, '../../manual-test/README.md'), 'utf8');
const passcode = /口令都是 `(\d{4})`/.exec(readme)[1];
const SUN_CARD = process.env.SUN_CARD;
const mode = process.argv[2];
const file = (name) => path.join(__dirname, name);
const out = [];
const log = (step, value = {}) => { out.push({ step, ...value }); console.log(JSON.stringify({ step, ...value })); };

async function open(browser, loginId, width = 1440, height = 900) {
  const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text().slice(0, 200)); });
  await page.goto(root + '/access');
  const status = await page.evaluate(async ({ loginId, passcode }) => (await fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginId, passcode }),
  })).status, { loginId, passcode });
  if (status !== 200) throw new Error(`Synthetic login failed: ${status}`);
  return { context, page, errors };
}
async function settle(page, ms = 700) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
const texts = (page, selector) => page.locator(selector).allInnerTexts().then((all) => all.map((value) => value.replace(/\s+/g, ' ').trim()));
async function shot(page, name, full = false) { await page.screenshot({ path: file(name), fullPage: full }); return name; }
async function api(page, method, url, body) {
  return page.evaluate(async ({ method, url, body }) => {
    const response = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await response.json(); } catch { /* 204 */ }
    return { status: response.status, json };
  }, { method, url, body });
}

async function flow(browser) {
  const { page, errors } = await open(browser, 'browsermember');
  await page.goto(root + '/me');
  await settle(page, 1500);
  log('home', { toolbar: await texts(page, '[aria-label="执行事项"] > div:first-child'), cards: await texts(page, '[data-task]'), shot: await shot(page, '05-home-1440.png') });

  await page.getByRole('button', { name: '开启执行事项' }).first().click();
  await page.getByRole('heading', { name: '开启执行事项' }).first().waitFor({ timeout: 20000 });
  await settle(page, 900);
  const options = await page.locator('form select option').allInnerTexts();
  log('create', { options, shot: await shot(page, '05-create-1440.png') });
  await page.getByLabel('执行事项标题').fill('整理上线清单');
  await page.locator('form select').selectOption({ index: 1 });
  const dates = page.locator('form input[type="date"]');
  await dates.nth(0).fill('2026-10-05');
  await dates.nth(1).fill('2026-10-09');
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/me\/tasks\/[0-9a-f-]{36}$/, { timeout: 20000 });
  await settle(page, 1500);
  const taskId = page.url().split('/').pop();
  log('detail', { taskId, header: await texts(page, 'h1'), pane: (await page.locator('main, [data-testid="expanded-panel"]').first().innerText()).slice(0, 900), shot: await shot(page, '05-detail-1440.png') });

  await page.getByRole('button', { name: '邀请协作' }).click();
  await page.getByRole('dialog').waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  log('invite-dialog', { people: await texts(page, '[role="dialog"] label'), shot: await shot(page, '05-invite-1440.png') });
  await page.locator('[role="dialog"] input[type="checkbox"]').first().check();
  await page.getByRole('button', { name: '加入协作与群聊' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  await settle(page, 1200);
  log('invited', { participants: await texts(page, 'text=/参与：/'), thread: await texts(page, '[aria-label="事项群组公开讨论"] article') });

  // 同一项个人任务下再建一步，不给日期：看首页「等上一步」和计划能否保存。
  const plan = await api(page, 'GET', '/api/me/plan');
  const mission = plan.json.groups.find((group) => group.items.some((item) => item.id === taskId));
  const second = await api(page, 'POST', '/api/me/tasks', { clientId: '5e0c2a4e-0000-4000-8000-0000000000a1', title: '灰度发布', missionId: mission.missionId });
  log('second-created', { status: second.status, step: second.json?.mission, waitingOn: second.json?.waitingOn });

  await page.goto(`${root}/me/mission-cards/${SUN_CARD}`);
  await settle(page, 1500);
  await page.getByRole('tab', { name: '本月计划' }).click();
  await settle(page, 1200);
  log('plan', { closed: await texts(page, '[aria-label="本月计划甘特图"] > p'), groups: await texts(page, '[aria-label="本月计划甘特图"] section[aria-label] strong'), shot: await shot(page, '05-plan-1440.png') });
  await shot(page, '05-plan-1440-full.png', true);
  const edit = page.locator(`section[aria-label="${mission.title}的步骤编辑"]`);
  await edit.locator('input:not([type="date"])').fill('回归测试');
  await edit.getByRole('button', { name: '加一步' }).click();
  const last = edit.locator('[class*="stepEdit"]').last();
  await last.locator('input[type="date"]').nth(0).fill('2026-10-12');
  await last.locator('input[type="date"]').nth(1).fill('2026-10-14');
  await page.getByRole('button', { name: '保存计划' }).click();
  await page.waitForTimeout(800);
  const dialogOpen = await page.getByRole('dialog').count();
  if (dialogOpen) await page.getByRole('dialog').getByRole('button', { name: '保存计划' }).click();
  await settle(page, 1500);
  log('plan-save', { dialogOpen, alerts: await texts(page, '[aria-label="本月计划甘特图"] [role="alert"]'), status: await texts(page, '[aria-label="本月计划甘特图"] [role="status"]'), shot: await shot(page, '05-plan-save-1440.png') });

  await page.goto(root + '/me');
  await settle(page, 1500);
  log('home-after', { cards: await texts(page, '[data-task]'), shot: await shot(page, '05-home-after-1440.png') });
  log('errors', { errors });
}

async function phone(browser) {
  const { page, errors } = await open(browser, 'browsermember', 390, 844);
  await page.goto(root + '/me');
  await settle(page, 1500);
  log('phone-home', { overflow: await overflow(page), shot: await shot(page, '05-phone-home-390.png') });
  const task = page.locator('[data-task]').first();
  await task.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  log('phone-home-tasks', { shot: await shot(page, '05-phone-tasks-390.png') });
  await page.goto(root + '/me/tasks/new');
  await settle(page, 1500);
  log('phone-create', { overflow: await overflow(page), shot: await shot(page, '05-phone-create-390.png') });
  await page.goto(`${root}/me/mission-cards/${SUN_CARD}`);
  await settle(page, 1500);
  await page.getByRole('tab', { name: '本月计划' }).click();
  await settle(page, 1200);
  log('phone-plan', { overflow: await overflow(page), shot: await shot(page, '05-phone-plan-390.png') });
  log('errors', { errors });
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    if (mode === 'flow') await flow(browser);
    else if (mode === 'phone') await phone(browser);
    else throw new Error('mode');
  } catch (error) {
    log('failed', { message: error.message.slice(0, 600) });
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(file(`claude-05-${mode}.json`), JSON.stringify(out, null, 2));
    await browser.close();
  }
})();
