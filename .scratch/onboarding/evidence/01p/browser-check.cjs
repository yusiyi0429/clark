// Ticket 01p: real Web/API, synthetic data in the explicitly named disposable DB.
// Uses the preinstalled browser runtime; no package installation or .env reads.
const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const { Pool } = require(process.cwd() + '/apps/api/node_modules/pg');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const [endpoint, phase = 'before', database] = process.argv.slice(2);
if (!/^warmap_test_[a-f0-9]{12}$/.test(database || '')) throw Error('Explicit fixture database required');
const pool = new Pool({ connectionString: `postgres://postgres:postgres@localhost:54329/${database}`, max: 1 });
const root = 'http://localhost:3500';
const log = (name, data = {}) => { const line = JSON.stringify({phase, name, ...data}); fs.appendFileSync(path.join(__dirname, 'browser-checks.log'), line + '\n'); console.log(line); };
const settle = page => page.waitForTimeout(750);
async function capture(page, name) {
  for (const [size, width, height] of [['desktop',1440,900],['phone',375,812]]) {
    await page.setViewportSize({width,height});
    await page.evaluate(() => window.scrollTo(0,0));
    await settle(page);
    const state = await page.evaluate(() => {
      const button = document.querySelector('footer > button'); const css = button && getComputedStyle(button);
      const box = button?.getBoundingClientRect();
      return {heading:document.querySelector('h1')?.textContent, body:getComputedStyle(document.body).backgroundColor,
        html:getComputedStyle(document.documentElement).backgroundColor, overflow:document.documentElement.scrollWidth>innerWidth,
        button:button && {text:button.textContent,disabled:button.disabled,opacity:css.opacity,background:css.backgroundColor,cursor:css.cursor,shadow:css.boxShadow,top:box.top,bottom:box.bottom}};
    });
    assert.equal(state.overflow,false);
    if (phase !== 'before' && state.button) assert(state.button.bottom <= height && state.button.top >= 0, 'Primary remains visible');
    await page.screenshot({path:path.join(__dirname,`${phase}-${name}-${size}.png`)});
    log(`${name}-${size}`,state);
  }
}
async function advance(page, name) { await page.getByRole('button',{name,exact:true}).click(); await settle(page); }
async function main() {
  await pool.query('DELETE FROM person_onboarding');
  await pool.query('DELETE FROM person_voiceprints');
  await pool.query('UPDATE member_access SET must_change = FALSE');
  const browser = await chromium.connectOverCDP(endpoint);
  const context = await browser.newContext({permissions:['microphone']});
  const page = await context.newPage();
  page.on('pageerror', error => log('PAGE_ERROR',{message:error.message}));
  await page.goto(root+'/access'); await settle(page); await capture(page,'lock');
  const login = await context.request.post(root+'/api/auth/login',{data:{loginId:'ceshij',passcode:'2468'},headers:{origin:root}});
  assert.equal(login.status(),200);
  await page.goto(root+'/welcome?next=%2F'); await settle(page);
  await capture(page,'hello');
  // Explicit substrate diagnostic: reveal the real body behind the fixed canvas.
  const substrate = await page.addStyleTag({content:'[data-morning-canvas]{visibility:hidden!important}'});
  await capture(page,'substrate'); await substrate.evaluate(e=>e.remove());
  await advance(page,'开始'); await capture(page,'company');
  await advance(page,'下一步'); await capture(page,'voice-disabled');
  assert(await page.getByRole('button',{name:'录好后继续',exact:true}).isDisabled());
  await page.getByRole('checkbox').check(); await advance(page,'开始录制');
  await capture(page,'recording');
  assert.equal(await page.locator('canvas').count(),1);
  if (phase !== 'before') {
    const frame = await page.locator('canvas').evaluate(c=>c.toDataURL()); await page.waitForTimeout(300);
    assert.notEqual(await page.locator('canvas').evaluate(c=>c.toDataURL()),frame); log('siriwave-moving');
    await page.emulateMedia({reducedMotion:'reduce'}); await settle(page);
    const still = await page.locator('canvas').evaluate(c=>c.toDataURL()); await page.waitForTimeout(300);
    assert.equal(await page.locator('canvas').evaluate(c=>c.toDataURL()),still); log('siriwave-reduced-motion-still');
    await page.emulateMedia({reducedMotion:'no-preference'});
  }
  await advance(page,'稍后'); await capture(page,'finish');
  const label = await page.locator('footer > button').innerText();
  await page.locator('footer > button').click();
  await page.waitForURL(url=>url.pathname!=='/welcome'); await settle(page); await capture(page,'bug-destination');
  log('default-next-destination',{label,path:new URL(page.url()).pathname});
  if (phase !== 'before') assert.match(new URL(page.url()).pathname,/^\/plans\//);
  await context.close(); await browser.close(); await pool.end();
}
main().catch(async error=>{log('FAILED',{message:error.message});await pool.end();process.exitCode=1;});
