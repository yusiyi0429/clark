// Claude 验收 02：自起无头 Chrome（每次全新临时配置，结束即关），只访问 localhost:3500 一次性夹具。
// 用法：node claude-radar-verify.cjs <scenario>
//   member-editor | member-radar | member-widget | new-onboarding | ceo
const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = 'http://localhost:3500';
const scenario = process.argv[2];
const file = (name) => path.join(__dirname, name);
const control = (...args) => JSON.parse(execFileSync(process.execPath, [file('radar-control.cjs'), ...args], { encoding: 'utf8' }));
const log = [];
const note = (step, value = {}) => { log.push({ step, ...value }); console.log(JSON.stringify({ step, ...value })); };

async function login(page, loginId) {
  await page.goto(root + '/access');
  const status = await page.evaluate(async (id) => (await fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginId: id, passcode: '8742' }),
  })).status, loginId);
  if (status !== 200) throw new Error(`Synthetic login failed: ${status}`);
}
async function settle(page, ms = 600) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
}
async function facts(page) {
  return page.evaluate(() => ({
    url: location.pathname + location.search,
    overflow: document.documentElement.scrollWidth > innerWidth,
    overlay: !!document.querySelector('[data-nextjs-dialog]'),
    widgets: [...document.querySelectorAll('[data-widget]')].map((el) => { const r = el.getBoundingClientRect(); return `${el.dataset.widget}:${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}`; }),
  }));
}
async function shot(page, name) {
  await page.screenshot({ path: file(`claude-${name}.png`) });
  const observed = await facts(page);
  note(`shot ${name}`, observed);
  if (observed.overflow) throw new Error(`Horizontal overflow on ${name}`);
  if (observed.overlay) throw new Error(`Error overlay on ${name}`);
}
async function both(page, name, full = false) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await settle(page, 300);
  await shot(page, `${name}-1440`);
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page, 400);
  if (full) await page.screenshot({ path: file(`claude-${name}-390-full.png`), fullPage: true });
  await shot(page, `${name}-390`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await settle(page, 300);
}
const dialogText = (page) => page.locator('[role="dialog"]').last().innerText();

async function memberEditor(page) {
  await login(page, 'browsermember');
  await page.goto(root + '/me');
  await settle(page);
  await both(page, 'member-home-off');
  await page.getByRole('button', { name: /打开个人菜单/ }).click();
  await page.getByRole('button', { name: '我的雷达' }).click();
  await settle(page);
  await both(page, 'member-editor-off');
  await page.getByRole('switch').click();
  await settle(page, 500);
  note('switch on', { checked: await page.getByRole('switch').getAttribute('aria-checked') });
  await both(page, 'member-editor-on');
  const direction = page.getByRole('textbox', { name: '写一条方向' });
  await direction.fill('AI Agent 产品的交互设计');
  await direction.press('Enter');
  await direction.fill('1 号位产品的设计');
  await direction.press('Enter');
  const source = page.getByRole('textbox', { name: '加一个来源网址' });
  await source.fill('HTTPS://WWW.FT.COM/world?x=1#y');
  await source.press('Enter');
  await page.getByRole('button', { name: /^加上来源：量子位/ }).click();
  await source.fill('36kr.com');
  await source.press('Enter');
  await source.fill('github.com/trending');
  await source.press('Enter');
  await settle(page, 300);
  note('before save', { text: (await dialogText(page)).slice(0, 900) });
  await both(page, 'member-editor-filled');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('设置已保存').first().waitFor({ timeout: 15_000 });
  await settle(page, 1200);
  note('after save', { text: (await dialogText(page)).slice(0, 1200) });
  await both(page, 'member-editor-saved');
  note('inspect', control('inspect').result.radar);
}

async function memberRadar(page) {
  await login(page, 'browsermember');
  await page.goto(root + '/me/radar');
  await settle(page, 1500);
  note('radar page', { text: (await page.locator('body').innerText()).slice(0, 1200) });
  await both(page, 'member-radar-list-real', true);
  const first = page.locator('[data-testid="expanded-panel"] [data-origin^="/me/radar/signals/"]').first();
  if (await first.count()) {
    await first.click();
    await page.waitForURL(/\/me\/radar\/signals\//);
    await settle(page, 1000);
    note('reader', { text: (await page.locator('body').innerText()).slice(0, 1400) });
    await both(page, 'member-reader-real', true);
    await page.getByRole('button', { name: '收藏信号' }).click();
    await settle(page, 600);
    await page.getByRole('button', { name: /不再出现在阅读列表/ }).click();
    await page.getByText('这条已从阅读列表隐藏').waitFor({ timeout: 10_000 });
    await settle(page, 400);
    await shot(page, 'member-reader-real-hidden-1440');
    await page.getByRole('button', { name: /恢复到阅读列表/ }).click();
    await settle(page, 600);
    await page.getByRole('button', { name: /标记为已读/ }).click();
    await settle(page, 600);
    note('reader states', control('inspect').result.signals.slice(0, 3).map((s) => ({ title: s.source_title, read: s.read, saved: s.saved, dismissed: s.dismissed })));
  } else note('no signals yet');
}

async function memberWidget(page) {
  await login(page, 'browsermember');
  await page.goto(root + '/me');
  await settle(page, 1200);
  note('home with radar', { text: (await page.locator('[data-widget="radar"]').innerText().catch(() => 'NO RADAR WIDGET')).slice(0, 800) });
  await both(page, 'member-home-radar');
  await page.setViewportSize({ width: 834, height: 1194 });
  await settle(page, 500);
  await shot(page, 'member-home-radar-834');
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const state of ['failed', 'queued', 'completed-empty']) {
    control('run-state', state);
    await page.reload();
    await settle(page, 1200);
    note(`widget ${state}`, { text: (await page.locator('[data-widget="radar"]').innerText().catch(() => 'NO RADAR WIDGET')).slice(0, 600) });
    await shot(page, `member-home-radar-${state}-1440`);
  }
}

async function newOnboarding(page) {
  await login(page, 'browsernew');
  await page.goto(root + '/me');
  await settle(page, 1500);
  note('landing', { url: page.url() });
  for (let guard = 0; guard < 6; guard += 1) {
    if (await page.getByRole('switch').count()) break;
    const next = page.getByRole('button', { name: /^(开始|下一步)$/ }).last();
    await next.click();
    await settle(page, 900);
  }
  note('step 3', { text: (await page.locator('body').innerText()).slice(0, 900) });
  await both(page, 'new-onboarding-radar-off');
  await page.getByRole('switch').click();
  await settle(page, 600);
  await page.getByRole('textbox', { name: '写一条方向' }).fill('AI 产品的首次引导设计');
  await page.getByRole('textbox', { name: '写一条方向' }).press('Enter');
  await settle(page, 300);
  await both(page, 'new-onboarding-radar-on');
  await page.getByRole('button', { name: '保存并继续' }).click();
  await settle(page, 1500);
  for (let guard = 0; guard < 4; guard += 1) {
    const text = await page.locator('body').innerText();
    if (text.includes('可以开始了')) break;
    const next = page.getByRole('button', { name: /^(下一步|录好后继续)$/ });
    if (await next.count()) { await next.last().click(); await settle(page, 900); } else break;
  }
  note('finish', { text: (await page.locator('body').innerText()).slice(0, 700) });
  await both(page, 'new-onboarding-finish');
}

async function ceo(page) {
  if (process.argv[3] !== 'radar-only') control('welcome', 'ceo');
  await login(page, 'browserceo');
  await page.goto(root + '/');
  await settle(page, 1500);
  if (process.argv[3] === 'radar-only') return ceoRadar(page);
  for (let guard = 0; guard < 6; guard += 1) {
    if ((await page.locator('body').innerText()).includes('公司雷达，还要看什么')) break;
    await page.getByRole('button', { name: /^(开始|下一步)$/ }).last().click();
    await settle(page, 900);
  }
  note('ceo step 3', { text: (await page.locator('body').innerText()).slice(0, 1200) });
  await both(page, 'ceo-onboarding-radar');
  const direction = page.getByRole('textbox', { name: '写一条方向' });
  if (!(await page.locator('body').innerText()).includes('AI 芯片出口管制')) {
    await direction.fill('AI 芯片出口管制');
    await direction.press('Enter');
  }
  const information = page.getByRole('button', { name: /^加上来源：The Information/ });
  if (await information.count()) await information.click();
  await settle(page, 300);
  await shot(page, 'ceo-onboarding-radar-filled-1440');
  await page.getByRole('button', { name: '保存并继续' }).click();
  await settle(page, 1500);
  for (let guard = 0; guard < 4; guard += 1) {
    if ((await page.locator('body').innerText()).includes('可以开始了')) break;
    const next = page.getByRole('button', { name: /^(下一步|录好后继续)$/ });
    if (await next.count()) { await next.last().click(); await settle(page, 900); } else break;
  }
  note('ceo finish', { text: (await page.locator('body').innerText()).slice(0, 600) });
  await shot(page, 'ceo-onboarding-finish-1440');
  await page.getByRole('button', { name: /^(进入工作台|继续刚才的页面)$/ }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/welcome'), { timeout: 15_000 });
  return ceoRadar(page);
}

async function ceoRadar(page) {
  await page.goto(root + '/radar');
  await settle(page, 1500);
  await page.getByRole('button', { name: '查看监测范围' }).click();
  await settle(page, 600);
  note('scope dialog', { text: (await dialogText(page)).slice(0, 1200) });
  await both(page, 'ceo-radar-scope');
  await page.getByRole('button', { name: /在雷达设置里修改/ }).click();
  await settle(page, 900);
  note('ceo editor', { text: (await dialogText(page)).slice(0, 1000) });
  await both(page, 'ceo-radar-editor');
  note('inspect company', control('inspect').result.company);
}

async function polish(page) {
  await login(page, 'browsermember');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(root + '/me');
  await settle(page, 1000);
  await page.getByRole('button', { name: /打开个人菜单/ }).click();
  await page.getByRole('button', { name: '我的雷达' }).click();
  await settle(page, 800);
  const box = await page.getByRole('textbox', { name: '写一条方向' }).boundingBox();
  note('direction field 390', { box });
  await shot(page, 'polish-direction-390');
  control('welcome', 'new');
  const other = await page.context().browser().newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const next = await other.newPage();
  await login(next, 'browsernew');
  await next.goto(root + '/me');
  await settle(next, 1500);
  for (let guard = 0; guard < 6; guard += 1) {
    if ((await next.locator('body').innerText()).includes('你想关注哪些变化')) break;
    await next.getByRole('button', { name: /^(开始|下一步)$/ }).last().click();
    await settle(next, 900);
  }
  const stage = await next.evaluate(() => {
    const scroller = [...document.querySelectorAll('*')].find((el) => { const style = getComputedStyle(el); return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 4 && el.querySelector('[role="switch"]'); });
    if (!scroller) return { scrollable: false };
    const before = { scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, mask: getComputedStyle(scroller).maskImage || getComputedStyle(scroller).webkitMaskImage };
    scroller.scrollTop = scroller.scrollHeight;
    return { scrollable: true, className: scroller.className, ...before };
  });
  note('onboarding stage', stage);
  await settle(next, 300);
  await next.screenshot({ path: file('claude-polish-onboarding-scrolled-1440.png') });
  await other.close();
}

(async () => {
  const run = { 'member-editor': memberEditor, 'member-radar': memberRadar, 'member-widget': memberWidget, 'new-onboarding': newOnboarding, ceo, polish }[scenario];
  if (!run) throw new Error('Usage: node claude-radar-verify.cjs member-editor|member-radar|member-widget|new-onboarding|ceo');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await run(page);
  } finally {
    fs.writeFileSync(file(`claude-${scenario}.json`), JSON.stringify({ scenario, log, errors }, null, 2) + '\n');
    console.log(JSON.stringify({ errors }));
    await browser.close();
  }
})().catch((error) => { console.error(error.stack); process.exit(1); });
