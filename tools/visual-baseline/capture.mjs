/**
 * Ticket 01 · 冻结旧 CEO WarMap 视觉与交互证据。
 *
 * 运行前提：
 *   1. 旧 frontend 已按 docs/visual-baseline/README.md 的方式启动（生产构建，默认 127.0.0.1:4318）；
 *   2. 本机安装 Google Chrome（通过 channel: 'chrome' 复用，不下载浏览器）；
 *   3. 环境变量 BASELINE_URL / BASELINE_PASSWORD / BASELINE_SECRET 可覆盖默认值。
 *
 * 产物（全部写入 docs/visual-baseline/）：
 *   screenshots/<状态>.<视口>.png —— 1440×900 与 1600×1000 两套稳定截图；
 *   evidence/interactions.json    —— 动画终态、焦点、Escape、reduced-motion 的可断言结果；
 *   evidence/design-tokens.json   —— 字体、颜色、阴影、间距、Card 几何的计算值；
 *   evidence/health.json          —— 旧入口与健康状态记录。
 *
 * 该脚本只读取旧 Web 的公开页面行为，通过路由 mock 提供确定性数据，不修改旧前端。
 */
import { chromium } from 'playwright-core';
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildRadarFixture, applyRadarAction, progressFixture, chatFixture } from './fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVIDENCE = path.join(ROOT, 'docs', 'visual-baseline');
const SHOTS = path.join(EVIDENCE, 'screenshots');
const EVID = path.join(EVIDENCE, 'evidence');
const BASE = process.env.BASELINE_URL ?? 'http://127.0.0.1:4318';
const ACCESS_PASSWORD = process.env.BASELINE_PASSWORD ?? 'warmap-baseline';
const ACCESS_SECRET = process.env.BASELINE_SECRET ?? 'warmap-baseline-secret';
const FIXED_TIME = new Date('2026-09-15T09:41:00+08:00');
const VIEWPORTS = [1440, 1600]; // 高度：1440→900，1600→1000
const HEIGHTS = { 1440: 900, 1600: 1000 };

mkdirSync(SHOTS, { recursive: true });
mkdirSync(EVID, { recursive: true });

const accessCookie = createHmac('sha256', ACCESS_SECRET)
  .update(`tkos-demo-access-v1:${ACCESS_PASSWORD}`)
  .digest('base64url');

/** 证据收集：{ id, pass, detail }，失败集中汇报并以非零码退出。 */
const checks = [];
function record(id, pass, detail = '') {
  checks.push({ id, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}${detail ? ` — ${detail}` : ''}`);
}

/** mock 全部截图涉及的 API，数据全部来自 fixture。 */
async function mockApis(page) {
  let radar = buildRadarFixture();
  await page.route('**/api/warmap-radar', async route => {
    if (route.request().method() === 'POST') applyRadarAction(radar, route.request().postDataJSON());
    await route.fulfill({ json: radar });
  });
  await page.route('**/api/warmap-progress', async route => {
    const body = route.request().postDataJSON();
    await route.fulfill({ json: progressFixture(body?.zone ?? 'lighthouse') });
  });
  await page.route('**/api/warmap-chat', async route => {
    await new Promise(resolve => setTimeout(resolve, 900)); // 让 thinking 状态可被截到。
    await route.fulfill({ json: chatFixture });
  });
}

/**
 * 固定 Date（分钟级时间显示因此恒为 09:41），定时器照常运行。
 * 单页内所有时间显示因此逐字节确定，且不影响动画、rAF 与交互时序。
 */
async function newPage(browser, { width, cookie = true, motion = 'normal' } = {}) {
  const context = await browser.newContext({
    viewport: { width, height: HEIGHTS[width] },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    reducedMotion: motion === 'reduce' ? 'reduce' : 'no-preference',
  });
  if (cookie) {
    await context.addCookies([{ name: 'tkos_demo_access', value: accessCookie, domain: '127.0.0.1', path: '/' }]);
  }
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.clock.setFixedTime(FIXED_TIME);
  await mockApis(page);
  page.pageErrors = [];
  page.on('pageerror', error => page.pageErrors.push(String(error)));
  return { context, page };
}

/** 等全部有限动画播完；无限动画统一暂停在 1500ms，保证截图逐帧确定。 */
async function settle(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const all = document.getAnimations();
    for (const animation of all) {
      const timing = animation.effect?.getTiming?.();
      if (timing?.iterations === Infinity) {
        try { animation.pause(); animation.currentTime = 1500; } catch { /* 已取消的动画跳过 */ }
      }
    }
    await Promise.all(
      all.filter(animation => animation.effect?.getTiming?.().iterations !== Infinity)
        .map(animation => animation.finished.catch(() => {})),
    );
    await new Promise(resolve => requestAnimationFrame(resolve));
  });
  await page.waitForTimeout(120);
}

async function shot(page, name, width) {
  await settle(page);
  await page.screenshot({ path: path.join(SHOTS, `${name}.${width}.png`) });
  console.log(`SHOT ${name}.${width}.png`);
}

/** 先等动画播完，再断言指定层内没有仍在播放的有限动画（即处于动画终态）。 */
async function assertSettledIn(page, selector, label) {
  await settle(page);
  const running = await page.evaluate(sel => {
    const root = document.querySelector(sel);
    if (!root) return ['missing-root'];
    return document.getAnimations()
      .filter(a => root.contains(a.effect?.target))
      .filter(a => (a.effect?.getTiming?.().iterations ?? 1) !== Infinity)
      .filter(a => a.playState === 'running')
      .map(a => `${a.constructor.name}@${String(a.effect?.target?.className).slice(0, 40)}`);
  }, selector);
  record(`animation-end-state/${label}`, running.length === 0, running.join(',') || '全部动画已到达终态');
}

/** 当前焦点是否落在 selector（或其内部）。 */
const activeIs = (page, selector) => page.evaluate(sel => document.activeElement?.closest?.(sel) != null, selector);

/** 等焦点稳定落到 selector（或 body），返回是否达成；避免焦点返回的时序竞态。 */
async function expectFocus(page, selector, label, detail) {
  const ok = await page
    .waitForFunction(sel => (sel === 'body'
      ? document.activeElement === document.body
      : document.activeElement?.closest?.(sel) != null), selector, { timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  record(label, ok, detail);
}

/** 打开首页并等待看板与 fixture 雷达数据就绪。 */
async function openHome(page) {
  await page.goto(`${BASE}/`);
  await page.waitForSelector('[data-testid="decision-home"]');
  await page.waitForSelector('[data-radar-notice]'); // fixture 的 red 信号通知卡已渲染。
  await settle(page);
}

/** 计算一组关键表面的字体、颜色、阴影与几何。 */
async function designTokens(page, extra = []) {
  return page.evaluate(selectors => selectors.map(({ description, selector }) => {
    const el = document.querySelector(selector);
    if (!el) return { description, selector, missing: true };
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      description, selector,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight,
      color: cs.color, backgroundColor: cs.backgroundColor, backgroundImage: cs.backgroundImage,
      borderRadius: cs.borderRadius, boxShadow: cs.boxShadow, border: cs.border, padding: cs.padding,
    };
  }), [
    { description: '应用根壳', selector: '[data-testid="ceo-workspace"]' },
    { description: '首页看板', selector: '[data-testid="decision-home"]' },
    { description: '战略议题面板', selector: '[data-origin="strategy"]' },
    { description: '雷达入口卡', selector: 'button[data-origin="radar"]' },
    { description: '战场卡 · 灯塔项目', selector: '[data-testid="zone-lighthouse"]' },
    { description: '战场卡 · TokenOps', selector: '[data-testid="zone-tokenops"]' },
    { description: '公司能力面板', selector: '[data-origin="capabilities"]' },
    { description: '通知卡 · 会后共识', selector: '[data-notice="confirmation"]' },
    { description: '通知卡 · 会议安排', selector: '[data-notice="agenda"]' },
    { description: '通知卡 · 负责人提请', selector: '[data-notice="inquiry"]' },
    { description: '通知卡 · 月度协商', selector: '[data-notice="monthly"]' },
    { description: '通知栏时钟', selector: '[data-testid="notification-clock"]' },
    { description: '对话 dock', selector: '[data-testid="conversation-dock"]' },
    ...extra,
  ]);
}

/** 战场正反面（正面即默认面，翻面截背面，再翻回并核对焦点保持）。 */
async function captureBattlefield(page, zoneId, name, width) {
  const zone = `[data-testid="zone-${zoneId}"]`;
  await page.click(`${zone} button[aria-label^="查看"]`);
  await page.waitForSelector(`${zone}[data-mode="progress"]`);
  record(`battlefield-flip-keeps-focus/${zoneId}/${width}`, await activeIs(page, `${zone} button[aria-label^="返回"]`), '翻面后焦点移到背面控制');
  await assertSettledIn(page, zone, `battlefield-${zoneId}-back`);
  await shot(page, `${name}-back`, width);
  await page.click(`${zone} button[aria-label^="返回"]`);
  await page.waitForSelector(`${zone}[data-mode="decisions"]`);
  record(`battlefield-unflip-keeps-focus/${zoneId}/${width}`, await activeIs(page, `${zone} button[aria-label^="查看"]`), '翻回后焦点回到正面控制');
  await shot(page, `${name}-front`, width);
}

/** 单视口的全部状态与交互证据。返回该视口收集的 token 与关键几何。 */
async function runViewport(browser, width) {
  const tokens = {};

  // —— 入口门：未登录一律被送回 /access ——
  {
    const { context, page } = await newPage(browser, { width, cookie: false });
    await page.goto(`${BASE}/`);
    await page.waitForURL(/\/access/);
    record(`entry-gate-redirect/${width}`, page.url().includes('/access'), page.url());
    await page.waitForSelector('form');
    await shot(page, 'access', width);
    await context.close();
  }

  // —— 首页默认 + 设计 token + 战场翻面 ——
  {
    const { context, page } = await newPage(browser, { width });
    await openHome(page);
    record(`no-page-errors/home/${width}`, page.pageErrors.length === 0, page.pageErrors.join(' | ') || '无页面错误');
    await shot(page, 'home', width);
    tokens.home = await designTokens(page);
    await captureBattlefield(page, 'lighthouse', 'battlefield-lighthouse', width);
    await captureBattlefield(page, 'tokenops', 'battlefield-tokenops', width);
    await context.close();
  }

  // —— 进入动画终态：带 _entry=unlock 进入，覆盖层最终移除，终态即首页 ——
  {
    const { context, page } = await newPage(browser, { width });
    await page.goto(`${BASE}/?_entry=unlock`);
    await page.waitForSelector('[data-testid="decision-home"]');
    await page.waitForSelector('[data-radar-notice]');
    await page.waitForFunction(() => document.querySelector('[data-testid="ceo-workspace"]')?.getAttribute('data-arriving') !== 'true', null, { timeout: 8000 });
    await shot(page, 'home-entry-final', width);
    record(`entry-animation-end-state/${width}`, true, '入场覆盖层已移除，data-arriving 已清除');
    await context.close();
  }

  // —— 通知浮卡（confirmation / inquiry）：开启焦点、终态、Escape 焦点返回 ——
  for (const id of ['confirmation', 'inquiry']) {
    const { context, page } = await newPage(browser, { width });
    await openHome(page);
    if (id === 'inquiry') {
      await page.click('[data-notice="inquiry"] button:has-text("首次交付承诺")'); // 确定点击落点：负责人提请卡内的头部按钮。
    } else {
      await page.click(`[data-notice="${id}"]`);
    }
    await page.waitForSelector(`[data-active-notice="${id}"]`);
    record(`notification-float-open-focus/${id}/${width}`, await activeIs(page, '[data-close-notice]'), '焦点落在浮卡关闭按钮');
    await assertSettledIn(page, `[data-active-notice="${id}"]`, `float-${id}-${width}`);
    await shot(page, `notification-float-${id}`, width);
    await page.keyboard.press('Escape');
    await page.waitForSelector(`[data-active-notice="${id}"]`, { state: 'detached' });
    await expectFocus(page, `[data-notice="${id}"]`, `notification-float-escape-focus-return/${id}/${width}`, '焦点回到原通知卡');
    await context.close();
  }

  // —— Meeting（会前预审工作区）——
  {
    const { context, page } = await newPage(browser, { width });
    await openHome(page);
    await page.click('[data-heavy-notice="preflight-product"]');
    await page.waitForSelector('[data-meeting-workspace]');
    await assertSettledIn(page, '[data-meeting-workspace]', `meeting-${width}`);
    await shot(page, 'meeting-preflight-product', width);
    tokens.meeting = await designTokens(page, [{ description: '会议工作区', selector: '[data-meeting-workspace]' }]);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-meeting-workspace]', { state: 'detached' });
    record(`meeting-escape-closes/${width}`, true, 'Escape 关闭会议工作区');
    await context.close();
  }

  // —— MonthlyPlan（月度协商工作区）——
  {
    const { context, page } = await newPage(browser, { width });
    await openHome(page);
    await page.click('[data-notice="monthly"]');
    await page.waitForSelector('[data-heavy-workspace]');
    await assertSettledIn(page, '[data-heavy-workspace]', `monthly-${width}`);
    await shot(page, 'monthly-plan', width);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-heavy-workspace]', { state: 'detached' });
    record(`monthly-escape-closes/${width}`, true, 'Escape 关闭月度工作区');
    await context.close();
  }

  // —— Radar 列表 / Signal 详情 / 监测范围编辑 / Escape 返回 ——
  let radarViewRect = null;
  {
    const { context, page } = await newPage(browser, { width });
    await openHome(page);
    await page.click('button[data-origin="radar"]');
    await page.waitForSelector('[data-testid="expanded-panel"]');
    record(`radar-view-open-focus/${width}`, await activeIs(page, '[data-close-view]'), '焦点落在视图关闭按钮');
    await assertSettledIn(page, '[data-testid="expanded-panel"]', `radar-view-${width}`);
    radarViewRect = await page.evaluate(() => document.querySelector('[data-testid="expanded-panel"]')?.getBoundingClientRect().toJSON());

    // 先验证 Escape 返回（无数据变更，焦点原点未被重建），再做后续截图流程。
    // 旧版实际行为：焦点原点仍在 inert 的首页表面上，closeView 的聚焦静默失败，焦点落在 body。按原样记录。
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="expanded-panel"]', { state: 'detached' });
    await expectFocus(page, 'body', `radar-view-escape-focus-return/${width}`, '旧版行为：焦点落在 body（原点在 inert 首页上，返回聚焦静默失败）；新 Web 可在此基础上修复');

    await page.click('button[data-origin="radar"]');
    await page.waitForSelector('[data-testid="expanded-panel"]');
    await shot(page, 'radar-list', width);
    tokens.radarView = await designTokens(page, [{ description: '展开视图容器', selector: '[data-testid="expanded-panel"]' }]);

    await page.click('[data-testid="radar-feed"] button[class*="story"] >> nth=0');
    await page.waitForSelector('[data-radar-reader]');
    await shot(page, 'radar-signal-reader', width);

    await page.click('button:has-text("返回信号")');
    await page.waitForSelector('[data-radar-reader]', { state: 'detached' });
    await page.click('button[aria-label="设置监测范围"]');
    await page.waitForSelector('dialog[aria-labelledby="anchor-editor-title"]');
    await settle(page);
    await shot(page, 'radar-config-editor', width);
    await page.click('button[aria-label="关闭监测范围"]');
    await page.waitForSelector('dialog[aria-labelledby="anchor-editor-title"]', { state: 'detached' });

    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="expanded-panel"]', { state: 'detached' });
    record(`radar-view-escape-after-actions/${width}`, true, '浏览信号与配置后 Escape 仍能关闭视图');
    await context.close();
  }

  // —— Conversation dock：键盘、历史欢迎页、thinking、回复 ——
  {
    const { context, page } = await newPage(browser, { width });
    await openHome(page);
    await page.click('button[aria-label="切换键盘输入"]');
    record(`dock-keyboard-focus/${width}`, await activeIs(page, '[data-testid="conversation-dock"] textarea'), '切换后焦点进入输入框');
    await page.fill('[data-testid="conversation-dock"] textarea', '帮我看看今天有什么值得注意的安排');
    await shot(page, 'conversation-dock-keyboard', width);
    await page.click('button[aria-label*="的对话记录"]');
    await page.waitForSelector('[data-testid="conversation-sheet"]');
    await shot(page, 'conversation-history-welcome', width);
    await page.focus('[data-testid="conversation-dock"] textarea');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="conversation-thinking"]');
    await shot(page, 'conversation-thinking', width);
    await page.waitForSelector('[data-chat-role="assistant"]');
    await shot(page, 'conversation-reply-history', width);
    // Escape 层级：键盘模式先收起，再关历史记录层。按实际行为记录。
    await page.keyboard.press('Escape');
    const keyboardExited = await page.waitForFunction(() => document.querySelector('[data-testid="conversation-dock"]')?.getAttribute('data-mode') === 'voice', null, { timeout: 3000 }).then(() => true).catch(() => false);
    record(`escape-exits-keyboard-first/${width}`, keyboardExited, '第一层 Escape 先收起键盘模式（data-mode 回到 voice）');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="conversation-sheet"]', { state: 'detached' });
    record(`conversation-history-escape/${width}`, true, '第二层 Escape 关闭历史记录层');
    await context.close();
  }

  // —— 引用托盘与引用预览 ——
  {
    const { context, page } = await newPage(browser, { width });
    await openHome(page);
    await page.click('button[data-reference-id="issue:capacity"]');
    await page.waitForSelector('[data-testid="reference-tray"]');
    await page.click('button[data-reference-id="issue:payment"]');
    await page.click('button[aria-label="切换键盘输入"]');
    await page.fill('[data-testid="conversation-dock"] textarea', '比较这两张卡片各自的风险');
    await shot(page, 'conversation-dock-references', width);
    await page.click('[data-testid="reference-tray"] button[title^="交付力量"]');
    await page.waitForSelector('[aria-label^="引用内容"]');
    await shot(page, 'conversation-reference-preview', width);
    const pressed = await page.getAttribute('button[data-reference-id="issue:capacity"]', 'aria-pressed');
    record(`reference-toggle-state/${width}`, pressed === 'true', `引用按钮 aria-pressed=${pressed}`);
    await context.close();
  }

  // —— Issue sheet（含研究依据页签）与 Escape 分层顺序 ——
  let issueSheetRect = null;
  {
    const { context, page } = await newPage(browser, { width });
    await openHome(page);
    await page.click('[data-home-issue="capacity"] button[aria-label*="交付力量"]');
    await page.waitForSelector('[data-testid="issue-workspace"]');
    record(`issue-sheet-open-focus/${width}`, await activeIs(page, '[data-close-sheet]'), '焦点落在议题关闭按钮');
    await assertSettledIn(page, '[data-testid="issue-workspace"]', `issue-sheet-${width}`);
    issueSheetRect = await page.evaluate(() => document.querySelector('[data-testid="issue-workspace"]')?.getBoundingClientRect().toJSON());
    await shot(page, 'issue-workspace', width);
    tokens.issueSheet = await designTokens(page, [{ description: '议题工作区', selector: '[data-testid="issue-workspace"]' }]);
    await page.click('button:has-text("研究与依据")');
    await settle(page);
    await shot(page, 'issue-workspace-research', width);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="issue-workspace"]', { state: 'detached' });
    await expectFocus(page, '[data-home-issue="capacity"]', `issue-sheet-escape-focus-return/${width}`, '焦点回到首页议题按钮');

    // Escape 分层顺序：view + sheet 同开时，第一层 Escape 只关最上层。
    await page.click('[data-origin="strategy"] button:has-text("公司战略议题")');
    await page.waitForSelector('[data-testid="expanded-panel"]');
    await page.click('[data-testid="expanded-panel"] button:has-text("交付力量先支持灯塔")');
    await page.waitForSelector('[data-testid="issue-workspace"]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="issue-workspace"]', { state: 'detached' });
    const viewStillOpen = await page.isVisible('[data-testid="expanded-panel"]');
    record(`escape-order-sheet-first/${width}`, viewStillOpen, '第一层 Escape 只关闭议题层，视图保留');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="expanded-panel"]', { state: 'detached' });
    await context.close();
  }

  return { tokens, radarViewRect, issueSheetRect };
}

/** reduced-motion：打开动作应立即到达终态，且几何与正常 motion 完全一致。 */
async function runReducedMotion(browser, width, reference) {
  const { context, page } = await newPage(browser, { width, motion: 'reduce' });
  const runningFinite = () => page.evaluate(() =>
    document.getAnimations()
      .filter(a => (a.effect?.getTiming?.().iterations ?? 1) !== Infinity)
      .filter(a => (a.effect?.getTiming?.().duration ?? 0) > 0)
      .filter(a => a.playState === 'running')
      .map(a => a.effect.getTiming().duration));

  await openHome(page);
  await page.click('button[data-origin="radar"]');
  await page.waitForSelector('[data-testid="expanded-panel"]');
  const radarDurations = await runningFinite();
  record('reduced-motion/radar-view-no-animation', radarDurations.length === 0, radarDurations.join(',') || '无 >0ms 的运行中动画');
  const radarRect = await page.evaluate(() => document.querySelector('[data-testid="expanded-panel"]')?.getBoundingClientRect().toJSON());
  record('reduced-motion/radar-view-geometry-matches', sameRect(radarRect, reference.radarViewRect), JSON.stringify({ reduced: radarRect, normal: reference.radarViewRect }));
  await shot(page, 'reduced-motion-radar-view', width);

  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="expanded-panel"]', { state: 'detached' });
  await page.click('[data-home-issue="capacity"] button[aria-label*="交付力量"]');
  await page.waitForSelector('[data-testid="issue-workspace"]');
  const sheetDurations = await runningFinite();
  record('reduced-motion/issue-sheet-no-animation', sheetDurations.length === 0, sheetDurations.join(',') || '无 >0ms 的运行中动画');
  const sheetRect = await page.evaluate(() => document.querySelector('[data-testid="issue-workspace"]')?.getBoundingClientRect().toJSON());
  record('reduced-motion/issue-sheet-geometry-matches', sameRect(sheetRect, reference.issueSheetRect), JSON.stringify({ reduced: sheetRect, normal: reference.issueSheetRect }));
  await shot(page, 'reduced-motion-issue-sheet', width);
  await context.close();
}

function sameRect(a, b) {
  if (!a || !b) return false;
  return ['x', 'y', 'width', 'height'].every(k => Math.round(a[k]) === Math.round(b[k]));
}

// ————————————————————————————————— 主流程 —————————————————————————————————

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-gpu'] }); // 软件渲染，保证截图像素级可重现
try {
  const healthAt = new Date().toISOString();
  const health = await fetch(`${BASE}/api/health`).then(r => r.json()).catch(error => ({ status: 'unreachable', error: String(error) }));
  writeFileSync(path.join(EVID, 'health.json'), JSON.stringify({ capturedAt: healthAt, base: BASE, health }, null, 2) + '\n');
  console.log('HEALTH saved');

  const tokenSets = {};
  const reference = {};
  for (const width of VIEWPORTS) {
    const result = await runViewport(browser, width);
    tokenSets[width] = result.tokens;
    if (width === 1440) {
      reference.radarViewRect = result.radarViewRect;
      reference.issueSheetRect = result.issueSheetRect;
    }
  }
  writeFileSync(
    path.join(EVID, 'design-tokens.json'),
    JSON.stringify({ base: BASE, fixtureTime: FIXED_TIME.toISOString(), viewports: VIEWPORTS, tokens: tokenSets }, null, 2) + '\n',
  );

  await runReducedMotion(browser, 1440, reference);

  writeFileSync(path.join(EVID, 'interactions.json'), JSON.stringify({ base: BASE, fixedTime: FIXED_TIME.toISOString(), viewports: VIEWPORTS, checks }, null, 2) + '\n');
  const failed = checks.filter(c => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    console.error('FAILED:', failed.map(f => f.id).join(', '));
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
