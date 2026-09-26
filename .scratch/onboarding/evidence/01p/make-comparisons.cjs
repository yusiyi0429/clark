// Render comparison sheets from unmodified browser captures; preserve all originals.
const { chromium } = require('C:/Users/10021/AppData/Local/ms-playwright-go/1.50.1/package');
const fs=require('node:fs');const path=require('node:path');
const rows=[
  ['01-destination','01 · 主按钮落点','bug-destination'],
  ['02-disabled','02 · 禁用态与原因','voice-disabled'],
  ['03-capsule','03 · 胶囊材质','hello'],
  ['04-blue','04 · 锁屏晨光蓝色调','lock'],
  ['05-composition','05 · 纵向构图','hello'],
  ['06-completion','06 · 收尾进度','finish'],
  ['07-substrate','07 · html/body 底色（临时隐藏画布的诊断图）','substrate'],
  ['north-choice','北斗试作 / 最终圆点','finish','trial'],
  ['03-listening','03 · 录音时的胶囊','recording'],
  ['04-welcome-blue','04 · 引导晨光蓝色调','hello'],
];
(async()=>{const browser=await chromium.connectOverCDP(process.argv[2]);const context=await browser.newContext();const page=await context.newPage();let sections=[];
for(const [name,title,state,first='before'] of rows){for(const [size,width,height] of [['desktop',1440,900],['phone',375,812]]){
  const a=`${first}-${state}-${size}.png`,b=`after-${state}-${size}.png`;
  const labelA=first==='trial'?'A · 北斗 144×60':'改前';const labelB=first==='trial'?'B · 圆点（最终选择）':'改后';
  const image=file=>'data:image/png;base64,'+fs.readFileSync(path.join(__dirname,file)).toString('base64');
  const content=`<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:24px;background:#e9eef5;font-family:"Microsoft YaHei",sans-serif;color:#17171b}h1{font-size:20px;font-weight:600;margin:0 0 20px}section{display:flex;gap:24px}figure{margin:0}figcaption{font-size:16px;margin-bottom:12px}img{display:block;width:${width}px;height:${height}px;border-radius:8px}</style><h1>${title} · ${size}</h1><section><figure><figcaption>${labelA}</figcaption><img src="${image(a)}"></figure><figure><figcaption>${labelB}</figcaption><img src="${image(b)}"></figure></section>`;
  await page.setViewportSize({width:width*2+72,height:height+130});await page.setContent(content);await page.evaluate(()=>Promise.all([...document.images].map(i=>i.decode())));
  await page.screenshot({path:path.join(__dirname,`compare-${name}-${size}.png`),fullPage:true});
  sections.push(`<article><h2>${title} · ${size}</h2><a href="compare-${name}-${size}.png"><img src="compare-${name}-${size}.png"></a><p><a href="${a}">${labelA}原图</a> · <a href="${b}">${labelB}原图</a></p></article>`);
}}
fs.writeFileSync(path.join(__dirname,'comparison-index.html'),`<!doctype html><meta charset="utf-8"><title>01p 前后对照</title><style>body{max-width:1500px;margin:40px auto;padding:0 24px;font-family:system-ui;background:#f7f9fc;color:#17171b}h1{font-size:32px}h2{font-size:20px}article{margin:40px 0}img{max-width:100%;border-radius:16px}a{color:#246ddf}</style><h1>TKOS · 01p 打磨对照</h1><p>左侧为改前 / 北斗试作；右侧为最终版本。点击图片查看原尺寸。</p>${sections.join('')}`);
await context.close();await browser.close();console.log('20 comparison sheets and HTML index created');})().catch(e=>{console.error(e.message);process.exitCode=1;});
