const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const path = require('node:path'); const url = require('node:url');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(url.pathToFileURL(path.join(__dirname, 'variants.html')).href);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(__dirname, 'variants-2x.png'), fullPage: true });
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
