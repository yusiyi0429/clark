// Browser integration against the ticket's disposable 54329 fixture only.
// Uses the already-installed Playwright runtime; no dependencies are installed.
const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const { Pool } = require(process.cwd() + '/apps/api/node_modules/pg');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const endpoint = process.argv[2];
const stage = process.argv[3] || 'ceo';
const dir = __dirname;
const root = 'http://localhost:3300';
const pool = new Pool({ connectionString: 'postgres://postgres:postgres@localhost:54329/warmap_test_db385743162e', max: 1 });
function log(name, data = {}) { const line = JSON.stringify({ name, ...data }); console.log(line); fs.appendFileSync(path.join(dir, 'browser-integration.log'), line + '\n'); }
async function settle(page) { await page.waitForTimeout(700); }
async function capture(page, name) {
  for (const [size, width, height] of [['desktop',1440,900], ['tablet',834,1194], ['phone',375,812]]) {
    await page.setViewportSize({width,height});
    await page.evaluate((name) => { if(name === 'voice-recorded') document.querySelector('[class*="recordControl"]')?.scrollIntoView({block:'center',behavior:'instant'}); else window.scrollTo(0,0); },name);
    await settle(page);
    const bounds = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, heading: document.querySelector('h1')?.textContent, primaryBottom: document.querySelector('footer > button')?.getBoundingClientRect().bottom }));
    assert.equal(bounds.overflow, false);
    if (size === 'phone' && bounds.primaryBottom) assert(bounds.primaryBottom <= height, 'Phone primary is reachable');
    await page.screenshot({path:path.join(dir,`${name}-${size}.png`)});
    log(`${name}-${size}`, bounds);
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  await settle(page);
  assert(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches));
  await page.screenshot({path:path.join(dir,`${name}-reduced-motion.png`)});
  await page.emulateMedia({reducedMotion:'no-preference'});
}
async function advance(page, label) { await page.getByRole('button', {name:label,exact:true}).click(); await settle(page); }
async function main() {
  const browser = await chromium.connectOverCDP(endpoint);
  const context = ['member','lock','voice-off','final-polish'].includes(stage) ? await browser.newContext() : browser.contexts()[0];
  const page = context.pages().find(p=>p.url().startsWith(root)) || await context.newPage();
  page.on('pageerror', error => log('PAGE_ERROR', {message:error.message}));
  if (stage === 'ceo') {
    await page.goto(root+'/welcome'); await settle(page);
    await capture(page,'ceo-hello');
    await advance(page,'开始');
    assert.equal(await page.evaluate(()=>document.activeElement.tagName),'H1');
    await capture(page,'ceo-company');
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'},{name:'prefers-contrast',value:'more'}]});
    const fallback = await page.evaluate(()=>{const card=document.querySelector('[class*="snapshot"]');const style=getComputedStyle(card);return {matches:matchMedia('(prefers-reduced-transparency: reduce)').matches,background:style.backgroundColor,backdrop:style.backdropFilter,border:style.borderTopStyle};});
    assert.equal(fallback.matches,true);assert.equal(fallback.backdrop,'none');assert.equal(fallback.background,'rgb(247, 249, 252)');
    await page.screenshot({path:path.join(dir,'ceo-company-reduced-transparency.png')});log('reduced-transparency',fallback);
    await cdp.send('Emulation.setEmulatedMedia',{features:[]});await cdp.detach();
    await page.keyboard.press('Enter'); await settle(page);
    await capture(page,'ceo-voiceprint');
    await page.setViewportSize({width:1440,height:900});await page.evaluate(()=>scrollTo(0,0));
    assert(await page.getByRole('button',{name:'开始录制',exact:true}).isDisabled());
    await page.getByRole('checkbox').check();
    await advance(page,'开始录制');
    assert(await page.getByRole('button',{name:'停止录制',exact:true}).isDisabled());
    await page.screenshot({path:path.join(dir,'voice-recording-desktop.png')});
    assert.equal(await page.locator('canvas').count(),1);
    log('voice-record-started',{canvas:true,stopInitiallyDisabled:true});
    await page.getByRole('button',{name:'停止录制',exact:true}).waitFor();
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.getAttribute('aria-label')==='停止录制'&&!b.disabled),{},{timeout:18000});
    log('voice-15s-stop-enabled');
    await page.getByRole('button',{name:'保存并继续',exact:true}).waitFor({timeout:18000});
    assert(await page.getByText('录好了，可以保存或重录').isVisible());
    log('voice-30s-autostop');
    await capture(page,'voice-recorded');
    await advance(page,'保存并继续');
    assert(await page.getByRole('heading',{name:'可以开始了',exact:true}).isVisible());
    assert(await page.getByText('声纹 · 已录好',{exact:false}).isVisible());
    await capture(page,'ceo-start');
    await advance(page,'上一步');await capture(page,'voice-enrolled');
    await advance(page,'下一步');
    await page.route('**/api/me/onboarding/complete',route=>route.abort(),{times:1});
    await page.locator('footer > button').click();
    await page.getByRole('button',{name:'重试',exact:true}).waitFor();
    assert.equal(new URL(page.url()).pathname,'/welcome');
    const count=await pool.query('SELECT count(*)::int n FROM person_onboarding');assert.equal(count.rows[0].n,0);
    await page.screenshot({path:path.join(dir,'complete-retry-phone.png')});log('complete-failure-stays-and-no-write');
    await advance(page,'重试');await page.waitForURL('**/plans/*');log('ceo-next-plan',{path:new URL(page.url()).pathname});
    await page.goto(root+'/welcome');await page.waitForURL(root+'/');log('completed-welcome-redirect');
    await pool.query('DELETE FROM person_onboarding WHERE person_id=$1',['person-fixture-001']);
    await page.goto(root+'/radar');await page.waitForURL('**/welcome?next=*');
    assert.equal(new URL(page.url()).searchParams.get('next'),'/radar');
    await advance(page,'先进入工作台');await page.waitForURL(root+'/radar');log('ceo-guard-skip-deeplink');
    const html=await (await page.request.get(root+'/?_entry=unlock')).text();assert(html.includes('data-arriving="true"'));log('ceo-home-entry-ssr');
    await page.goto(root+'/?_entry=unlock');await settle(page);await page.screenshot({path:path.join(dir,'ceo-home-desktop.png')});
    assert(!new URL(page.url()).searchParams.has('_entry'));log('ceo-home-entry-consumed');
  }
  if (stage === 'member') {
    await page.goto(root+'/access'); await settle(page);
    await page.getByRole('textbox',{name:'你的 ID',exact:true}).fill('ceshiy');
    await page.getByLabel('口令第 1 位',{exact:true}).focus();
    await page.keyboard.type('1357',{delay:100});
    await page.waitForURL('**/welcome'); await settle(page);
    await capture(page,'member-hello');
    await advance(page,'开始'); await capture(page,'member-work');
    assert(await page.getByText('本月目标还在协商').first().isVisible());
    assert.equal(await page.getByText('完成三家目标客户的场景验证，确认可复制的增长路径',{exact:true}).count(),0);
    await advance(page,'下一步'); await capture(page,'member-voiceprint');
    await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('User denied','NotAllowedError');};});
    await page.getByRole('checkbox').check(); await advance(page,'开始录制');
    assert(await page.getByText('麦克风没有授权，录不了声纹。',{exact:true}).isVisible());
    await page.evaluate(()=>scrollTo(0,document.body.scrollHeight));
    await page.screenshot({path:path.join(dir,'voice-permission-denied-phone.png')});
    await advance(page,'稍后'); await capture(page,'member-start'); log('microphone-denial-skip');
    await advance(page,'进入工作台'); await page.waitForURL('**/me'); await settle(page);
    assert(!new URL(page.url()).searchParams.has('_entry'));
    await capture(page,'member-home');
    const html=await(await page.request.get(root+'/me?_entry=unlock')).text();assert(html.includes('data-arriving="true"'));log('member-home-entry-ssr');
    await page.goto(root+'/welcome');await page.waitForURL('**/me');log('member-completed-welcome-redirect');
    await pool.query('DELETE FROM person_onboarding WHERE person_id=$1',['person-fixture-002']);
    await page.goto(root+'/me');await page.waitForURL('**/welcome?next=*');assert.equal(new URL(page.url()).searchParams.get('next'),'/me');
    await advance(page,'先进入工作台');await page.waitForURL('**/me');log('member-guard-skip');
    await pool.query('DELETE FROM person_onboarding WHERE person_id=$1',['person-fixture-002']);
    await pool.query("UPDATE monthly_plans SET status='confirmed',confirmed_at=now()");
    await page.goto(root+'/welcome'); await advance(page,'开始');
    assert(await page.getByText('完成三家目标客户的场景验证，确认可复制的增长路径',{exact:true}).isVisible());
    await capture(page,'member-work-confirmed');log('member-confirmed-target-original');
    await pool.query('DELETE FROM monthly_plans');
    await page.goto(root+'/welcome');await advance(page,'开始');
    assert(await page.getByText('本月目标还没出来').first().isVisible());await capture(page,'member-work-no-plan');
    await pool.query('DELETE FROM missions');
    await pool.query('UPDATE battlefield_config SET owner_id=$1',['person-fixture-001']);
    await page.goto(root+'/welcome');await advance(page,'开始');
    assert(await page.getByText('这个月还没有登记你的 Mission',{exact:true}).isVisible());await capture(page,'member-work-empty');log('member-empty-data');
    await context.close();
  }
  if (stage === 'ceo-final') {
    await pool.query('DELETE FROM person_onboarding WHERE person_id=$1',['person-fixture-001']);
    await page.goto(root+'/welcome');await advance(page,'开始');await capture(page,'ceo-company');
    await page.setViewportSize({width:375,height:812});await page.evaluate(()=>scrollTo(0,document.body.scrollHeight));
    await page.screenshot({path:path.join(dir,'ceo-company-phone-scrolled.png')});
    await pool.query('DELETE FROM battlefield_config');await pool.query('DELETE FROM capability_config');await pool.query("UPDATE company_strategy_config SET ltco='' WHERE id='default'");
    await page.goto(root+'/welcome');await advance(page,'开始');await capture(page,'ceo-company-empty');
    assert(await page.getByText('公司的目标和战场还没登记。登记之后，这里会列出目标和分工。',{exact:true}).isVisible());log('ceo-empty-data');
    await advance(page,'先进入工作台'); await page.waitForURL(root+'/');log('ceo-no-plan-default-home');
  }
  if (stage === 'lock') {
    await pool.query('UPDATE member_access SET must_change=TRUE WHERE person_id=$1',['person-fixture-001']);
    await pool.query('DELETE FROM person_onboarding WHERE person_id=$1',['person-fixture-001']);
    await page.goto(root+'/welcome');await page.waitForURL(url=>url.pathname==='/access');assert.equal(new URL(page.url()).searchParams.get('next'),'/welcome');
    await capture(page,'lock');
    await page.getByLabel('口令第 1 位',{exact:true}).focus();await page.keyboard.type('1111',{delay:80});
    await page.getByText('先输入你的 ID',{exact:true}).waitFor();await settle(page);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'access-id');log('lock-missing-id-keeps-focus');
    await page.getByRole('textbox',{name:'你的 ID',exact:true}).fill('ceshij');
    await page.getByLabel('口令第 1 位',{exact:true}).focus();await page.keyboard.type('1111',{delay:80});
    await page.getByText('ID 或口令不对',{exact:true}).waitFor();await capture(page,'lock-error');
    await page.getByLabel('口令第 1 位',{exact:true}).focus();await page.keyboard.type('8642',{delay:80});
    await page.getByLabel('新口令第 1 位',{exact:true}).waitFor();await settle(page);
    assert.equal(await page.getByLabel('新口令第 1 位',{exact:true}).inputValue(),'');await capture(page,'lock-set');
    await page.getByLabel('新口令第 1 位',{exact:true}).focus();await page.keyboard.type('4321',{delay:80});
    assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'确认口令第 1 位');
    await page.getByLabel('新口令第 4 位',{exact:true}).focus();await page.keyboard.press('Backspace');
    await page.getByLabel('确认口令第 1 位',{exact:true}).focus();await page.keyboard.type('4321',{delay:80});
    await page.getByText('两次输入的口令不一致',{exact:true}).waitFor();log('lock-rejects-stale-new-pin');
    await page.getByLabel('新口令第 4 位',{exact:true}).focus();await page.keyboard.type('1');
    await page.keyboard.type('4321',{delay:80});await page.waitForURL('**/welcome');log('lock-first-pin-cleared-and-autofocus');
    await page.getByRole('button',{name:'开始',exact:true}).click();
    await page.getByRole('button',{name:'下一步',exact:true}).click();
    await page.getByRole('button',{name:'下一步',exact:true}).click();
    await settle(page);assert.equal(await page.locator('[data-step=start]').count(),2);assert.equal(await page.evaluate(()=>document.activeElement.tagName),'H1');
    assert.equal(await page.locator('[inert]').count(),0);log('rapid-steps-settle-and-focus');
    await advance(page,'进入工作台');await page.waitForURL(root+'/');
    await capture(page,'ceo-home');
    await context.close();
  }
  if (stage === 'voice-off') {
    await page.goto(root+'/access');await settle(page);
    await page.getByRole('textbox',{name:'你的 ID',exact:true}).fill('ceshiy');
    await page.getByLabel('口令第 1 位',{exact:true}).focus();await page.keyboard.type('1357',{delay:80});
    await page.waitForURL('**/welcome');await settle(page);
    assert.equal(await page.getByText('声纹，可以现在录，也可以以后再说。',{exact:false}).count(),0);
    assert(await page.getByText('第 1 步，共 3 步',{exact:true}).count());
    await capture(page,'voice-unconfigured-hello');
    await advance(page,'开始');await advance(page,'下一步');
    assert(await page.getByRole('heading',{name:'可以开始了',exact:true}).isVisible());
    assert.equal(await page.getByText('声纹 ·',{exact:false}).count(),0);
    await capture(page,'voice-unconfigured-start');log('voice-unconfigured-no-step-no-summary');
    await advance(page,'进入工作台');await page.waitForURL('**/me');
    await context.close();
    const cc=await browser.newContext();const cp=await cc.newPage();await cp.goto(root+'/access');await settle(cp);
    await cp.getByRole('textbox',{name:'你的 ID',exact:true}).fill('ceshij');await cp.getByLabel('口令第 1 位',{exact:true}).focus();await cp.keyboard.type('2468',{delay:80});
    await cp.getByLabel('新口令第 1 位',{exact:true}).waitFor();await cp.getByLabel('新口令第 1 位',{exact:true}).focus();await cp.keyboard.type('4321',{delay:80});await cp.keyboard.type('4321',{delay:80});
    await cp.waitForURL('**/welcome');await settle(cp);await advance(cp,'开始');
    await cp.setViewportSize({width:375,height:812});await settle(cp);await cp.evaluate(()=>scrollTo({top:document.body.scrollHeight,behavior:'instant'}));await settle(cp);
    await cp.screenshot({path:path.join(dir,'ceo-company-phone-scrolled.png')});
    const visible=await cp.getByText('2 位同事',{exact:true}).boundingBox();assert(visible.y>0&&visible.y+visible.height<650);log('company-full-card-scrolls-above-footer');
    await advance(cp,'下一步');assert(await cp.getByRole('heading',{name:'可以开始了',exact:true}).isVisible());log('ceo-unconfigured-three-steps');await cc.close();
  }
  if (stage === 'final-polish') {
    await pool.query('DELETE FROM person_onboarding');
    await page.goto(root+'/access');await settle(page);
    await page.getByRole('textbox',{name:'你的 ID',exact:true}).fill('ceshij');
    await page.getByLabel('口令第 1 位',{exact:true}).focus();await page.keyboard.type('4321',{delay:80});
    await page.waitForURL('**/welcome');await settle(page);
    await advance(page,'开始');
    await page.setViewportSize({width:375,height:812});await settle(page);await page.evaluate(()=>scrollTo({top:document.body.scrollHeight,behavior:'instant'}));await settle(page);
    await page.screenshot({path:path.join(dir,'ceo-company-phone-scrolled.png')});
    await advance(page,'下一步');log('voice-before-polish',{buttons:await page.locator('button').allTextContents()});
    if(await page.getByRole('button',{name:'重新录制',exact:true}).count()) await advance(page,'重新录制');
    await page.getByRole('checkbox').check();await advance(page,'开始录制');
    await page.setViewportSize({width:1440,height:900});await page.evaluate(()=>scrollTo(0,0));await settle(page);
    const moving=await page.locator('canvas').evaluate(c=>c.toDataURL());await page.waitForTimeout(450);assert.notEqual(await page.locator('canvas').evaluate(c=>c.toDataURL()),moving);log('listening-canvas-moves');
    await page.emulateMedia({reducedMotion:'reduce'});await settle(page);const still=await page.locator('canvas').evaluate(c=>c.toDataURL());await page.waitForTimeout(450);assert.equal(await page.locator('canvas').evaluate(c=>c.toDataURL()),still);log('listening-reduced-motion-freezes');
    await page.screenshot({path:path.join(dir,'voice-listening-reduced-motion.png')});await page.emulateMedia({reducedMotion:'no-preference'});
    await page.setViewportSize({width:375,height:812});
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.getAttribute('aria-label')==='停止录制'&&!b.disabled),{},{timeout:18000});
    await advance(page,'停止录制');await settle(page);
    const recordBounds=await page.getByRole('button',{name:'重新录制',exact:true}).boundingBox();assert(recordBounds.y>0 && recordBounds.y+recordBounds.height<650);log('record-result-scrolls-above-mobile-footer');
    await capture(page,'voice-recorded');
    await advance(page,'保存并继续');
    await page.getByRole('button',{name:'上一步',exact:true}).click();await page.getByRole('button',{name:'下一步',exact:true}).click();await settle(page);
    assert.equal(await page.locator('[inert]').count(),0);assert.equal(await page.evaluate(()=>document.activeElement.tagName),'H1');log('rapid-back-forward-stable');
    await advance(page,'进入工作台');await page.waitForURL(root+'/');await capture(page,'ceo-home');
    await context.close();
    const mc=await browser.newContext();const mp=await mc.newPage();
    await mp.goto(root+'/access');await settle(mp);await mp.getByRole('textbox',{name:'你的 ID',exact:true}).fill('ceshiy');await mp.getByLabel('口令第 1 位',{exact:true}).focus();await mp.keyboard.type('1357',{delay:80});await mp.waitForURL('**/welcome');await settle(mp);await advance(mp,'先进入工作台');await mp.waitForURL('**/me');await settle(mp);await capture(mp,'member-home');
    const computed=await mp.getByText('暂时没有新通知',{exact:true}).evaluate(e=>({color:getComputedStyle(e).color,shadow:getComputedStyle(e).textShadow}));log('mobile-home-readable-text',computed);await mc.close();
  }
  await pool.end();
  await browser.close();
}
main().then(()=>process.exit(0)).catch(async error=>{log('FAILED',{message:error.message,stack:error.stack});await pool.end();process.exit(1);});
