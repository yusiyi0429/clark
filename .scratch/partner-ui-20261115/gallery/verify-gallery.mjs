// Static/Node verification only. This does not launch or emulate a browser.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(dir, 'review.html'), 'utf8');
const data = /<script id="gallery-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
assert(data, 'Embedded JSON payload exists');
const payload = JSON.parse(data[1]);
const evidence = JSON.parse(fs.readFileSync(path.join(dir, 'evidence.json'), 'utf8'));
const repo = path.resolve(dir, '../../..');
const manifestChecks = {};
for (const [version, sourceRoot] of [['baseline', path.join(dir, 'baseline-source/apps/web/src')], ['current', path.join(repo, 'apps/web/src')]]) {
  const record = evidence[version];
  const hashes = { ...record.sourceHashes,
    ...Object.fromEntries(Object.entries(record.bundledSourceModules).map(([file, value]) => [file, value.sha256])),
    ...Object.fromEntries(Object.entries(record.integrationModuleCoverage).map(([file, value]) => [file, value.sha256])) };
  for (const [file, expected] of Object.entries(hashes)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(sourceRoot, file))).digest('hex');
    assert.equal(actual, expected, `${version}/${file}: final source matches evidence`);
  }
  manifestChecks[version] = Object.keys(hashes).length;
}
const scripts = [...html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length, 1);
const script = new vm.Script(scripts[0][1], { filename: 'review.html inline UI script' });
assert(!/<(?:script|link|img)\b[^>]*\b(?:src|href)="(?:https?:|file:|[A-Za-z]:|\/)/i.test(html), 'Outer HTML has no external asset requirements');
assert(/iframe\{box-sizing:content-box;/.test(html), 'Viewport size does not include the iframe border');

let scenes = 0, disabledControls = 0, inertLinks = 0;
for (const [version, view] of Object.entries(payload)) {
  assert(!/@import\b/.test(view.css), `${version}: no unresolved CSS imports`);
  for (const match of view.css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) {
    assert(/^(?:data:|#)/.test(match[2]), `${version}: CSS external URL: ${match[2]}`);
  }
  assert(view.css.includes('--paper:') && view.css.includes('data-color-scheme="dark"'), `${version}: original tokens and dark selector included`);
  for (const [key, scene] of Object.entries(view.scenes)) {
    scenes++;
    assert(scene.length > 300, `${version}/${key}: actual rendered scene exists`);
    assert(!/<a\b[^>]*\shref=/i.test(scene), `${version}/${key}: all original links are inert`);
    assert(!/<script\b/i.test(scene), `${version}/${key}: no application runtime`);
    for (const match of scene.matchAll(/<(?:button|input|textarea|select)\b[^>]*>/g)) {
      assert(/\sdisabled(?:=|\s|>)/.test(match[0]), `${version}/${key}: active control: ${match[0]}`);
      disabledControls++;
    }
    inertLinks += (scene.match(/\sdata-fixture-href=/g) || []).length;
  }
}
assert.equal(scenes, 10);

// Run the actual gallery's inline controller against a minimal DOM boundary stub.
// This checks serialization, selectors, switch wiring and iframe documents, not layout or interaction acceptance.
const nodes = new Map();
const element = (id, value = '') => {
  const node = { value, style: {}, textContent: '', listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; } };
  nodes.set(id, node); return node;
};
element('gallery-data').textContent = data[1];
element('scene', 'sent'); element('width', '720'); element('scheme', 'light');
for (const id of ['caption', 'before', 'after', 'before-notes', 'after-notes', 'open', 'reset']) element(id);
const context = vm.createContext({ document: { getElementById: (id) => { assert(nodes.has(id), `Unknown DOM ID ${id}`); return nodes.get(id); } } });
script.runInContext(context);
let configurations = 0;
for (const scene of Object.keys(payload.after.scenes)) for (const width of ['320', '720']) for (const scheme of ['light', 'dark']) {
  nodes.get('scene').value = scene; nodes.get('width').value = width; nodes.get('scheme').value = scheme;
  vm.runInContext('draw()', context);
  for (const version of ['before', 'after']) {
    const frame = nodes.get(version);
    assert.equal(frame.style.width, width + 'px');
    assert(frame.srcdoc.startsWith('<!doctype html>'));
    assert(frame.srcdoc.includes(`data-color-scheme="${scheme}"`) && frame.srcdoc.includes('data-scheme="auto"'));
    assert(frame.srcdoc.includes(payload[version].scenes[scene]));
    assert(!frame.srcdoc.includes('<script'));
    configurations++;
  }
}
const result = { verifiedAt: new Date().toISOString(), htmlBytes: Buffer.byteLength(html), renderedVersionScenes: scenes,
  constructedDocuments: configurations, disabledControls, inertLinks, unresolvedExternalAssetUrls: 0,
  sourceHashesMatched: manifestChecks,
  browserRun: false, limits: 'Static HTML/JSON/CSS checks and Node VM controller with DOM boundary stubs only. No browser rendering, layout, screenshots, native-details interaction, focus, mobile or assistive technology acceptance.' };
fs.writeFileSync(path.join(dir, 'verification.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
