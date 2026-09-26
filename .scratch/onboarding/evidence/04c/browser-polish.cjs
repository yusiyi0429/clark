const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const fs = require('node:fs'); const path = require('node:path'); const assert = require('node:assert/strict');
const root = 'http://localhost:3500'; const phase = process.argv[3] || 'final';
async function main() {
  const {cardId} = JSON.parse(fs.readFileSync(path.join(__dirname,'browser-targets.json'),'utf8'));
  const browser = await chromium.connectOverCDP(process.argv[2]);
  const context = await browser.newContext(); const page = await context.newPage(); const errors=[];
  page.on('pageerror', error => errors.push(error.message));
  assert.equal((await context.request.post(root+'/api/auth/login',{data:{loginId:'browserceo',passcode:'8742'},headers:{origin:root}})).status(),200);
  await page.goto(root+'/mission-cards/'+cardId); await page.waitForTimeout(1000);
  const metrics=[];
  for (const [width,height] of [[1440,900],[834,1194],[390,844]]) {
    await page.setViewportSize({width,height});
    await page.getByRole('button',{name:'返回总览',exact:true}).focus(); await page.waitForTimeout(350);
    metrics.push(await page.evaluate(()=>{const h=document.querySelector('.ts-detail-header > h1');const b=document.querySelector('.ts-detail-header button'); const r=h?.getBoundingClientRect(); const br=b?.getBoundingClientRect(); const c=b&&getComputedStyle(b); return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,titleLeft:r?.left,titlePadding:h&&getComputedStyle(h).paddingInlineStart,backRight:br?.right,outline:c?.outline,outlineOffset:c?.outlineOffset,overlay:!!document.querySelector('[data-nextjs-dialog]')};}));
    await page.screenshot({path:path.join(__dirname,`${phase}-overview-${width}.png`)});
  }
  if(phase==='final') {
    const session=await context.newCDPSession(page);
    await session.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'},{name:'prefers-reduced-transparency',value:'reduce'}]});
    const toggle=page.getByRole('button',{name:'展开本轮详情',exact:true});if(await toggle.count())await toggle.click();
    await page.getByRole('button',{name:'查看目标',exact:true}).click();await page.getByRole('dialog',{name:'本轮目标依据'}).waitFor();
    const fallback=await page.getByRole('dialog',{name:'本轮目标依据'}).evaluate(el=>({background:getComputedStyle(el).backgroundColor,blur:getComputedStyle(el).backdropFilter}));assert.equal(fallback.blur,'none');
    await page.screenshot({path:path.join(__dirname,'reduced-motion-transparency-390.png')});metrics.push({fallback});
  }
  assert(metrics.every(m=>!m.overflow&&!m.overlay));assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(__dirname,`${phase}-visual-metrics.json`),JSON.stringify({metrics,errors},null,2)); console.log(JSON.stringify({metrics,errors}));
}
main().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1)});
