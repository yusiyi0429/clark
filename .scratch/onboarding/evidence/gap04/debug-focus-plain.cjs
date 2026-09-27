const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const root = 'http://localhost:3500';
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(root + '/access');
  await page.evaluate(async () => (await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginId: 'browserdri', passcode: '8742' }) })).status);
  await page.goto(root + '/me');
  await page.waitForLoadState('networkidle'); await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /查看详情：白田田的 10 月 Mission Card/ }).first().click();
  await page.waitForURL(/mission-cards/); await page.waitForTimeout(900);
  console.log('plain-open', JSON.stringify(await page.evaluate(() => ({ closeView: document.activeElement?.hasAttribute('data-close-view'), tag: document.activeElement?.tagName }))));
  await browser.close();
})();
