// 生成：draw/mia-<版本>.cjs 的画 → ../<版本>/girl.svg（能直接打开看的整张图）和 ../<版本>/girlArt.ts（和 milesArt.ts 同格式，接入时放到 components/coagent/ 旁边）。
// 两个版本：original = 照参考图的正常比例；chibi = Q 版（第五版的粉紫蓝设计重画）。
// 用法：node .scratch/buddy-girl-avatar/draw/gen.cjs original|chibi
const fs = require("fs");
const path = require("path");

const variant = process.argv[2];
if (!["original", "chibi"].includes(variant)) throw new Error("用法：node draw/gen.cjs original|chibi");
const { drawGirl, DOC } = require(`./mia-${variant}.cjs`);

/** 和 Miles 完全相同：同一坐标系、同一缩放（figureWidth 沿用 Miles 帽檐尖到右耳的 773，当作两人共用的比例尺），胶囊和人的位置一样。 */
const ART = { viewBox: "20 140 860 1080", torsoCx: 447, lipY: 900, figureWidth: 773, topY: 167, gazeUnit: 15 };

const inner = drawGirl();
if (/[`\\]|\$\{/.test(inner)) throw new Error("画里出现了模板字符串要转义的字符");
const out = path.join(__dirname, "..", variant);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "girl.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${ART.viewBox}" width="860" height="1080">${inner.replaceAll("{id}", "girl")}</svg>\n`);
const doc = [
  ...DOC.trim().split("\n"),
  "和 Miles 同一坐标系、同一套 data-part（头、身子、比耶的手、眼睛、嘴，闭眼和张嘴是默认藏着的变体），milesRig 的动作都能用。",
  "眼珠（data-part=\"iris-l/r\"）裁在钉住的眼眶里：milesRig 打上 .scratch/buddy-girl-avatar/milesRig-iris-gaze.patch 后，转眼时只移眼珠、眼眶不动；",
  "没打这个补丁时照旧整只眼睛跟着目光移。眨眼两种情况都是整只眼睛合上。",
  "比耶的手放在最上层、用上衣的剪影遮住（id 为 {id}-hand 的遮罩），所以在头发前面、衣服后面，放下时照样滑到衣服后面。",
  "渐变、裁切和遮罩的 id 写成 `{id}-…`，挂的时候换成每一颗自己的前缀，同一页上两颗不会互相借。",
  "",
  `由 .scratch/buddy-girl-avatar/draw/gen.cjs 生成；改画时改 draw/mia-${variant}.cjs 再重新生成，别在这里手改路径。`,
].map((l) => (l ? ` * ${l.replaceAll("`", "\\`")}` : " *")).join("\n");
fs.writeFileSync(path.join(out, "girlArt.ts"), `/**
${doc}
 */

/** 摆位用的几个量：和 MILES_ART 完全相同，两颗胶囊里的人一样大、胶囊在同一个位置。 */
export const GIRL_ART = ${JSON.stringify(ART).replace(/"(\w+)":/g, "$1: ").replace(/,(?=\w)/g, ", ").replace(/^\{/, "{ ").replace(/\}$/, " }")} as const;

export const GIRL_SVG = \`${inner}\`;
`);
console.log(`${variant}/girl.svg、${variant}/girlArt.ts 写好了，${inner.length} 字`);
