const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const fs = require('node:fs'); const path = require('node:path');
const passcode = /口令都是 `(\d{4})`/.exec(fs.readFileSync(path.join(__dirname, '../../manual-test/README.md'), 'utf8'))[1];
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    const page = await ctx.newPage(); page.setDefaultNavigationTimeout(120000);
    await page.goto('http://localhost:3500/access');
    await page.evaluate(async (p) => fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginId: 'browsermember', passcode: p }) }), passcode);
    await page.goto('http://localhost:3500/welcome'); await page.waitForLoadState('networkidle'); await page.waitForTimeout(1200);
    for (let i = 0; i < 3; i++) { await page.getByRole('button', { name: /^(开始|下一步)/ }).first().click(); await page.waitForTimeout(900); }
    await page.waitForTimeout(4000);
    await page.screenshot({ path: path.join(__dirname, `onb-member-mission-final-${w}.png`) });
    if (w === 390) { await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await page.waitForTimeout(500); await page.screenshot({ path: path.join(__dirname, `onb-member-mission-final-${w}-bottom.png`) }); }
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
