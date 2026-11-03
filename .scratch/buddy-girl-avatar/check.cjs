// 自查：girlArt.ts 能不能原样挂进 milesRig（和 milesCapsule.test.tsx 对 Miles 的检查同一套），以及和 Miles 的摆位常量一致。
// 用法：node .scratch/buddy-girl-avatar/check.cjs [path/to/milesArt.ts]（给了 milesArt.ts 就顺带比对常量和复用部件）
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "girlArt.ts"), "utf8");
const readSvg = (text, name) => { const m = text.match(new RegExp(`export const ${name} = (\`[^\`]*\`|".*");`, "s"))[1]; return m[0] === "`" ? m.slice(1, -1) : JSON.parse(m); };
const svg = readSvg(src, "GIRL_SVG");
const art = src.match(/export const GIRL_ART = (\{.*?\}) as const;/)[1];
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failed++; };

for (const part of ["head", "body", "arm-peace", "eye-l", "eye-r", "eye-l-closed", "eye-r-closed", "mouth", "mouth-open", "airpod-r"]) {
  ok(svg.includes(`data-part="${part}"`), `有动画要用的部件 ${part}`);
}
ok(!/\sid="(?!\{id\}-)/.test(svg), "所有 id 都是 {id}- 前缀");
ok(!/url\(#(?!\{id\}-)/.test(svg), "所有 url(#…) 都指向 {id}- 前缀");
for (const [name, pivot] of [["head", "444 806"], ["body", "388 1182"], ["arm-peace", "268 912"]]) {
  ok(new RegExp(`data-part="${name}" data-pivot="${pivot}"`).test(svg) || new RegExp(`data-pivot="${pivot}"[^>]*data-part="${name}"`).test(svg) || svg.includes(`data-part="${name}" data-pivot="${pivot}"`), `${name} 的转轴和 Miles 相同（${pivot}）`);
}
ok(/<path data-part="mouth"[^>]*>/.test(svg) && /data-part="mouth-open" display="none"/.test(svg), "平时闭嘴、张嘴变体默认藏着");
const milesArtPath = process.argv[2];
if (milesArtPath && fs.existsSync(milesArtPath)) {
  const m = fs.readFileSync(milesArtPath, "utf8");
  const milesArt = m.match(/export const MILES_ART = (\{.*?\}) as const;/)[1];
  ok(milesArt.replace(/\s/g, "") === art.replace(/\s/g, ""), `摆位常量和 MILES_ART 一致：${art}`);
  const milesSvg = readSvg(m, "MILES_SVG");
  const grab = (s, part) => { const i = s.indexOf(`data-part="${part}"`); const open = s.lastIndexOf("<", i); const tag = s.slice(open + 1).match(/^\w+/)[0]; if (tag !== "g") return s.slice(open, s.indexOf(">", i) + 1); let depth = 0, j = open; const re = /<(\/?)g\b[^>]*>/g; re.lastIndex = open; let mm; while ((mm = re.exec(s))) { depth += mm[1] ? -1 : 1; if (depth === 0) { j = re.lastIndex; break; } } return s.slice(open, j); };
  for (const part of ["face", "ear-r", "airpod-r", "blush-l", "blush-r", "nose", "mouth", "mouth-open", "arm-peace", "neck", "arm-r"]) {
    ok(grab(svg, part) === grab(milesSvg, part), `${part} 和 Miles 逐字相同`);
  }
} else {
  console.log("（没给 milesArt.ts，跳过和 Miles 的逐字比对）");
}
console.log(failed ? `\n${failed} 项没过` : "\n全部通过");
process.exit(failed ? 1 : 0);
