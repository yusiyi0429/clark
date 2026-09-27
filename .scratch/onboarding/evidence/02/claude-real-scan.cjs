// 以孙铭泽身份经正式接口改设置并触发一次真实扫描（全网模式），然后等扫描结束。
const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const root = 'http://localhost:3500';
const [directions] = [process.argv.slice(2)];
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(root + '/access');
    const result = await page.evaluate(async (dirs) => {
      const login = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginId: 'browsermember', passcode: '8742' }) });
      const put = await fetch('/api/me/radar', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, directions: dirs, sources: [] }) });
      const scan = await fetch('/api/me/radar/scan', { method: 'POST' });
      return { login: login.status, put: put.status, scan: scan.status, scanBody: await scan.text() };
    }, directions);
    console.log(JSON.stringify(result));
  } finally { await browser.close(); }
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const inspect = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'radar-control.cjs'), 'inspect'], { encoding: 'utf8' })).result;
    const run = inspect.radar.find((row) => row.person_id === 'sun-mingze').last_run;
    if (run && (run.status === 'completed' || run.status === 'failed')) {
      console.log(JSON.stringify({ run, real: inspect.signals.filter((s) => !/example-|radar02/.test(s.source_url)).map((s) => ({ relevance: s.relevance, type: s.source_type, direction: s.direction_text, summary: s.summary, reason: s.reason, url: s.source_url })), company: { signals: inspect.company.signals, issues: inspect.company.issues } }, null, 1));
      return;
    }
    await new Promise((done) => setTimeout(done, 3000));
  }
  console.log('scan did not finish within 150s');
})().catch((error) => { console.error(error.stack); process.exit(1); });
