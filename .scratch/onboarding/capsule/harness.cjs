// 把真实的 foundation.module.css 原样套在和 CoAgentCapsule 一样的 DOM 上截图（静止、前进一步中途、手机尺寸）。
const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const fs = require('node:fs'); const path = require('node:path');
const css = fs.readFileSync('C:/Users/10021/Desktop/clark/Tianshu-MVP/apps/web/src/components/onboarding/foundation.module.css', 'utf8');
const capsule = (ack) => `<div class="capsule"><div class="capsuleGlass" data-state="idle" data-acknowledge="${ack}"><div class="${ack ? 'acknowledge' : 'capsuleBody'}"><span class="sheen"></span><span class="idleLight"></span><span class="ambientLight"></span><span class="cyanLightSpot"></span></div></div></div>`;
const html = (ack) => `<!doctype html><html><head><meta charset="utf-8"><style>
:root { --onboarding-pill-radius: 999px; --onboarding-ease: cubic-bezier(.32,.72,0,1); --onboarding-ease-brand: cubic-bezier(.22,1,.36,1); }
body { margin: 0; height: 100vh; display: grid; place-items: center; background: radial-gradient(90% 70% at 30% 0%, #dfe9ff 0%, transparent 60%), #f4f7fd; }
${css}</style></head><body>${capsule(ack)}</body></html>`;
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const [w, h, tag] of [[600, 260, 'desktop'], [390, 200, 'phone']]) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    await page.setContent(html(false)); await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(__dirname, `real-idle-${tag}.png`) });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(__dirname, `real-idle2-${tag}.png`) });
    await page.setContent(html(true)); await page.waitForTimeout(550);
    await page.screenshot({ path: path.join(__dirname, `real-ack-${tag}.png`) });
    await page.close();
  }
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
