// Claude 验收 02b：用 02 的一次性夹具（localhost:3500 / 4500），经正式接口做一次只读 GitHub Trending 的真实扫描，
// 再看列表、阅读页、首页小组件与编辑器建议行。自起无头 Chrome，每次全新临时配置，结束即关。
const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = 'http://localhost:3500';
const file = (name) => path.join(__dirname, name);
const control = (...args) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, '../02/radar-control.cjs'), ...args], { encoding: 'utf8' }));
const log = [];
const note = (step, value = {}) => { log.push({ step, ...value }); console.log(JSON.stringify({ step, ...value })); };

async function settle(page, ms = 600) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
}
async function shot(page, name) {
  await page.screenshot({ path: file(`claude-${name}.png`) });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  note(`shot ${name}`, { overflow });
  if (overflow) throw new Error(`Horizontal overflow on ${name}`);
}
async function both(page, name) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await settle(page, 300);
  await shot(page, `${name}-1440`);
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page, 400);
  await shot(page, `${name}-390`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await settle(page, 300);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(root + '/access');
    const started = await page.evaluate(async () => {
      const login = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginId: 'browsermember', passcode: '8742' }) });
      const put = await fetch('/api/me/radar', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, directions: ['AI Agent 的开发框架与工具'], sources: ['github.com/trending'] }) });
      const saved = await put.json();
      const scan = await fetch('/api/me/radar/scan', { method: 'POST' });
      return { login: login.status, put: put.status, sources: saved.sources, scan: scan.status };
    });
    note('real scan requested', started);
    const deadline = Date.now() + 150_000;
    let run;
    while (Date.now() < deadline) {
      const inspect = control('inspect').result;
      run = inspect.radar.find((row) => row.person_id === 'sun-mingze').last_run;
      if (run && (run.status === 'completed' || run.status === 'failed')) {
        note('real scan finished', { run, list: inspect.signals.filter((s) => s.source_type === 'list').map((s) => ({ relevance: s.relevance, title: s.source_title, summary: s.summary, reason: s.reason })), company: { signals: inspect.company.signals, issues: inspect.company.issues } });
        break;
      }
      await new Promise((done) => setTimeout(done, 3000));
    }

    await page.goto(root + '/me/radar');
    await settle(page, 1500);
    await both(page, 'trending-radar-list');
    const first = page.locator('[data-testid="expanded-panel"] [data-origin^="/me/radar/signals/"]').first();
    if (await first.count()) {
      await first.click();
      await page.waitForURL(/\/me\/radar\/signals\//);
      await settle(page, 1000);
      note('reader', { text: (await page.locator('[data-testid="signal-reader"]').innerText()).slice(0, 900) });
      await both(page, 'trending-reader');
    }
    await page.goto(root + '/me');
    await settle(page, 1200);
    note('widget', { text: (await page.locator('[data-widget="radar"]').innerText().catch(() => 'NO RADAR WIDGET')).slice(0, 600) });
    await shot(page, 'trending-home-widget-1440');
    await page.getByRole('button', { name: /打开个人菜单/ }).click();
    await page.getByRole('button', { name: '我的雷达' }).click();
    await settle(page, 900);
    note('editor', { text: (await page.locator('[role="dialog"]').last().innerText()).slice(0, 1100) });
    await both(page, 'trending-editor');
  } finally {
    fs.writeFileSync(file('claude-trending-verify.json'), JSON.stringify({ log, errors }, null, 2) + '\n');
    console.log(JSON.stringify({ errors }));
    await browser.close();
  }
})().catch((error) => { console.error(error.stack); process.exit(1); });
