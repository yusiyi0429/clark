const fs = require('node:fs');
const path = require('node:path');
const files = fs.readdirSync(__dirname).filter(name => name.endsWith('.png')).sort();
const escape = value => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
fs.writeFileSync(path.join(__dirname, 'screenshot-index.html'), `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>04d · 浏览器截图索引</title><style>
body{margin:0;background:#f4f7fc;color:#172238;font:16px/1.6 system-ui,sans-serif}header{padding:32px;max-width:1200px;margin:auto}h1{margin:0;font-size:28px}input{padding:12px 16px;width:min(480px,90%);border:1px solid #cfdae9;border-radius:12px;background:white}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px;padding:0 32px 40px}figure{margin:0;background:white;border:1px solid #dde4ed;border-radius:16px;padding:16px;align-self:start}figcaption{font-size:13px;overflow-wrap:anywhere;margin-top:10px}img{width:100%;height:320px;object-fit:contain;object-position:top}a{color:#2468d8}[hidden]{display:none!important}
</style><header><h1>04d · Mission Card 通知与引导</h1><p>${files.length} 张原始截图 · 1440 / 834 / 390 · 点击查看原图。最后一分钟为自然计时，草稿／开放／Review／重开通知已用最终样式复核。</p><input aria-label="筛选截图" placeholder="输入 member、ceo、390、review…"></header><main>
${files.map(name => `<figure data-name="${escape(name)}"><a href="${encodeURIComponent(name)}"><img loading="lazy" src="${encodeURIComponent(name)}" alt="${escape(name)}"></a><figcaption>${escape(name)}</figcaption></figure>`).join('\n')}
</main><script>document.querySelector('input').addEventListener('input',event=>{const query=event.target.value.toLowerCase();document.querySelectorAll('figure').forEach(el=>el.hidden=!el.dataset.name.toLowerCase().includes(query))})</script></html>`);
console.log(`${files.length} screenshots indexed`);
