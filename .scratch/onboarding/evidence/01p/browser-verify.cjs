const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const { Pool } = require(process.cwd() + '/apps/api/node_modules/pg');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const [endpoint,database] = process.argv.slice(2);
if (!/^warmap_test_[a-f0-9]{12}$/.test(database||'')) throw Error('Explicit fixture database required');
const pool = new Pool({connectionString:`postgres://postgres:postgres@localhost:54329/${database}`,max:1});
const root='http://localhost:3500';
const log=(name,data={})=>{const line=JSON.stringify({name,...data}); console.log(line);fs.appendFileSync(path.join(__dirname,'verification.log'),line+'\n');};
const settle=page=>page.waitForTimeout(650);
async function main(){
  const browser=await chromium.connectOverCDP(endpoint);
  const context=await browser.newContext({viewport:{width:1440,height:900},permissions:['microphone']});
  const page=await context.newPage();
  const backgrounds=[];
  await page.exposeFunction('recordSubstrate',pair=>backgrounds.push(pair));
  await page.addInitScript(()=>setInterval(()=>{if(document.readyState!=='loading'&&document.querySelector('[data-morning-canvas]'))window.recordSubstrate([getComputedStyle(document.documentElement).backgroundColor,getComputedStyle(document.body).backgroundColor]);},16));
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await pool.query('DELETE FROM person_onboarding');
  await pool.query('DELETE FROM person_voiceprints');
  // Exercise the actual lock-screen default landing, sampling its substrate during unlock.
  await page.goto(root+'/access?next=%2F');await settle(page);
  await page.getByRole('textbox',{name:'你的 ID',exact:true}).fill('ceshij');
  await page.getByLabel('口令第 1 位',{exact:true}).focus();
  await page.keyboard.type('2468',{delay:60});
  await page.waitForURL('**/welcome?next=*');await settle(page);
  assert.equal(new URL(page.url()).searchParams.get('next'),'/');
  assert(backgrounds.length>0);assert(backgrounds.every(pair=>pair.every(c=>c==='rgb(247, 249, 252)')));
  log('lock-to-welcome-substrate',{samples:backgrounds.length,unique:[...new Set(backgrounds.flat())]});
  await page.getByRole('button',{name:'开始',exact:true}).click();await settle(page);
  // Long content: short laptop, breakpoint, tablet. CTA must remain in view.
  for (const [width,height] of [[1440,900],[1280,650],[760,650],[834,1194],[759,812],[375,812]]){
    await page.setViewportSize({width,height});await settle(page);
    const box=await page.locator('footer > button').boundingBox();assert(box.y>=0&&box.y+box.height<=height);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    log('company-primary-visible',{width,height,bottom:box.y+box.height});
    if(width===834)await page.screenshot({path:path.join(__dirname,'after-company-tablet.png')});
  }
  await page.setViewportSize({width:1280,height:650});
  await page.locator('[class*="stage"]').evaluate(e=>e.scrollTop=e.scrollHeight);
  assert(await page.getByText('哪里不对，在个人菜单的「组织配置」里改。').isVisible());
  await page.screenshot({path:path.join(__dirname,'after-company-short-desktop-scrolled.png')});
  await page.getByRole('button',{name:'下一步',exact:true}).click();await settle(page);
  assert.equal(await page.locator('[class*="stage"]').evaluate(e=>e.scrollTop),0);
  assert.equal(await page.evaluate(()=>document.activeElement.tagName),'H1');log('desktop-scroll-resets-on-next-and-focuses-title');
  const disabled=page.getByRole('button',{name:'录好后继续',exact:true});
  await disabled.hover({force:true});
  const state=await disabled.evaluate(e=>{const s=getComputedStyle(e);return {opacity:s.opacity,filter:s.filter,cursor:s.cursor,shadow:s.boxShadow,hint:document.getElementById(e.getAttribute('aria-describedby'))?.textContent};});
  assert.equal(state.opacity,'0.55');assert.equal(state.filter,'saturate(0.25)');assert.equal(state.cursor,'not-allowed');assert.equal(state.shadow,'none');assert.match(state.hint,/同意/);log('disabled-after-animation-and-hover',state);
  await page.emulateMedia({reducedMotion:'reduce'});await settle(page);assert.equal(await disabled.evaluate(e=>getComputedStyle(e).opacity),'0.55');
  await page.screenshot({path:path.join(__dirname,'after-voice-reduced-motion.png')});await page.emulateMedia({reducedMotion:'no-preference'});
  await page.getByRole('checkbox').check();
  await page.getByRole('button',{name:'开始录制',exact:true}).click();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.getAttribute('aria-label')==='停止录制'&&!b.disabled),{},{timeout:18000});log('recording-15s-can-stop');
  await page.getByRole('button',{name:'保存并继续',exact:true}).waitFor({timeout:18000});assert(await page.getByRole('button',{name:'保存并继续',exact:true}).isEnabled());log('recording-30s-auto-stop');
  await page.setViewportSize({width:375,height:812});await page.locator('[class*="recordControl"]').scrollIntoViewIfNeeded();await settle(page);
  await page.screenshot({path:path.join(__dirname,'after-recorded-phone.png')});
  await page.getByRole('button',{name:'保存并继续',exact:true}).click();await page.getByRole('heading',{name:'可以开始了',exact:true}).waitFor();
  assert(await page.getByText('声纹 · 已录好',{exact:false}).isVisible());log('recording-save-real-api-simulated-provider');
  for(const [next,expectedLabel,expectedPath] of [['/','核对 9 月目标','/plans/2026-09'],['/radar?tab=all','继续刚才的页面','/radar'],['https://example.com/','核对 9 月目标','/plans/2026-09']]){
    await pool.query('DELETE FROM person_onboarding');
    await page.goto(root+'/welcome?next='+encodeURIComponent(next));await settle(page);
    for(const label of ['开始','下一步','下一步']){await page.getByRole('button',{name:label,exact:true}).click();await settle(page);}
    assert(await page.getByRole('button',{name:expectedLabel,exact:true}).isEnabled());
    if(next.startsWith('/radar')){await page.screenshot({path:path.join(__dirname,'after-deeplink-phone.png')});await page.setViewportSize({width:1440,height:900});await settle(page);await page.screenshot({path:path.join(__dirname,'after-deeplink-desktop.png')});}
    await page.getByRole('button',{name:expectedLabel,exact:true}).click();await page.waitForURL(u=>u.pathname!='/welcome');assert.equal(new URL(page.url()).pathname,expectedPath);log('browser-ceo-next',{next,label:expectedLabel,destination:expectedPath});
  }
  const member=await browser.newContext({viewport:{width:375,height:812}});const mp=await member.newPage();
  const response=await member.request.post(root+'/api/auth/login',{data:{loginId:'ceshiy',passcode:'1357'},headers:{origin:root}});assert.equal(response.status(),200);
  for(const next of ['/me','/me#tasks','//example.com']){
    await pool.query('DELETE FROM person_onboarding');await mp.goto(root+'/welcome?next='+encodeURIComponent(next));await settle(mp);
    await mp.getByRole('button',{name:'开始',exact:true}).click();await settle(mp);await mp.screenshot({path:path.join(__dirname,'after-member-work-phone.png')});
    await mp.getByRole('button',{name:'下一步',exact:true}).click();await settle(mp);await mp.getByRole('button',{name:'稍后',exact:true}).click();await settle(mp);
    const label=await mp.locator('footer > button').innerText();assert.equal(label.includes('继续刚才的页面'),next==='/me#tasks');
    await mp.locator('footer > button').click();await mp.waitForURL(u=>u.pathname==='/me');if(next==='/me#tasks')assert.equal(new URL(mp.url()).hash,'#tasks');log('browser-member-next',{next,label,path:new URL(mp.url()).pathname});
  }
  assert.deepEqual(errors,[]);log('no-browser-page-errors');await member.close();await context.close();await browser.close();await pool.end();
}
main().catch(async e=>{log('FAILED',{message:e.message,stack:e.stack});await pool.end();process.exit(1);});
