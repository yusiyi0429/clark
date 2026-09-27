// Claude 验收首次引导（成员与 CEO）：只访问 localhost:3500 时间机器。
// 用法：node claude-onboarding.cjs member|ceo  （先用 control.cjs welcome-member / welcome-ceo 重置）
const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const fs = require('node:fs');
const path = require('node:path');

const root = 'http://localhost:3500';
const readme = fs.readFileSync(path.join(__dirname, '../../manual-test/README.md'), 'utf8');
const passcode = /口令都是 `(\d{4})`/.exec(readme)[1];
const who = process.argv[2];
const loginId = who === 'ceo' ? 'browserceo' : 'browsermember';
const file = (name) => path.join(__dirname, name);
const out = [];
const log = (step, value = {}) => { out.push({ step, ...value }); console.log(JSON.stringify({ step, ...value })); };

async function context(browser, width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(120000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text().slice(0, 200)); });
  await page.goto(root + '/access');
  const status = await page.evaluate(async ({ loginId, passcode }) => (await fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginId, passcode }),
  })).status, { loginId, passcode });
  if (status !== 200) throw new Error(`login ${status}`);
  return { ctx, page, errors };
}
const measure = (page) => page.evaluate(() => {
  const stage = document.querySelector('[class*="stage"]');
  return {
    title: document.querySelector('h1')?.innerText.replace(/\s+/g, ' ') ?? null,
    pageScroll: document.documentElement.scrollHeight > innerHeight + 1,
    stageScroll: stage ? stage.scrollHeight > stage.clientHeight + 1 : null,
    overflowX: document.documentElement.scrollWidth > innerWidth,
  };
});

async function walk(browser, width, height, tag) {
  const { ctx, page, errors } = await context(browser, width, height);
  await page.goto(root + '/welcome');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);
  const steps = [];
  for (let i = 0; i < 8; i++) {
    const info = await measure(page);
    const name = `onb-${who}-${tag}-${i}.png`;
    await page.screenshot({ path: file(name) });
    steps.push({ i, ...info, shot: name });
    const next = page.getByRole('button', { name: /^(开始|下一步)/ }).first();
    if (!(await next.count()) || /雷达/.test(info.title ?? '')) break;
    await next.click();
    await page.waitForTimeout(i === 2 ? 1600 : 1100);
    if (i === 2 || i === 3) {
      // Mission 页动画播完再截一张；播到一半另截一张。
      const mid = `onb-${who}-${tag}-${i + 1}-mid.png`;
      await page.screenshot({ path: file(mid) });
    }
  }
  log(`walk-${tag}`, { steps, errors });
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    await walk(browser, 1440, 900, '1440');
    await walk(browser, 1280, 800, '1280');
    await walk(browser, 390, 844, '390');
  } catch (error) {
    log('failed', { message: error.message.slice(0, 500) });
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(file(`claude-onboarding-${who}.json`), JSON.stringify(out, null, 2));
    await browser.close();
  }
})();
