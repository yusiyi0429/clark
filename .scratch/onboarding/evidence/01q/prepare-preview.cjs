const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();
const preview = path.join(root, 'apps/web-01q');
const modules = {
  foundation: 'components/onboarding/foundation.module.css',
  ...Object.fromEntries(['access', 'confirm-dialog', 'conversation-dock', 'notifications', 'anchor-editor', 'app-shell', 'account-menu', 'header-capsule', 'conversation-column', 'meeting-header', 'material-tabs', 'monthly-workspace', 'home-board'].map(name => [name, `styles/${name}.module.css`])),
};
const imports = Object.entries(modules).map(([name, file], i) => `import m${i} from '@/` + file + `';`).join('\n');
const maps = Object.keys(modules).map((name, i) => `${JSON.stringify(name)}:m${i}`).join(',');
const source = `${imports}
export default function TransparencyEvidence() {
  const modules = {${maps}};
  return <main style={{padding: 32}}>
    <h1>01q CSS compilation fixture</h1>
    <p>Unmodified application CSS modules, compiled by Next / Turbopack.</p>
    <div id="module-map" data-modules={JSON.stringify(modules)} />
    <div id="foundation-glass" className={m0.glass} style={{padding:24}}>Onboarding glass</div>
    <input id="access-codeCell" className={m1.codeCell} aria-label="Code cell" defaultValue="1" />
    <div id="access-passwordField" className={m1.passwordField}><input aria-label="Password" className={m1.passwordInput} /></div>
  </main>;
}
`;
const route = path.join(preview, 'src/app/evidence-01q');
fs.mkdirSync(route, {recursive:true});
fs.writeFileSync(path.join(route, 'page.tsx'), source);
fs.writeFileSync(path.join(__dirname, 'fixture-page.tsx.txt'), source);
fs.writeFileSync(path.join(__dirname, 'source-audit.json'), JSON.stringify(Object.entries(modules).map(([name, file]) => ({name, file, matches:fs.readFileSync(path.join(root,'apps/web/src',file),'utf8').split('\n').flatMap((text,i) => /backdrop-filter\s*:\s*none|prefers-reduced-transparency/.test(text) ? [{line:i+1,text}] : [])})),null,2));
console.log('Prepared isolated fixture; no API or database required.');
