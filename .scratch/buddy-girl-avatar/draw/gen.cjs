// 生成：draw.cjs 的画 → ../girl.svg（能直接打开看的整张图）和 ../girlArt.ts（和 milesArt.ts 同格式，接入时放到 components/coagent/ 旁边）。
// 用法：node .scratch/buddy-girl-avatar/draw/gen.cjs
const fs = require("fs");
const path = require("path");
const { drawGirl } = require("./draw.cjs");

/** 和 Miles 完全相同：同一坐标系、同一缩放（figureWidth 沿用 Miles 帽檐尖到右耳的 773，当作两人共用的比例尺），胶囊和人的位置一样。 */
const ART = { viewBox: "20 140 860 1080", torsoCx: 447, lipY: 900, figureWidth: 773, topY: 167, gazeUnit: 15 };

const inner = drawGirl();
if (/[`\\]|\$\{/.test(inner)) throw new Error("画里出现了模板字符串要转义的字符");
const out = path.join(__dirname, "..");
fs.writeFileSync(path.join(out, "girl.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${ART.viewBox}" width="860" height="1080">${inner.replaceAll("{id}", "girl")}</svg>\n`);
fs.writeFileSync(path.join(out, "girlArt.ts"), `/**
 * 女伙伴形象的画：八字刘海 + 齐肩外翻、奶茶棕（2026-11-03 设计稿，待定稿）。
 * 和 Miles 同一坐标系、同一套 data-part（头、身子、比耶的手、眼睛、嘴，闭眼和张嘴是默认藏着的变体），milesRig 的动作原样能用。
 * 脸、眼睛、腮红、右耳和耳机、手、身子取自 Miles；新画的是头发、睫毛、泪痣，T 恤换浅蓝。
 * 比耶的手放在最上层、用 T 恤的剪影遮住（id 为 {id}-hand 的遮罩），所以在头发前面、衣服后面，放下时照样滑到衣服后面。
 * 渐变和遮罩的 id 写成 \`{id}-…\`，挂的时候换成每一颗自己的前缀，同一页上两颗不会互相借。
 *
 * 由 .scratch/buddy-girl-avatar/draw/gen.cjs 生成；改画时改 draw/draw.cjs 再重新生成，别在这里手改路径。
 */

/** 摆位用的几个量：和 MILES_ART 完全相同，两颗胶囊里的人一样大、胶囊在同一个位置。 */
export const GIRL_ART = ${JSON.stringify(ART).replace(/"(\w+)":/g, "$1: ").replace(/,(?=\w)/g, ", ").replace(/^\{/, "{ ").replace(/\}$/, " }")} as const;

export const GIRL_SVG = \`${inner}\`;
`);
console.log("girl.svg / girlArt.ts written,", inner.length, "chars");
