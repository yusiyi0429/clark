const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto('http://localhost:3500/access');
  await page.evaluate(async () => (await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginId: 'browsermember', passcode: '8742' }) })).status);
  await page.goto('http://localhost:3500/me/mission-cards/3ec3d6f3-b510-4393-a846-c7a4638e836e');
  await page.waitForLoadState('networkidle'); await page.waitForTimeout(1200);
  console.log(JSON.stringify(await page.evaluate(() => {
    const p = [...document.querySelectorAll('p')].find((el) => el.textContent.includes('月份已过，这张卡只读'));
    const next = p?.nextElementSibling;
    const cs = p && getComputedStyle(p);
    return { margin: cs?.margin, className: p?.className, gap: next ? Math.round(next.getBoundingClientRect().top - p.getBoundingClientRect().bottom) : null, parentDisplay: p && getComputedStyle(p.parentElement).display, rules: [...document.styleSheets].flatMap((sheet) => { try { return [...sheet.cssRules]; } catch { return []; } }).filter((rule) => rule.selectorText && p?.matches(rule.selectorText) && /margin/.test(rule.cssText)).map((rule) => rule.cssText.slice(0, 140)) };
  })));
  await browser.close();
})();
