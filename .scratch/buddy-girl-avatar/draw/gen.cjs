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
// 整张图的画布比摆位用的 viewBox 宽一点：两侧的长发略超出 Miles 的范围（胶囊里放得下，rig 里的画本来就不裁边）。
fs.writeFileSync(path.join(out, "girl.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="20 140 960 1080" width="960" height="1080">${inner.replaceAll("{id}", "girl")}</svg>\n`);
fs.writeFileSync(path.join(out, "girlArt.ts"), `/**
 * 女伙伴形象的画：Q 版萌系 + 萨拉芬尼式的粉紫蓝配色（2026-11-03 设计稿第五版，待定稿）。长发从头顶垂过肩膀、披在背后，发梢收尖，前发搭在肩上；
 * 圆圆的呆萌大眼睛、张嘴笑；头顶一撮呆毛、左边一个天枢 logo 形状的发夹、右边一个浅蓝蝴蝶结；白上衣，领口一个带小宝石的蝴蝶结。
 * 和 Miles 同一坐标系、同一套 data-part（头、身子、比耶的手、眼睛、嘴，闭眼和张嘴是默认藏着的变体），milesRig 的动作都能用。
 * 眼珠（data-part="iris-l/r"）裁在钉住的眼眶里：milesRig 打上同目录的 milesRig-iris-gaze.patch 后，转眼时只移眼珠、眼眶不动；
 * 没打这个补丁时照旧整只眼睛跟着目光移。眨眼两种情况都是整只眼睛合上。
 * 脸型、鼻子、耳朵和两只 AirPods、手、身子的形状取自 Miles（肤色换浅、描边换成深紫蓝）；新画的是头发、眼睛、嘴、腮红、蝴蝶结和天枢 logo 发夹。
 * 背后的长发（data-part="hair-long"）在身体后面，不跟着头转；它和头四周那层头发的接缝放在两侧竖直的外沿上，侧头时看不出来。
 * 比耶的手放在最上层、用上衣的剪影遮住（id 为 {id}-hand 的遮罩），所以在头发前面、衣服后面，放下时照样滑到衣服后面。
 * 渐变和遮罩的 id 写成 \`{id}-…\`，挂的时候换成每一颗自己的前缀，同一页上两颗不会互相借。
 *
 * 由 .scratch/buddy-girl-avatar/draw/gen.cjs 生成；改画时改 draw/draw.cjs 再重新生成，别在这里手改路径。
 */

/** 摆位用的几个量：和 MILES_ART 完全相同，两颗胶囊里的人一样大、胶囊在同一个位置。 */
export const GIRL_ART = ${JSON.stringify(ART).replace(/"(\w+)":/g, "$1: ").replace(/,(?=\w)/g, ", ").replace(/^\{/, "{ ").replace(/\}$/, " }")} as const;

export const GIRL_SVG = \`${inner}\`;
`);
console.log("girl.svg / girlArt.ts written,", inner.length, "chars");
