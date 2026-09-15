import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:3120';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox','--disable-dev-shm-usage'] });
const ctx = await b.newContext();
const page = await ctx.newPage();

const errs = [], rpc = [];
page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
page.on('pageerror', e => errs.push('PAGEERROR: ' + String(e).slice(0, 160)));
page.on('response', async r => {
  if (r.url().includes('/api/data')) {
    let m = '?';
    try { m = JSON.parse(r.request().postData() || '{}').method; } catch {}
    rpc.push(`${r.status()} ${m}`);
  }
});

const check = async (path, mustSee) => {
  rpc.length = 0;
  await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(800);
  const txt = await page.evaluate(() => document.body.innerText);
  const hits = mustSee.filter(s => txt.includes(s));
  const bad = rpc.filter(r => !r.startsWith('200'));
  console.log(`\n${path}`);
  console.log(`  RPC ${rpc.length} 次${bad.length ? '，失败: ' + bad.join(', ') : '，全部 200'}`);
  console.log(`  内容命中 ${hits.length}/${mustSee.length}: ${hits.join(' / ') || '(无)'}`);
  console.log(`  正文长度 ${txt.length}`);
  if (hits.length < mustSee.length) {
    console.log(`  缺失: ${mustSee.filter(s => !txt.includes(s)).join(', ')}`);
    console.log(`  正文片段: ${txt.slice(0, 200).replace(/\n+/g, ' | ')}`);
  }
  return hits.length === mustSee.length && bad.length === 0;
};

let ok = true;
ok &= await check('/', ['潜在议题']);
ok &= await check('/signals', ['潜在议题']);
ok &= await check('/issues', ['议题']);
ok &= await check('/issues/ISS-101', ['探讨链路']);
ok &= await check('/signals/ISS-101', []);
ok &= await check('/outcomes', []);
ok &= await check('/docs', []);

// 写操作走一遍：新增议题后列表要变
console.log('\n=== 写操作（浏览器里真点一次）===');
await page.goto(BASE + '/issues', { waitUntil: 'networkidle' });
const added = await page.evaluate(async () => {
  const r = await fetch('/api/data', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'addIssue', args: ['浏览器端写入测试'] }),
  });
  return (await r.json()).ok;
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const seen = (await page.evaluate(() => document.body.innerText)).includes('浏览器端写入测试');
console.log(`  addIssue ok=${added}  刷新后列表可见=${seen}`);

console.log(`\n=== 控制台错误 ${errs.length} 条 ===`);
errs.slice(0, 8).forEach(e => console.log('  ' + e));
console.log(`\n总判定: ${ok && added && seen ? 'PASS' : 'FAIL'}`);
await b.close();
