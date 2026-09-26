const {chromium}=require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const {Pool}=require(process.cwd()+'/apps/api/node_modules/pg');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const [endpoint,database]=process.argv.slice(2);if(!/^warmap_test_[a-f0-9]{12}$/.test(database||''))throw Error('Explicit fixture required');
const pool=new Pool({connectionString:`postgres://postgres:postgres@localhost:54329/${database}`,max:1});
const log=(name,data={})=>{const line=JSON.stringify({name,...data});console.log(line);fs.appendFileSync(path.join(__dirname,'verification.log'),line+'\n');};
(async()=>{
await pool.query('DELETE FROM person_onboarding');await pool.query('DELETE FROM person_voiceprints');
const browser=await chromium.connectOverCDP(endpoint);const context=await browser.newContext({viewport:{width:375,height:812},permissions:['microphone']});const page=await context.newPage();
const root='http://localhost:3500';await context.request.post(root+'/api/auth/login',{data:{loginId:'ceshij',passcode:'2468'},headers:{origin:root}});
await page.goto(root+'/welcome');await page.getByRole('button',{name:'开始',exact:true}).click();await page.waitForTimeout(650);
const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'},{name:'prefers-contrast',value:'more'}]});
await page.waitForFunction(()=>matchMedia('(prefers-reduced-transparency: reduce)').matches);
await page.waitForTimeout(250);
const fallback=await page.locator('[class*="snapshot"]').first().evaluate(e=>{const s=getComputedStyle(e);return {background:s.backgroundColor,backdrop:s.backdropFilter,border:s.borderTopStyle};});
if(fallback.backdrop!=='none')log('media-diagnostic',await page.locator('[class*="snapshot"]').first().evaluate(e=>{const matched=[];function walk(rules,media=''){for(const r of rules){if(r.selectorText&&e.matches(r.selectorText)&&r.style?.cssText.includes('backdrop'))matched.push({selector:r.selectorText,style:r.style.cssText,media});if(r.cssRules)walk(r.cssRules,r.conditionText||media)}}for(const sheet of document.styleSheets){try{walk(sheet.cssRules)}catch{}}return {class:e.className,reduced:matchMedia('(prefers-reduced-transparency: reduce)').matches,matched};}));
assert.equal(fallback.background,'rgb(247, 249, 252)');assert.equal(fallback.border,'solid');
let transparencyFailure;
try { assert.equal(fallback.backdrop,'none'); } catch(error) { transparencyFailure=error; }
log('reduced-transparency-and-high-contrast',{...fallback,passed:!transparencyFailure});
await page.screenshot({path:path.join(__dirname,'after-company-reduced-transparency-phone.png')});await cdp.send('Emulation.setEmulatedMedia',{features:[]});await cdp.detach();
await page.evaluate(()=>window.scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'}));await page.waitForTimeout(650);await page.screenshot({path:path.join(__dirname,'after-company-phone-scrolled.png')});
await page.getByRole('button',{name:'下一步',exact:true}).click();await page.waitForTimeout(650);
await page.locator('[class*="recordControl"]').evaluate(e=>e.scrollIntoView({block:'center',behavior:'instant'}));await page.waitForTimeout(650);await page.screenshot({path:path.join(__dirname,'after-voice-disabled-phone-scrolled.png')});
await page.getByRole('checkbox').check();await page.getByRole('button',{name:'开始录制',exact:true}).click();
await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.getAttribute('aria-label')==='停止录制'&&!b.disabled),{},{timeout:18000});
await page.locator('[class*="recordControl"]').evaluate(e=>e.scrollIntoView({block:'center',behavior:'instant'}));await page.waitForTimeout(650);
const positions=await page.evaluate(()=>{const r=document.querySelector('[class*="recordControl"]').getBoundingClientRect();const footer=document.querySelector('footer').getBoundingClientRect();return {recordTop:r.top,recordBottom:r.bottom,footerTop:footer.top,scrollY};});assert(positions.recordTop>=0&&positions.recordBottom<positions.footerTop);log('mobile-record-control-clear-of-footer',positions);
await page.screenshot({path:path.join(__dirname,'after-recording-phone-scrolled.png')});await page.getByRole('button',{name:'停止录制',exact:true}).click();await page.waitForTimeout(800);await page.screenshot({path:path.join(__dirname,'after-recorded-phone-scrolled.png')});
await context.close();await browser.close();await pool.end();
// Preserve the failed optional regression as a nonzero exit while still collecting
// the requested mobile evidence. The unchanged prefixed fallback is documented.
if(transparencyFailure)process.exitCode=1;
})().catch(async e=>{log('FAILED',{message:e.message});await pool.end();process.exit(1);});
