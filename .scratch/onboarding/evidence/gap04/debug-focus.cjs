const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const root = 'http://localhost:3500';
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(root + '/access');
  await page.evaluate(async () => (await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginId: 'browserdri', passcode: '8742' }) })).status);
  const describe = () => page.evaluate(() => { const el = document.activeElement; return { tag: el?.tagName, label: el?.getAttribute('aria-label'), closeView: el?.hasAttribute('data-close-view'), html: el?.outerHTML.slice(0, 160), inCorrection: el?.closest('article[id^="correction-"]')?.id ?? null }; });
  await page.goto(root + '/me');
  await page.waitForLoadState('networkidle'); await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /条更正申请待你处理/ }).first().click();
  await page.waitForURL(/\?correction=/);
  for (const ms of [50, 300, 800, 1500]) { await page.waitForTimeout(ms); console.log('via-notice', ms, JSON.stringify(await describe())); }
  const url = page.url();
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  for (const ms of [300, 1500]) { await page.waitForTimeout(ms); console.log('direct-load', ms, JSON.stringify(await describe())); }
  await browser.close();
})();
