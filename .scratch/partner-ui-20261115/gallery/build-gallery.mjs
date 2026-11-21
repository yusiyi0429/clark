import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as fixtures from './fixtures.mjs';

const gallery = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(gallery, '../../..');
const web = path.join(repo, 'apps/web');
const fromWeb = createRequire(path.join(web, 'package.json'));
const vitestRequire = createRequire(fromWeb.resolve('vitest/package.json'));
const viteRequire = createRequire(vitestRequire.resolve('vite'));
const esbuild = viteRequire('esbuild');
const tailwindRequire = createRequire(fromWeb.resolve('@tailwindcss/postcss'));
const postcss = tailwindRequire('postcss');
const tailwind = fromWeb('@tailwindcss/postcss');
const baselineRef = process.env.GALLERY_BASELINE_REF || 'a1f365a1';
const baseline = path.join(gallery, 'baseline-source');
const currentSrc = path.join(web, 'src');
fs.mkdirSync(baseline, { recursive: true });
const archive = path.join(gallery, 'baseline-source.tar');
// Never switch the worktree or read real business data. Materialize Git source only.
execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, baselineRef, 'apps/web/src'], { cwd: repo });
execFileSync('tar', ['-xf', archive, '-C', baseline]);
const baselineSrc = path.join(baseline, 'apps/web/src');
const js = (value) => JSON.stringify(value);
const fixtureFile = path.join(gallery, 'fixtures.mjs').replaceAll('\\', '/');
const sourceFiles = [
  'components/home/PartnerTeamCard.tsx', 'components/home/partnerTeam.module.css',
  'components/home/PartnerMeetings.tsx', 'components/home/partner-meetings.module.css',
  'components/meeting/MeetingWorkHandoffs.tsx', 'components/meeting/meeting-work-handoffs.module.css',
  'components/home/WorkIntake.tsx', 'components/home/work-intake.module.css',
  'components/home/SubSessionSummary.tsx', 'styles/sub-session-summary.module.css',
  'app/globals.css', 'app/heroui-tianshu.css', 'app/scheme-dark.css',
];
const integrationFiles = ['conversation/Transcript.tsx', 'components/work/WorkTimeline.tsx'];
const sourceHashes = (src) => Object.fromEntries(sourceFiles.filter(f => fs.existsSync(path.join(src, f))).map(f => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(src, f))).digest('hex')]));

async function globals(src) {
  // Compile the genuine app global stylesheet with its existing Tailwind/PostCSS dependency.
  // A temporary sibling is unnecessary: dependencies resolve from the installed app modules.
  let text = fs.readFileSync(path.join(src, 'app/globals.css'), 'utf8');
  const imports = ['tailwindcss', 'tw-animate-css', '@heroui/styles'];
  for (const spec of imports) {
    const packageRoot = path.join(web, 'node_modules', spec);
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const stylesheet = pkg.exports?.['.']?.style || pkg.style || pkg.main;
    text = text.replaceAll(`"${spec}"`, js(path.join(packageRoot, stylesheet).replaceAll('\\', '/')));
  }
  const result = await postcss([tailwind({ base: web, optimize: false })]).process(text, { from: path.join(src, 'app/globals.css') });
  if (/@(?:import|theme|apply|utility)\b/.test(result.css)) throw new Error('Uncompiled global stylesheet directive remains');
  return result.css;
}

async function renderVersion(name, src) {
  const initialSourceHashes = sourceHashes(src);
  const dir = path.join(gallery, `.build-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const edits = [];
  const build = await esbuild.build({
    entryPoints: [path.join(gallery, 'entry.tsx')], outdir: dir, entryNames: 'ssr', outExtension: { '.js': '.mjs' }, bundle: true,
    platform: 'node', format: 'esm', jsx: 'automatic', target: 'node24', metafile: true, logLevel: 'warning',
    alias: { '@': src }, nodePaths: [path.join(web, 'node_modules'), path.join(repo, 'node_modules')],
    loader: { '.module.css': 'local-css', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl' },
    banner: { js: 'import { createRequire as __galleryCreateRequire } from "node:module"; const require = __galleryCreateRequire(import.meta.url);' },
    plugins: [{ name: 'controlled-fixtures-only', setup(build) {
      build.onResolve({ filter: /(?:^@\/lib\/home\/partnerMeetingFeed$|[\\/]lib[\\/]home[\\/]partnerMeetingFeed$)/ }, () => ({ path: 'meeting-feed', namespace: 'gallery-fixture' }));
      build.onResolve({ filter: /^(?:@\/components\/shell\/WorkspaceContext)$/ }, () => ({ path: 'workspace', namespace: 'gallery-fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'gallery-fixture' }, args => ({ contents: args.path === 'meeting-feed'
        ? `import { meetings } from ${js(fixtureFile)}; export function usePartnerMeetings(){return {items:meetings,error:null,reload(){}}}; export function PartnerMeetingsProvider({children}){return children}`
        : 'export function useWorkspace(){return {navigate(){},viewerId:"fixture-me",homeCards:[],showToast(){},compose(){},registerDetail(){},close(){},detailOpen:false,closing:false,quote(){}}};', loader: 'js', resolveDir: gallery }));
      build.onLoad({ filter: /(?:WorkIntake|MeetingWorkHandoffs)\.tsx$/ }, args => {
        let contents = fs.readFileSync(args.path, 'utf8');
        const replace = (literal, replacement) => {
          if (contents.split(literal).length !== 2) throw new Error(`${name}: expected exactly one fixture initializer: ${literal}`);
          contents = contents.replace(literal, replacement); edits.push(path.relative(src, args.path).replaceAll('\\', '/') + ': ' + literal);
        };
        if (args.path.endsWith('WorkIntake.tsx')) replace('useState<TWorkIntakeEntry[]>([])', `useState<TWorkIntakeEntry[]>(${js(fixtures.queue)})`);
        else {
          replace('useState<TMeetingWorkHandoffs["items"]>([])', `useState<TMeetingWorkHandoffs["items"]>(${js(fixtures.handoffs)})`);
          replace('useState<TMeetingWorkTargetOption[]>([])', `useState<TMeetingWorkTargetOption[]>(${js(fixtures.targets)})`);
        }
        return { contents, loader: 'tsx', resolveDir: path.dirname(args.path) };
      });
    } }],
  });
  const module = await import(pathToFileURL(path.join(dir, 'ssr.mjs')).href + `?build=${Date.now()}`);
  const realNow = Date.now;
  let scenes;
  try { Date.now = () => Date.parse(fixtures.fixtureTime); scenes = module.renderScenes(); }
  finally { Date.now = realNow; }
  const css = await globals(src) + '\n' + fs.readFileSync(path.join(dir, 'ssr.css'), 'utf8');
  const moduleCss = fs.readFileSync(path.join(dir, 'ssr.css'), 'utf8');
  const facts = Object.fromEntries(Object.entries(scenes).map(([scene, html]) => [scene, {
    bytes: Buffer.byteLength(html), buttons: (html.match(/<button\b/g) || []).length,
    disclosures: (html.match(/<details\b/g) || []).length, openDisclosures: (html.match(/<details\b[^>]*\bopen=/g) || []).length,
    classNames: [...new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap(match => match[1].split(/\s+/)))],
  }]));
  const checks = [];
  for (const [scene, fact] of Object.entries(facts)) {
    // CSS Modules are bundled by native esbuild local-css, never mocked to empty class names.
    const localNames = fact.classNames.filter(value => /^(?:partnerTeam|partner_meetings|meeting_work_handoffs|work_intake|sub_session_summary|home)_/.test(value));
    const missing = localNames.filter(value => !moduleCss.includes('.' + value));
    if (missing.length) throw new Error(`${name}/${scene}: missing CSS rules for ${missing.join(', ')}`);
    checks.push({ scene, cssModuleClasses: localNames.length, unmatched: missing });
  }
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(build.metafile, null, 2));
  const rootPrefix = path.resolve(src).toLowerCase() + path.sep;
  const bundledSourceModules = Object.fromEntries(Object.keys(build.metafile.inputs).flatMap(input => {
    const absolute = path.resolve(repo, input);
    if (!absolute.toLowerCase().startsWith(rootPrefix) || !fs.existsSync(absolute)) return [];
    const relative = path.relative(src, absolute).replaceAll('\\', '/');
    const retainedBytes = Object.values(build.metafile.outputs).reduce((total, output) => total + (output.inputs?.[input]?.bytesInOutput || 0), 0);
    return [[relative, { sha256: crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'), retainedBytes }]];
  }));
  const integrationModuleCoverage = Object.fromEntries(integrationFiles.filter(file => fs.existsSync(path.join(src, file))).map(file => [file, {
    sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(src, file))).digest('hex'),
    importedByGallery: file in bundledSourceModules,
    retainedBytes: bundledSourceModules[file]?.retainedBytes || 0,
    fullSurfaceRendered: false,
    scope: file in bundledSourceModules ? 'Indirect source import only; isolated target component scenes do not render this complete surface.' : 'Outside gallery target modules; not imported or rendered. Hash records final source provenance only.',
  }]));
  const finalSourceHashes = sourceHashes(src);
  if (JSON.stringify(initialSourceHashes) !== JSON.stringify(finalSourceHashes)) throw new Error(`${name}: component source changed during build; rerun after edits settle`);
  return { name, scenes, css, evidence: { fixtureInitializerEdits: edits, facts, cssChecks: checks, targetSourceFiles: sourceFiles.filter(file => fs.existsSync(path.join(src, file))), sourceHashes: finalSourceHashes, bundledSourceModules, integrationModuleCoverage } };
}

const before = await renderVersion('before', baselineSrc);
const after = await renderVersion('after', currentSrc);
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const disable = html => html.replace(/<(button|input|textarea|select)\b([^>]*)>/g, (whole, tag, attrs) => `<${tag}${attrs}${/\bdisabled(?:=|\s|$)/.test(attrs) ? '' : ' disabled=""'} data-fixture-disabled="true">`)
  .replace(/<a\b([^>]*)\shref="([^"]*)"([^>]*)>/g, (_, first, href, end) => `<a${first} data-fixture-href="${href}" title="示例链接已停用；原路由：${href}" aria-disabled="true" tabindex="-1"${end}>`);
const payload = { before: { scenes: Object.fromEntries(Object.entries(before.scenes).map(([k,v]) => [k, disable(v)])), css: before.css }, after: { scenes: Object.fromEntries(Object.entries(after.scenes).map(([k,v]) => [k, disable(v)])), css: after.css } };
const stats = (v) => Object.fromEntries(Object.entries(v.evidence.facts).map(([key,value]) => [key, { buttons: value.buttons, disclosures: value.disclosures, initiallyOpen: value.openDisclosures }]));
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const evidence = { generatedAt: new Date().toISOString(), baselineRef, currentHead: head, fixtureTime: fixtures.fixtureTime,
  dependencyContext: { node: process.version, esbuild: esbuild.version, lockSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, 'pnpm-lock.yaml'))).digest('hex'), baselineDependencies: 'Both source revisions use the currently installed, unchanged dependencies.' },
  process: 'Actual React renderToStaticMarkup; esbuild local-css; original globals compiled with installed Tailwind/PostCSS. Fixture-only feed alias and initial fetched list seeds, no source file edits.',
  baseline: before.evidence, current: after.evidence,
  limits: ['No browser screenshots or visual inspection', 'No application hydration, network requests, data mutation, or production records', 'Native details markup retained; app controls disabled', 'Isolated component viewport, not complete BuddyView or application shell', '320px and dark modes are preview controls, not observed device or accessibility acceptance'] };
fs.writeFileSync(path.join(gallery, 'evidence.json'), JSON.stringify(evidence, null, 2));
fs.writeFileSync(path.join(gallery, 'scenes-before.json'), JSON.stringify(before.scenes, null, 2));
fs.writeFileSync(path.join(gallery, 'scenes-after.json'), JSON.stringify(after.scenes, null, 2));
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>伙伴工作间 · 实际组件对照</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self' about:; img-src data:; connect-src 'none'">
<style>*{box-sizing:border-box}body{margin:0;background:#f2f3f6;color:#202127;font:14px/1.65 system-ui,'Microsoft YaHei',sans-serif}.page{max-width:1560px;margin:0 auto;padding:24px}h1{font-size:23px;margin:0 0 8px;letter-spacing:-.02em}p{margin:5px 0}.lead{max-width:1080px;color:#4d5260}.banner{padding:12px 16px;border:1px solid #d7b66f;background:#fff6df;border-radius:12px;margin:16px 0}.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 0}label{display:flex;align-items:center;gap:6px}select,button{font:inherit;border:1px solid #bdc2cb;background:#fff;color:#202127;border-radius:8px;min-height:40px;padding:6px 12px}button{cursor:pointer}.comparison{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;align-items:start}.pane{min-width:0;background:#fff;border:1px solid #cdd2da;border-radius:14px;overflow:hidden}.pane h2{font-size:16px;margin:0;padding:12px 16px;background:#fafbfc;border-bottom:1px solid #dde1e8}.scroll{overflow:auto;padding:12px;max-height:80vh;background:repeating-linear-gradient(45deg,#edf0f4 0 8px,#f7f8fb 8px 16px)}iframe{box-sizing:content-box;display:block;border:1px solid #d8dce3;background:white;margin:0 auto;height:1300px;max-width:none}.notes{padding:12px 16px;border-top:1px solid #dde1e8;font-size:12px;color:#545c69}details.info{margin-top:18px;background:white;border:1px solid #d5dbe3;border-radius:12px;padding:12px 16px}.info summary{cursor:pointer;font-weight:600}.info li{margin:5px 0}.caption{font-size:13px;color:#525d6c;min-height:24px}.pill{padding:2px 8px;background:#e4e9f1;border-radius:20px;font-size:12px}@media(max-width:900px){.page{padding:14px}.comparison{grid-template-columns:1fr}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}</style></head>
<body><main class="page"><span class="pill">可离线打开 · 真实 React + CSS Modules</span><h1>伙伴工作间 · 实际组件对照</h1>
<p class="lead">同一组合成样例，比较原版与本轮源码的默认层级、内容和操作位置。每个预览是独立的 720px 或 320px 宽视口；可切换浅色和暗色，展开原生折叠区。</p>
<div class="banner"><strong>全部为虚构示例。</strong>这里没有登录、真实业务数据或网络请求。仅原生折叠区可交互；按钮与链接已停用。此文件是组件服务端渲染对照，不是浏览器截图、完整伙伴主界面或实机验收结论。</div>
<div class="toolbar"><label>场景 <select id="scene"><option value="sent">团队征集 · 多人进展</option><option value="incoming">团队来件 · 回复与澄清</option><option value="meetings">会议状态与未来安排</option><option value="handoffs">已确认变化与递送结果</option><option value="status">子会话与输入待发队列</option></select></label>
<label>视口 <select id="width"><option value="720">720px</option><option value="320">320px</option></select></label><label>外观 <select id="scheme"><option value="light">浅色</option><option value="dark">暗色</option></select></label>
<button id="open">展开全部详情</button><button id="reset">恢复默认展开状态</button></div><p class="caption" id="caption"></p>
<div class="comparison"><section class="pane"><h2>原版 · ${escape(baselineRef)}</h2><div class="scroll"><iframe id="before" title="原版实际组件" sandbox="allow-same-origin"></iframe></div><div class="notes" id="before-notes"></div></section>
<section class="pane"><h2>本轮 · 当前工作树源码</h2><div class="scroll"><iframe id="after" title="本轮实际组件" sandbox="allow-same-origin"></iframe></div><div class="notes" id="after-notes"></div></section></div>
<details class="info"><summary>对照范围、证据与尚未验证项</summary><ul>
<li>直接渲染 TeamDeliveryCard、PartnerMeetingInbox、MeetingWorkHandoffs、SubSessionSummary 和 WorkIntakeQueue。JSX 与 CSS 来自各版本源码，没有重画卡片。</li>
<li>会议 feed 使用合成数据替身；交接和队列仅在打包时将原始空列表的状态初值替换为样例。React 仍由 renderToStaticMarkup 正常运行；useEffect 不运行。</li>
<li>CSS Modules 由 esbuild 的 local-css 编译并与真实 class 对应；全局 token、HeroUI、暗色规则由现有 PostCSS/Tailwind 编译。独立容器只增加外部留白。</li>
<li>深链、回复表单、发送/重试、附件访问、网络刷新、焦点和滚动、副作用及完整 BuddyView 合并效果需在实际应用中验证。本文件不运行这些行为。</li>
<li>320px 模式确实设置 iframe 视口为 320px；未执行浏览器布局测量、截图、屏幕阅读器或手机触控测试。暗色模式使用原 html 属性及 data-scheme 选择器；不等于暗色可读性已验收。</li>
<li>基准 ${escape(baselineRef)}；当前 HEAD ${escape(head.slice(0,12))} 加工作树改动；生成时间 ${escape(evidence.generatedAt)}。样例时钟固定为 2026-11-15 04:00 UTC。</li>
</ul></details></main>
<script id="gallery-data" type="application/json">${JSON.stringify(payload).replaceAll('<','\\u003c')}</script>
<script>
const payload=JSON.parse(document.getElementById('gallery-data').textContent);
const stats=${JSON.stringify({before:stats(before),after:stats(after)})};
const notes={sent:'看点：逐人状态、需要补充与失败重试入口，历史往来默认层级。',incoming:'看点：本人回复与澄清动作是否留在首层，附件与往来按需展开。',meetings:'看点：未来安排单独折叠，会议本身时间与当前下一步，来源为二级内容。',handoffs:'看点：已确认内容、递送计数、失败原因和历史去向；未选去向不表示已递送。',status:'看点：运行、失败和等待分别计数；队列是接收/递送状态，不能当作工作已完成。'};
const base='html,body{min-height:100%;margin:0}body{background:var(--surface);color:var(--ink);font-family:var(--font-sans);font-size:var(--text-base);line-height:1.5}.fixture-stage{min-width:0;padding:16px 24px}.fixture-stage>section,.fixture-stage>details{min-width:0}a[aria-disabled=true]{cursor:default}button[data-fixture-disabled]{cursor:default}@media(max-width:360px){.fixture-stage{padding:12px}}';
function draw(){const scene=document.getElementById('scene').value,width=document.getElementById('width').value,scheme=document.getElementById('scheme').value;document.getElementById('caption').textContent=notes[scene];for(const version of ['before','after']){const frame=document.getElementById(version);frame.style.width=width+'px';const css=payload[version].css+base;frame.srcdoc='<!doctype html><html lang="zh-CN" data-theme="tianshu" data-color-scheme="'+scheme+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; style-src &apos;unsafe-inline&apos;; img-src data:; font-src data:; connect-src &apos;none&apos;"><style>'+css.replaceAll('</style','<\\/style')+'</style></head><body><main class="fixture-stage" data-scheme="auto">'+payload[version].scenes[scene]+'</main></body></html>';const s=stats[version][scene];document.getElementById(version+'-notes').textContent=width+'px · '+(scheme==='dark'?'暗色':'浅色')+' · 原始组件 '+s.buttons+' 个按钮（预览停用），'+s.disclosures+' 个折叠区，默认展开 '+s.initiallyOpen+' 个。';}}
for(const id of ['scene','width','scheme'])document.getElementById(id).addEventListener('change',draw);
document.getElementById('reset').addEventListener('click',draw);
document.getElementById('open').addEventListener('click',()=>{for(const id of ['before','after'])document.getElementById(id).contentDocument?.querySelectorAll('details').forEach(d=>d.open=true)});
draw();
</script></body></html>`;
fs.writeFileSync(path.join(gallery, 'review.html'), html);
console.log(JSON.stringify({output:path.join(gallery, 'review.html'),bytes:Buffer.byteLength(html),baselineRef,currentHead:head,scenes:Object.keys(after.scenes),before:stats(before),after:stats(after)},null,2));
