// 自查：girlArt.ts 能不能原样挂进 milesRig（和 milesCapsule.test.tsx 对 Miles 的检查同一套），眼珠是不是裁在眼眶里，以及摆位常量和 Miles 是否一致。
// 用法：node .scratch/buddy-girl-avatar/check.cjs [path/to/milesArt.ts]（给了 milesArt.ts 就顺带比对摆位常量）
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
ok(/<\w+ data-part="mouth"(?! display="none")[^>]*>/.test(svg) && /data-part="mouth-open" display="none"/.test(svg), "平时的嘴露着、说话张嘴的变体默认藏着");
ok(/data-part="eye-l-closed" display="none"/.test(svg) && /data-part="eye-r-closed" display="none"/.test(svg), "闭眼变体默认藏着");
const grab = (s, part) => { const i = s.indexOf(`data-part="${part}"`); const open = s.lastIndexOf("<", i); const tag = s.slice(open + 1).match(/^\w+/)[0]; if (tag !== "g") return s.slice(open, s.indexOf(">", i) + 1); let depth = 0, j = open; const re = /<(\/?)g\b[^>]*>/g; re.lastIndex = open; let mm; while ((mm = re.exec(s))) { depth += mm[1] ? -1 : 1; if (depth === 0) { j = re.lastIndex; break; } } return s.slice(open, j); };
for (const side of ["l", "r"]) {
  ok(new RegExp(`<g clip-path="url\\(#\\{id\\}-[^"]+\\)"><g data-part="iris-${side}">`).test(grab(svg, `eye-${side}`)), `眼珠 iris-${side} 在 eye-${side} 里、套着眼眶的裁切：转眼只移眼珠，眨眼整只合上`);
}
const milesArtPath = process.argv[2];
if (milesArtPath && fs.existsSync(milesArtPath)) {
  const m = fs.readFileSync(milesArtPath, "utf8");
  const milesArt = m.match(/export const MILES_ART = (\{.*?\}) as const;/)[1];
  ok(milesArt.replace(/\s/g, "") === art.replace(/\s/g, ""), `摆位常量和 MILES_ART 一致：${art}`);
} else {
  console.log("（没给 milesArt.ts，跳过和 Miles 的摆位常量比对）");
}
console.log(failed ? `\n${failed} 项没过` : "\n全部通过");
process.exit(failed ? 1 : 0);
