// Claude 验收 03：自起无头 Chrome（每次全新临时配置，结束即关），只访问 localhost:3500 一次性夹具。
// 用法：
//   node claude-verify.cjs shots <member|dri|nocard|empty> <label> [/me,/me/battlefields/growth]
//   node claude-verify.cjs interact <member|dri> <label>
//   node claude-verify.cjs radar <member|dri> <label>
const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const fs = require('node:fs');
const path = require('node:path');

const root = 'http://localhost:3500';
const people = { member: 'browsermember', dri: 'browserdri', nocard: 'browsernocard', empty: 'browserempty' };
const widths = [[1440, 900], [1280, 800], [834, 1194], [390, 844]];
const [mode, who, label, routeArg = '/me'] = process.argv.slice(2);
if (!['shots', 'interact', 'radar'].includes(mode) || !people[who] || !/^[a-z0-9-]+$/.test(label || '')) {
  console.error('Usage: node claude-verify.cjs shots|interact|radar member|dri|nocard|empty <label> [routes]');
  process.exit(2);
}
const file = (name) => path.join(__dirname, name);

async function login(page) {
  await page.goto(root + '/access');
  const status = await page.evaluate(async (loginId) => (await fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginId, passcode: '8742' }),
  })).status, people[who]);
  if (status !== 200) throw new Error(`Synthetic login failed: ${status}`);
}

async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

function measure(page) {
  return page.evaluate(() => {
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height), bottom: Math.round(r.bottom) }; };
    const tasks = document.querySelector('[aria-label="执行事项"]');
    const widgets = [...document.querySelectorAll('[data-widget]')].map((el) => ({ kind: el.dataset.widget, text: el.innerText.replace(/\s+/g, ' ').slice(0, 160), ...rect(el) }));
    return {
      url: location.pathname, width: innerWidth, height: innerHeight,
      overflow: document.documentElement.scrollWidth > innerWidth,
      overlay: !!document.querySelector('[data-nextjs-dialog]'),
      tasksTop: rect(tasks)?.top ?? null,
      tasksInFirstScreen: !!tasks && rect(tasks).top < innerHeight,
      widgets,
      active: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName,
      main: (document.querySelector('[data-member-battlefield]') ?? document.querySelector('main') ?? document.body).innerText.replace(/\s+/g, ' ').slice(0, 1400),
    };
  });
}

async function shots(page, routes) {
  const results = [];
  for (const route of routes) {
    const tag = route === '/me' ? 'home' : route.split('/').filter(Boolean).slice(1).join('-');
    await page.goto(root + route);
    for (const [width, height] of widths) {
      await page.setViewportSize({ width, height });
      await settle(page);
      const name = `claude-${label}-${tag}-${width}.png`;
      await page.screenshot({ path: file(name) });
      results.push({ screenshot: name, ...(await measure(page)) });
    }
  }
  return results;
}

async function interact(page) {
  const steps = [];
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(root + '/me');
  await settle(page);
  const expand = page.getByRole('button', { name: '展开全文' }).first();
  if (await expand.count()) {
    await expand.click();
    await page.waitForTimeout(300);
    steps.push({ step: 'expand', expanded: await page.getByRole('button', { name: '收起' }).first().getAttribute('aria-expanded'),
      clamp: await page.evaluate(() => getComputedStyle(document.querySelector('[data-expanded="true"]')).webkitLineClamp) });
    await page.screenshot({ path: file(`claude-${label}-expanded-1440.png`) });
    await page.getByRole('button', { name: '收起' }).first().click();
  }
  const battlefield = page.getByRole('button', { name: /^查看战场：/ }).first();
  const battlefieldName = await battlefield.getAttribute('aria-label');
  await battlefield.click();
  await page.waitForURL(/\/me\/battlefields\//);
  await settle(page);
  await page.screenshot({ path: file(`claude-${label}-detail-open-1440.png`) });
  steps.push({ step: 'open-battlefield', url: new URL(page.url()).pathname, detail: (await measure(page)).main.slice(0, 600) });
  await page.getByRole('button', { name: /返回|关闭/ }).first().click();
  await page.waitForURL(root + '/me');
  await page.waitForTimeout(700);
  steps.push({ step: 'back-from-battlefield', url: new URL(page.url()).pathname, focus: await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), expected: battlefieldName });
  const personal = page.getByRole('button', { name: /^打开我的本月卡：/ }).first();
  if (await personal.count()) {
    const personalName = await personal.getAttribute('aria-label');
    await personal.click();
    await page.waitForURL(/\/me\/mission-cards\//);
    await settle(page);
    await page.screenshot({ path: file(`claude-${label}-card-open-1440.png`) });
    await page.getByRole('button', { name: /返回|关闭/ }).first().click();
    await page.waitForURL(root + '/me');
    await page.waitForTimeout(700);
    steps.push({ step: 'back-from-card', focus: await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), expected: personalName });
  }
  const forbidden = await page.evaluate(async () => (await fetch('/api/me/battlefields/private-field')).status);
  await page.goto(root + '/me/battlefields/private-field');
  await settle(page);
  steps.push({ step: '404', api: forbidden, page: await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 120)) });
  return steps;
}

async function radar(page) {
  const results = [];
  await page.goto(root + '/me');
  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await settle(page);
    // 只在页面内临时插入与「我的本月卡」同形的小组件，检查 02 接入后的排布；不改源码。
    await page.evaluate(() => {
      document.querySelector('[data-widget="radar"]')?.remove();
      const source = document.querySelector('[data-widget="mission-cards"]');
      const clone = source.cloneNode(false);
      clone.dataset.widget = 'radar';
      clone.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;min-height:32px"><h2 style="margin:0;font-size:20px;font-weight:600">雷达</h2><span style="color:var(--ink-faint);font-size:13px">今天 3 条</span></div><p style="margin:0;color:var(--ink-muted);font-size:14px;line-height:1.7">GitHub Trending · 1 号位产品的设计</p>';
      source.after(clone);
    });
    await page.waitForTimeout(200);
    const name = `claude-${label}-radar-${width}.png`;
    await page.screenshot({ path: file(name) });
    results.push({ screenshot: name, ...(await measure(page)) });
  }
  return results;
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await login(page);
    const result = mode === 'shots' ? await shots(page, routeArg.split(',')) : mode === 'interact' ? await interact(page) : await radar(page);
    fs.writeFileSync(file(`claude-${label}.json`), JSON.stringify({ mode, who, result, errors }, null, 2) + '\n');
    console.log(JSON.stringify({ mode, who, label, errors, result: result.map((item) => ({ ...item, main: item.main?.slice(0, 300) })) }, null, 1));
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error.stack); process.exit(1); });
