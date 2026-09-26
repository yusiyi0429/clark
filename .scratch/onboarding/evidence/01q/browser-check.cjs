const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const phase = process.argv[2] || 'before';
const cases = [
  ['confirm-dialog','dialog'], ['confirm-dialog','backdrop'],
  ['anchor-editor','dialog'], ['anchor-editor','backdrop'],
  ['conversation-dock','dock','layer'], ['conversation-dock','caption','layer'],
  ['app-shell','sheet'], ['app-shell','expandedHeader'],
  ['notifications','glassHeader'], ['notifications','homeCapsule','railClock'], ['notifications','button','railLock'],
  ['account-menu','popover'], ['header-capsule','ts-detail-header','scope','::before'],
  ['conversation-column','header',null,'::before'], ['meeting-header','capsule'], ['material-tabs','bar'],
  ['monthly-workspace','workspace'], ['monthly-workspace','header'], ['monthly-workspace','commitArea'],
];
async function main() {
  const browser = await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try {
    const context = await browser.newContext({viewport:{width:1440,height:900}});
    const page = await context.newPage();
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const response=await page.goto('http://127.0.0.1:3600/evidence-01q');
    assert.equal(response.status(),200);
    await page.locator('#foundation-glass').waitFor();
    await page.screenshot({path:path.join(__dirname,`${phase}-fixture.png`)});
    assert.equal(await page.locator('[data-nextjs-dialog]').count(),0);
    await page.evaluate(cases=>{
      const modules=JSON.parse(document.querySelector('#module-map').dataset.modules);
      for (const [name,cls,parent,pseudo] of cases) {
        const container=document.createElement('div');
        if(parent) container.className=modules[name][parent];
        const el=document.createElement(cls==='button'?'button':'div');
        el.id=`${name}-${cls}`; el.className=modules[name][cls] || cls;
        el.dataset.pseudo=pseudo || ''; el.textContent=el.id;
        container.append(el);
        const host=document.createElement('div'); host.className=modules['conversation-column'].host;
        host.append(container); document.body.append(host);
      }
    },cases);
    const cdp=await context.newCDPSession(page);
    const states=[];
    for (const width of [1440,375]) {
      await page.setViewportSize({width,height:900});
      for (const value of ['no-preference','reduce']) {
        await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value}]});
        const state=await page.evaluate(()=>({
          width:innerWidth,
          matches:matchMedia('(prefers-reduced-transparency: reduce)').matches,
          supportsStandard:CSS.supports('backdrop-filter','blur(1px)'),
          supportsWebkit:CSS.supports('-webkit-backdrop-filter','blur(1px)'),
          elements:[...document.querySelectorAll('#foundation-glass,#access-codeCell,#access-passwordField,[data-pseudo]')].map(el=>{
            const style=getComputedStyle(el,el.dataset.pseudo || null);
            return {id:el.id,pseudo:el.dataset.pseudo||null,filter:style.backdropFilter,background:style.backgroundColor,blur:style.getPropertyValue('--onboarding-blur'),saturation:style.getPropertyValue('--onboarding-sat')};
          })
        }));
        state.preference=value;
        states.push(state);
        assert.equal(state.matches,value==='reduce');
        for(const el of state.elements.slice(0,3)) {
          assert.equal(el.filter,phase==='after' && value==='reduce'?'blur(0px) saturate(1)':'blur(40px) saturate(1.4)');
          if(value==='reduce') assert.equal(el.background,'rgb(247, 249, 252)');
        }
      }
    }
    // Separate, explicitly synthetic cascade probe: if a standard blur comes from
    // another stylesheet, can the compiled fallback override it? Never count this
    // injected blur as the application's actual computed style.
    const probeIds=cases.map(([name,cls])=>`${name}-${cls}`);
    await page.addStyleTag({content:probeIds.map(id=>`:where(#${id}) { backdrop-filter: blur(9px); }`).join('\n')});
    const cascadeProbes=[];
    for(const width of [1440,375]) {
      await page.setViewportSize({width,height:900});
      cascadeProbes.push(await page.evaluate(ids=>({width:innerWidth,preference:matchMedia('(prefers-reduced-transparency: reduce)').matches,elements:ids.map(id=>({id,filter:getComputedStyle(document.getElementById(id)).backdropFilter}))}),probeIds));
    }
    const urls=await page.locator('link[rel="stylesheet"]').evaluateAll(els=>els.map(el=>el.href));
    const compiled=[];
    for(const url of urls) {
      const css=await (await context.request.get(url)).text();
      if(/prefers-reduced-transparency/.test(css)) {
        const file=`${phase}-${compiled.length}.css`;
        fs.writeFileSync(path.join(__dirname,file),css);
        compiled.push({url,file});
      }
    }
    const rules=await page.evaluate(()=>{
      const result=[];
      function visit(rules,condition='') {
        for(const rule of rules) {
          const next=rule.conditionText ? `${condition} ${rule.conditionText}`:condition;
          if(rule.selectorText && (/prefers-reduced-transparency/.test(condition) || /backdrop-filter:\s*none/.test(rule.cssText))) result.push({condition,selector:rule.selectorText,css:rule.cssText});
          if(rule.cssRules) visit(rule.cssRules,next);
        }
      }
      for(const sheet of document.styleSheets) visit(sheet.cssRules);
      return result;
    });
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(__dirname,`${phase}-computed.json`),JSON.stringify({version:browser.version(),errors,compiled,states,cascadeProbes,rules},null,2));
    console.log(JSON.stringify({phase,version:browser.version(),errors,compiled:compiled.length,states:states.map(s=>({width:s.width,preference:s.preference,targets:s.elements.slice(0,3)}))},null,2));
  } finally { await browser.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
