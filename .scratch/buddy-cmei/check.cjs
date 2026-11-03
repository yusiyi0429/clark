// 自查：cmeiArt.ts 能不能挂进 milesRig（部件、id 前缀、转轴、默认藏着的变体），眼珠是不是裁在眼眶里，摆位常量除 gazeUnit 外是否和 Miles 一致。
// 用法：node .scratch/buddy-cmei/check.cjs [path/to/milesArt.ts]
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "cmeiArt.ts"), "utf8");
const svg = src.match(/export const CMEI_SVG = `([^`]*)`;/)[1];
const art = src.match(/export const CMEI_ART = (\{.*?\}) as const;/)[1];
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failed++; };

for (const part of ["head", "body", "arm-peace", "eye-l", "eye-r", "eye-l-closed", "eye-r-closed", "mouth", "mouth-open", "airpod-r", "iris-l", "iris-r"]) {
  ok(svg.includes(`data-part="${part}"`), `有动画要用的部件 ${part}`);
}
ok(!/\sid="(?!\{id\}-)/.test(svg), "所有 id 都是 {id}- 前缀");
ok(!/url\(#(?!\{id\}-)/.test(svg), "所有 url(#…) 都指向 {id}- 前缀");
ok(/[`\\]|\$\{/.test(svg) === false, "画里没有模板字符串要转义的字符");
for (const [name, pivot] of [["head", "444 806"], ["body", "388 1182"], ["arm-peace", "447 860"]]) {
  ok(svg.includes(`data-part="${name}" data-pivot="${pivot}"`), `${name} 的转轴是 ${pivot}`);
}
ok(svg.indexOf('data-part="body"') < svg.indexOf('data-part="head"') && svg.indexOf('data-part="head"') < svg.indexOf('data-part="arm-peace"'), "body 套着 head（侧头和呼吸带着整个上半身），手在最上面");
ok(/<g data-part="mouth">/.test(svg) && /data-part="mouth-open" display="none"/.test(svg), "平时的嘴露着、说话张嘴的变体默认藏着");
ok(/data-part="eye-l-closed" display="none"/.test(svg) && /data-part="eye-r-closed" display="none"/.test(svg), "闭眼变体默认藏着");
for (const side of ["l", "r"]) {
  ok(new RegExp(`<g data-part="eye-${side}">.*?<g clip-path="url\\(#\\{id\\}-[^"]+\\)"><g data-part="iris-${side}">`).test(svg), `眼珠 iris-${side} 在 eye-${side} 里、套着眼眶的裁切`);
}
ok(/"gazeUnit":\s*7|gazeUnit: 7/.test(art), `gazeUnit 是 7：${art}`);
const milesArtPath = process.argv[2];
if (milesArtPath && fs.existsSync(milesArtPath)) {
  const m = fs.readFileSync(milesArtPath, "utf8").match(/export const MILES_ART = (\{.*?\}) as const;/)[1];
  const norm = (s) => s.replace(/\s/g, "").replace(/gazeUnit:\d+/, "");
  ok(norm(m) === norm(art), "除 gazeUnit 外，摆位常量和 MILES_ART 一致（胶囊里一样大、一样的位置）");
} else {
  console.log("（没给 milesArt.ts，跳过摆位常量的比对）");
}
console.log(failed ? `\n${failed} 项没过` : "\n全部通过");
process.exit(failed ? 1 : 0);
