// Claude 验收工单 05（W3/W4 之后）：只访问 localhost:3500 时间机器。
// 用法：SUN_CARD=<孙铭泽的卡> node claude-05b.cjs
const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const fs = require('node:fs');
const path = require('node:path');

const root = 'http://localhost:3500';
const passcode = /口令都是 `(\d{4})`/.exec(fs.readFileSync(path.join(__dirname, '../../manual-test/README.md'), 'utf8'))[1];
const SUN_CARD = process.env.SUN_CARD;
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
  if (status !== 200) throw new Error(`login ${loginId} ${status}`);
  return { context, page, errors };
}
async function settle(page, ms = 900) {
  await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(ms);
  // 重置过引导的身份先跳过引导（按下即记为看过）。
  if (new URL(page.url()).pathname === '/welcome') {
    await page.getByRole('button', { name: '先进入工作台' }).click();
    await page.waitForURL((url) => url.pathname !== '/welcome', { timeout: 60000 });
    await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(ms);
  }
}
const texts = (page, selector) => page.locator(selector).allInnerTexts().then((all) => all.map((v) => v.replace(/\s+/g, ' ').trim()));
async function shot(page, name) { await page.screenshot({ path: file(name) }); return name; }
async function api(page, method, url, body) {
  return page.evaluate(async ({ method, url, body }) => {
    const response = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await response.json(); } catch { /* 204 */ }
    return { status: response.status, json };
  }, { method, url, body });
}
/** 在某一行的轨道上从 fromDay 拖到 toDay。 */
async function drawBar(page, rowTitle, fromDay, toDay, days = 31) {
  const track = page.locator(`[role="group"][aria-label^="${rowTitle}"]`).first();
  await track.scrollIntoViewIfNeeded();
  const box = await track.boundingBox();
  const x = (day) => box.x + (day - 0.5) / days * box.width;
  const y = box.y + box.height / 2;
  await page.mouse.move(x(fromDay), y); await page.mouse.down();
  await page.mouse.move(x((fromDay + toDay) / 2), y, { steps: 4 });
  await page.mouse.move(x(toDay), y, { steps: 4 }); await page.mouse.up();
  await page.waitForTimeout(300);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const { page, errors } = await open(browser, 'browsermember');
    await page.goto(root + '/me'); await settle(page, 1500);
    await page.getByRole('button', { name: '开启执行事项' }).first().click();
    await page.getByRole('heading', { name: '开启执行事项' }).first().waitFor({ timeout: 30000 });
    await settle(page, 900);
    log('create', { shot: await shot(page, '05b-create-1440.png') });
    const plan = await api(page, 'GET', '/api/me/plan');
    const mission = plan.json.groups[0];
    const created = await api(page, 'POST', '/api/me/tasks', { clientId: '5e0c2a4e-0000-4000-8000-0000000000b1', title: '整理上线清单', missionId: mission.missionId, startDate: '2026-10-05', dueDate: '2026-10-09', doneDefinition: '一页上线清单，列明负责人和回滚方案' });
    const second = await api(page, 'POST', '/api/me/tasks', { clientId: '5e0c2a4e-0000-4000-8000-0000000000b2', title: '灰度发布', missionId: mission.missionId });
    log('created', { first: created.status, second: second.status, secondWaiting: second.json?.waitingOn?.title });
    const taskId = created.json.id;

    await page.goto(`${root}/me/tasks/${taskId}`); await settle(page, 1500);
    const judgment = page.getByLabel('写下这件事的判断');
    await judgment.fill('先把回滚方案写清楚，再定灰度范围。');
    await page.getByRole('button', { name: '保存' }).first().click();
    await settle(page, 1200);
    log('detail', { channels: await texts(page, '[data-channel], [role="tablist"] button, [aria-label*="频道"] button'), shot: await shot(page, '05b-detail-1440.png') });
    await page.getByRole('button', { name: '邀请协作' }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('dialog').getByLabel('林知行').check();
    await page.getByRole('button', { name: '加入协作与群聊' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' }).catch(() => {});
    await settle(page, 1200);
    const groupSwitch = page.getByRole('button', { name: /事项群组/ }).first();
    const hasGroup = await groupSwitch.count();
    if (hasGroup) { await groupSwitch.click(); await settle(page, 1500); }
    log('group-channel', { hasGroup, rightColumn: (await page.locator('body').innerText()).match(/成员可见[^\n]*/)?.[0] ?? null, shot: await shot(page, '05b-group-1440.png') });

    await page.goto(`${root}/me/mission-cards/${SUN_CARD}`); await settle(page, 1500);
    await page.getByRole('tab', { name: '本月计划' }).click(); await settle(page, 1200);
    const gantt = page.locator('[aria-label="本月计划甘特图"] [role="region"]');
    await gantt.scrollIntoViewIfNeeded();
    log('plan', { shot: await shot(page, '05b-plan-1440.png') });
    await page.getByRole('button', { name: '＋ 加一步' }).first().click();
    const input = page.getByPlaceholder('步骤标题').first();
    await input.fill('回归测试'); await input.press('Enter');
    await page.waitForTimeout(400);
    await drawBar(page, '回归测试', 12, 14);
    log('plan-drawn', { save: await texts(page, 'button:has-text("保存计划")'), shot: await shot(page, '05b-plan-drawn-1440.png') });
    await page.getByRole('button', { name: /保存计划/ }).click();
    await settle(page, 1500);
    log('plan-saved', { dialog: await page.getByRole('dialog').count(), alerts: await texts(page, '[aria-label="本月计划甘特图"] [role="alert"]'), status: await texts(page, '[aria-label="本月计划甘特图"] [role="status"]'), shot: await shot(page, '05b-plan-saved-1440.png') });

    await page.getByRole('button', { name: '第 2 步 · 灰度发布' }).click();
    await page.waitForTimeout(400);
    const strip = page.locator('[class*="inlineEdit"]').first();
    await strip.getByLabel('开始').fill('2026-10-15');
    await strip.getByLabel('截止').fill('2026-10-17');
    log('plan-edit-strip', { shot: await shot(page, '05b-plan-strip-1440.png') });
    await page.getByRole('button', { name: /保存计划/ }).click();
    await settle(page, 1500);
    const after = await api(page, 'GET', '/api/me/plan');
    log('plan-after', { steps: after.json.groups[0].items.map((item) => `${item.mission?.step}/${item.mission?.steps} ${item.title} ${item.startDate}~${item.dueDate}`), shot: await shot(page, '05b-plan-after-1440.png') });

    await page.goto(root + '/me'); await settle(page, 1500);
    log('home', { cards: await texts(page, '[data-task]'), shot: await shot(page, '05b-home-1440.png') });
    log('errors-member', { errors });

    const dri = await open(browser, 'browserdri');
    await dri.page.goto(root + '/me'); await settle(dri.page, 1500);
    log('collaborator-home', { notices: (await dri.page.locator('aside').first().innerText()).slice(0, 400), shot: await shot(dri.page, '05b-collab-home-1440.png') });
    await dri.page.goto(`${root}/me/tasks/${taskId}`); await settle(dri.page, 1500);
    await dri.page.getByLabel(/我的批注/).fill('我这边周三能给回滚脚本。');
    await dri.page.getByRole('button', { name: '保存' }).first().click();
    await settle(dri.page, 1000);
    log('collaborator-detail', { shot: await shot(dri.page, '05b-collab-detail-1440.png'), errors: dri.errors });

    const ceo = await open(browser, 'browserceo');
    const ceoView = await api(ceo.page, 'GET', `/api/me/tasks/${taskId}`);
    log('ceo-not-member', { status: ceoView.status });

    const phone = await open(browser, 'browsermember', 390, 844);
    await phone.page.goto(`${root}/me/tasks/${taskId}`); await settle(phone.page, 1500);
    log('phone-detail', { overflow: await phone.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), shot: await shot(phone.page, '05b-phone-detail-390.png') });
    await phone.page.goto(`${root}/me/mission-cards/${SUN_CARD}`); await settle(phone.page, 1500);
    await phone.page.getByRole('tab', { name: '本月计划' }).click(); await settle(phone.page, 1200);
    await phone.page.locator('[aria-label="本月计划甘特图"]').scrollIntoViewIfNeeded();
    log('phone-plan', { overflow: await phone.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), shot: await shot(phone.page, '05b-phone-plan-390.png') });
  } catch (error) {
    log('failed', { message: error.message.slice(0, 700) });
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(file('claude-05b.json'), JSON.stringify(out, null, 2));
    await browser.close();
  }
})();
