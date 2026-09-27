// Claude 验收 GAP-04 与同批小修：自起无头 Chrome（每个身份一个全新上下文），只访问 localhost:3500 一次性夹具。
// 用法：node claude-gap04.cjs flow|phone|closed|welcome|notfound
const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const fs = require('node:fs');
const path = require('node:path');

const root = 'http://localhost:3500';
const people = { member: 'browsermember', dri: 'browserdri', ceo: 'browserceo' };
const SUN_CARD = '3ec3d6f3-b510-4393-a846-c7a4638e836e';
const M1 = 'section[aria-label^="个人任务：CEO Agent 核心体验"]';
const M2 = 'section[aria-label^="个人任务：DRI Agent V1"]';
const mode = process.argv[2];
const file = (name) => path.join(__dirname, name);
const out = [];
const log = (step, value = {}) => { out.push({ step, ...value }); console.log(JSON.stringify({ step, ...value })); };

async function open(browser, who, width = 1440, height = 900) {
  const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text().slice(0, 200)); });
  if (who) {
    await page.goto(root + '/access');
    const status = await page.evaluate(async (loginId) => (await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginId, passcode: '8742' }),
    })).status, people[who]);
    if (status !== 200) throw new Error(`Synthetic login failed: ${status}`);
  }
  return { context, page, errors };
}
async function settle(page, ms = 600) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
const text = (page, selector) => page.locator(selector).first().innerText().then((value) => value.replace(/\s+/g, ' ').trim()).catch(() => null);
async function shot(page, name) { await page.screenshot({ path: file(name) }); return name; }
async function waitText(page, value, timeout = 20000) { await page.getByText(value, { exact: false }).first().waitFor({ timeout }); }

async function requestCorrection(page, scope, field, proposed, reason) {
  const section = page.locator(scope);
  await section.getByRole('button', { name: `申请更正：${field}`, exact: true }).click();
  const editor = section.getByRole('textbox', { name: `申请更正：${field}`, exact: true });
  await editor.fill(proposed);
  await section.getByRole('textbox', { name: '原因', exact: true }).fill(reason);
  await section.getByRole('button', { name: `提交申请更正：${field}`, exact: true }).click();
}

async function flow(browser) {
  // 1. Owner（孙铭泽）：只有「申请更正」入口；提交两条申请，一条原文不变的被拒并保留输入。
  const member = await open(browser, 'member');
  let page = member.page;
  await page.goto(`${root}/me/mission-cards/${SUN_CARD}`);
  await settle(page, 1200);
  log('member-card', {
    status: await text(page, '[aria-label="本轮"] p'),
    requestButtons: await page.getByRole('button', { name: /^申请更正：/ }).count(),
    directButtons: await page.getByRole('button', { name: /^更正：/ }).count(),
    shot: await shot(page, 'claude-gap04-member-card-1440.png'),
  });
  await requestCorrection(page, M1, '预期结果', '10 月底前在 CEO 的一次真实经营判断里完整用上天枢，形成可复用的验收记录。', '客户把验收会挪到 10 月 28 日');
  await waitText(page, '更正申请已提交');
  await requestCorrection(page, M1, 'Why / 背景', '让 CEO 在真实上下文中完成一次正式经营判断，验证天枢的核心价值。', '背景写得太泛，补上验证对象');
  await waitText(page, '更正申请已提交');
  await page.waitForTimeout(800);
  log('member-requested', {
    waiting: await page.getByText('更正申请 · 等林知行处理').count(),
    shot: await shot(page, 'claude-gap04-member-requested-1440.png'),
  });
  // 原文不变：服务端 400，输入保留。
  const m2 = page.locator(M2);
  await m2.getByRole('button', { name: '申请更正：边界', exact: true }).click();
  const unchanged = await m2.getByRole('textbox', { name: '申请更正：边界', exact: true }).inputValue();
  await m2.getByRole('textbox', { name: '原因', exact: true }).fill('只是想试试');
  await m2.getByRole('button', { name: '提交申请更正：边界', exact: true }).click();
  await m2.getByRole('alert').first().waitFor({ timeout: 15000 });
  log('member-unchanged-refused', {
    alert: await m2.getByRole('alert').first().innerText(),
    textKept: (await m2.getByRole('textbox', { name: '申请更正：边界', exact: true }).inputValue()) === unchanged,
    reasonKept: await m2.getByRole('textbox', { name: '原因', exact: true }).inputValue(),
  });
  await m2.getByRole('button', { name: '取消申请更正：边界', exact: true }).click();
  // 390：编辑框占满、不横向溢出。
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  await m2.getByRole('button', { name: '申请更正：成功证据', exact: true }).click();
  const box = await m2.getByRole('textbox', { name: '申请更正：成功证据', exact: true }).boundingBox();
  await m2.getByRole('textbox', { name: '申请更正：成功证据', exact: true }).scrollIntoViewIfNeeded();
  log('member-editor-390', { textarea: box && { left: Math.round(box.x), width: Math.round(box.width) }, overflow: await overflow(page), shot: await shot(page, 'claude-gap04-member-editor-390.png') });
  await m2.getByRole('button', { name: '取消申请更正：成功证据', exact: true }).click();
  log('member-errors', { errors: member.errors });
  await member.context.close();

  // 2. 拍板人（林知行，战场 DRI）：通知里的待办直达第一条；采纳一条、直接更正一处，另一条原文已变化只能不采纳。
  const dri = await open(browser, 'dri');
  page = dri.page;
  await page.goto(`${root}/me`);
  await settle(page, 1500);
  const todo = page.getByRole('button', { name: '2 条更正申请待你处理', exact: true }).first();
  log('dri-home', { todo: await todo.count(), shot: await shot(page, 'claude-gap04-dri-home-1440.png') });
  await todo.click();
  await page.waitForURL(/\?correction=/, { timeout: 20000 });
  await settle(page, 1500);
  log('dri-deeplink', {
    url: new URL(page.url()).pathname + new URL(page.url()).search,
    active: await page.evaluate(() => document.activeElement?.closest('[id^="correction-"]')?.id ?? document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName),
    status: await text(page, '[aria-label="本轮"] p'),
    shot: await shot(page, 'claude-gap04-dri-deeplink-1440.png'),
  });
  const s1 = page.locator(M1);
  await s1.getByRole('button', { name: '采纳：预期结果', exact: true }).click();
  await s1.getByRole('button', { name: /^已更正：预期结果/ }).waitFor({ timeout: 20000 });
  await settle(page);
  log('dri-applied', { status: await text(page, '[aria-label="本轮"] p'), version: await text(page, `${M1} p`) });
  // 直接更正同一任务的 Why：之后孙铭泽对 Why 的申请原文已变化。
  await s1.getByRole('button', { name: '更正：Why / 背景', exact: true }).click();
  await s1.getByRole('textbox', { name: '更正：Why / 背景', exact: true }).fill('验证 CEO 在真实上下文中能用天枢完成一次正式经营判断，并留下可复用的记录。');
  await s1.getByRole('textbox', { name: '原因', exact: true }).fill('拍板人补充：写明要留下的记录');
  await s1.getByRole('button', { name: '提交更正：Why / 背景', exact: true }).click();
  await waitText(page, '已更正，改前改后都已留痕');
  await settle(page);
  const applyWhy = s1.getByRole('button', { name: '采纳：Why / 背景', exact: true });
  log('dri-stale', { staleText: await s1.getByText('原文已变化').count(), applyDisabled: await applyWhy.isDisabled(), shot: await shot(page, 'claude-gap04-dri-stale-1440.png') });
  await s1.getByRole('button', { name: '不采纳：Why / 背景', exact: true }).click();
  await s1.getByRole('textbox', { name: '不采纳的原因' }).fill('已按最新情况直接更正，这条不再需要');
  await s1.getByRole('button', { name: '确认不采纳：Why / 背景', exact: true }).click();
  await s1.getByText('未采纳 · 已按最新情况直接更正').waitFor({ timeout: 20000 });
  await s1.getByRole('button', { name: /^已更正：预期结果/ }).click();
  await settle(page, 400);
  log('dri-history', {
    history: await text(page, `${M1} ol[aria-label="预期结果的更正记录"]`),
    status: await text(page, '[aria-label="本轮"] p'),
    cardStatus: await text(page, '[class*="versionMain"]'),
    todoLeft: await page.getByRole('button', { name: /条更正申请待你处理/ }).count(),
    shot: await shot(page, 'claude-gap04-dri-history-1440.png'),
  });
  log('dri-errors', { errors: dri.errors });
  await dri.context.close();

  // 3. Owner 再申请一条，CEO 通知栏也出现待办。
  const again = await open(browser, 'member');
  await again.page.goto(`${root}/me/mission-cards/${SUN_CARD}`);
  await settle(again.page, 1200);
  await requestCorrection(again.page, M2, '边界', '只做 DRI 首页与个人卡，不做 CEO 侧的新入口。', '范围收窄，避免月底赶工');
  await waitText(again.page, '更正申请已提交');
  await again.context.close();
  const ceo = await open(browser, 'ceo');
  await ceo.page.goto(`${root}/`);
  await settle(ceo.page, 2000);
  log('ceo-home', { todo: await ceo.page.getByRole('button', { name: '1 条更正申请待你处理', exact: true }).count(), shot: await shot(ceo.page, 'claude-gap04-ceo-home-1440.png'), errors: ceo.errors });
  await ceo.context.close();
}

async function phone(browser) {
  for (const who of ['dri', 'member']) {
    const { context, page, errors } = await open(browser, who, 390, 844);
    await page.goto(`${root}/me`);
    await settle(page, 1500);
    const order = await page.evaluate(() => {
      const top = (el) => el ? Math.round(el.getBoundingClientRect().top + scrollY + (document.querySelector('[data-testid="member-workspace"]')?.scrollTop ?? 0)) : null;
      const visibleMenu = [...document.querySelectorAll('[data-account-menu]')].find((el) => el.getClientRects().length);
      const heading = document.querySelector('[data-testid="member-workspace"] h1');
      return {
        notices: top(document.querySelector('[data-notice-group="mission-card"], [data-notice], [class*="quiet"]')),
        tasks: top(document.querySelector('[aria-label="执行事项"]')),
        myCards: top(document.querySelector('[data-widget="mission-cards"]')),
        battlefield: top(document.querySelector('[data-widget="battlefield"]')),
        radar: top(document.querySelector('[data-widget="radar"]')),
        account: top(visibleMenu),
        menus: document.querySelectorAll('[data-account-menu]').length,
        headingBox: heading ? { w: Math.round(heading.getBoundingClientRect().width), h: Math.round(heading.getBoundingClientRect().height) } : null,
      };
    });
    log(`phone-${who}`, { order, overflow: await overflow(page), shot: await shot(page, `claude-gap04-phone-${who}-390.png`), errors });
    await page.evaluate(() => { const shell = document.querySelector('[data-testid="member-workspace"]'); shell?.scrollTo(0, shell.scrollHeight); window.scrollTo(0, document.body.scrollHeight); });
    await page.waitForTimeout(500);
    await shot(page, `claude-gap04-phone-${who}-390-bottom.png`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await settle(page);
    log(`desktop-${who}`, { overflow: await overflow(page), shot: await shot(page, `claude-gap04-desktop-${who}-1440.png`) });
    await context.close();
  }
}

async function closed(browser) {
  const member = await open(browser, 'member');
  await member.page.goto(`${root}/me/mission-cards/${SUN_CARD}`);
  await settle(member.page, 1200);
  if (member.page.url().includes('/welcome')) {
    // 前一步重置过引导：先按「先进入工作台」完成，再回到这张卡。
    await member.page.getByRole('button', { name: '先进入工作台', exact: true }).click();
    await member.page.waitForURL((url) => !url.pathname.startsWith('/welcome'), { timeout: 20000 });
    await member.page.goto(`${root}/me/mission-cards/${SUN_CARD}`);
    await settle(member.page, 1500);
  }
  log('closed-member', {
    readonly: await member.page.getByText('月份已过，这张卡只读').count(),
    requestButtons: await member.page.getByRole('button', { name: /^申请更正：/ }).count(),
    unhandled: await member.page.getByText('未处理 · 月份已过').count(),
    status: await text(member.page, '[aria-label="本轮"] p'),
    shot: await shot(member.page, 'claude-gap04-closed-member-1440.png'),
    errors: member.errors,
  });
  await member.context.close();
  const dri = await open(browser, 'dri', 390, 844);
  await dri.page.goto(`${root}/me`);
  await settle(dri.page, 1500);
  log('closed-dri-home', { todo: await dri.page.getByRole('button', { name: /条更正申请待你处理/ }).count(), shot: await shot(dri.page, 'claude-gap04-closed-dri-390.png'), errors: dri.errors });
  await dri.page.goto(`${root}/me/mission-cards/${SUN_CARD}`);
  await settle(dri.page, 1200);
  log('closed-dri-card', {
    directButtons: await dri.page.getByRole('button', { name: /^更正：/ }).count(),
    applyButtons: await dri.page.getByRole('button', { name: /^采纳：/ }).count(),
    status: await text(dri.page, '[aria-label="本轮"] p'),
  });
  await dri.context.close();
}

async function welcome(browser) {
  const { context, page, errors } = await open(browser, 'member', 1280, 640);
  await page.goto(`${root}/welcome`);
  await settle(page, 1500);
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await page.waitForTimeout(900);
  const stage = await page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find((node) => getComputedStyle(node).overflowY === 'auto' && node.querySelector('[data-step]'));
    if (!el) return null;
    el.setAttribute('data-claude-stage', '');
    const style = getComputedStyle(el);
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, mask: style.maskImage || style.webkitMaskImage, paddingTop: style.paddingTop, marginTop: style.marginTop, marginBottom: style.marginBottom };
  });
  const heading = await page.locator('h1').first().boundingBox();
  const primary = await page.getByRole('button', { name: '下一步', exact: true }).boundingBox().catch(() => null);
  log('welcome-top', { stage, heading: heading && Math.round(heading.y), primary: primary && Math.round(primary.y), shot: await shot(page, 'claude-gap04-welcome-top-1280x640.png') });
  await page.evaluate(() => document.querySelector('[data-claude-stage]')?.scrollBy(0, 160));
  await page.waitForTimeout(400);
  log('welcome-scrolled', { shot: await shot(page, 'claude-gap04-welcome-scrolled-1280x640.png') });
  await page.evaluate(() => { const el = document.querySelector('[data-claude-stage]'); el?.scrollTo(0, el.scrollHeight); });
  await page.waitForTimeout(400);
  log('welcome-bottom', { shot: await shot(page, 'claude-gap04-welcome-bottom-1280x640.png'), errors });
  await context.close();
}

async function notfound(browser) {
  const { context, page, errors } = await open(browser, 'member');
  const response = await page.goto(`${root}/me/definitely-not-here`);
  await settle(page, 800);
  log('notfound-1440', { status: response?.status(), title: await text(page, 'h1'), body: await text(page, 'main'), warmap: (await page.content()).includes('WarMap'), shot: await shot(page, 'claude-gap04-notfound-1440.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  log('notfound-390', { overflow: await overflow(page), shot: await shot(page, 'claude-gap04-notfound-390.png'), errors });
  await context.close();
}

(async () => {
  const modes = { flow, phone, closed, welcome, notfound };
  if (!modes[mode]) { console.error('Usage: node claude-gap04.cjs flow|phone|closed|welcome|notfound'); process.exit(2); }
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try { await modes[mode](browser); }
  catch (error) { log('failed', { reason: error.message.split('\n')[0] }); process.exitCode = 1; }
  finally {
    await browser.close();
    fs.writeFileSync(file(`claude-gap04-${mode}.json`), JSON.stringify(out, null, 2));
  }
})();
