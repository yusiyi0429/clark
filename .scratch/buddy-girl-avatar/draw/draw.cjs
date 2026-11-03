// 女伙伴形象的画法（2026-11-03）：八字刘海 + 齐肩外翻，奶茶棕。
// 和 Miles 同一坐标系、同一缩放、同一套 data-part：脸、眼睛、腮红、鼻子、嘴、右耳和耳机、比耶的手、身子都原样取自 Miles，
// 只新画头发、睫毛和泪痣，T 恤换成浅蓝。输出内层 SVG（渐变和遮罩的 id 写成 {id}-…），由 gen.cjs 写成 girl.svg 和 girlArt.ts。
const { spline, splineSegs, subPath, cont, milesPart, milesDefs } = require("./lib.cjs");
const { wobble } = require("./wobble.cjs");
const { hairPalette } = require("./palette.cjs");

const HAIR = "#ad8a72"; // 奶茶棕
const C = { ...hairPalette(HAIR), shade: "#c46d69", skin: "#f5c1b4", ink: "#0b090d" };

const fill = (d, color) => `<path d="${d}" fill="${color}"/>`;
const line = (d, w = 12.5, color = C.ink) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`;
/** 新画的发丝外轮廓：和 Miles 一样的 12.5 黑线，带一点手描起伏。 */
const ink = (d, seed) => line(wobble(d, { seed }));
/** 发丝线用深一号的发色（Miles 手指、衣褶的线也是深一号的本色，不是纯黑）。 */
const strand = (d) => line(d, 7, C.hairLine);

// ── 头发外轮廓（闭合，从左边外翻的发梢起顺时针）。0..17 是前发的外沿，17..28 是别到耳后、垂到肩上的那一侧；其余藏在脸和左侧头发后面。
const HEAD = [
  [86, 812, "c"], [116, 794], [136, 756], [134, 690], [124, 620], [120, 540], [132, 458], [158, 390], [216, 332], [302, 290],
  [400, 266], [498, 262], [586, 274], [662, 304], [728, 354], [774, 426], [798, 512], [806, 598], [810, 680], [810, 744],
  [808, 784], [850, 806, "c"], [816, 834], [770, 842], [730, 834], [704, 806], [684, 776], [666, 756], [626, 738], [450, 735],
  [300, 715], [220, 760], [200, 812], [150, 822],
];
const head = splineSegs(HEAD);
const PART = [446, 506, "c"]; // 分缝在刘海上的尖，比脸的中线偏右一点

// 前发的内沿：从耳朵上方绕过来 → 右边八字刘海（三缕，发梢朝外）回到分缝 → 左边三缕 → 左侧头发贴着脸颊往下 → 发尾外翻。
const EAR_TOP = [[806, 598], [770, 584], [726, 560], [684, 562], [656, 548]];
const FRINGE_R = [[656, 548], [644, 586], [630, 634], [612, 678, "c"], [596, 636], [580, 604], [568, 584], [560, 600, "c"], [540, 588], [520, 574], [504, 562], [496, 578, "c"], [480, 562], [462, 536], PART];
const FRINGE_L = [
  PART, [430, 536], [412, 562], [396, 578, "c"], [388, 562], [370, 574], [352, 584], [336, 590, "c"], [326, 576], [304, 584], [282, 594],
  [264, 618], [250, 650], [244, 680, "c"], [236, 708], [234, 732], [238, 760], [246, 784], [256, 806], [262, 824, "c"], [230, 838], [184, 842], [128, 832], [86, 812, "c"],
];
const FRINGE_SPLITS = ["M388 562C392 540 400 522 412 506", "M326 576C336 552 350 532 368 512", "M504 562C500 540 494 522 484 506", "M568 584C560 560 548 540 532 520"];
const STRANDS = [
  "M446 506C450 470 458 430 470 396", // 分缝
  "M410 470C360 492 300 528 262 590", "M486 470C530 492 570 528 596 584", // 两边刘海往外梳的走向
  "M196 548C188 626 192 706 206 786", // 左侧垂下来的头发
];
const SHINE_L = [[190, 420], [236, 368], [306, 328], [380, 306], [430, 300], [428, 322, "c"], [400, 322], [376, 342, "c"], [346, 338], [318, 360, "c"], [288, 362], [256, 394, "c"], [226, 418, "c"]];
const SHINE_R = [[492, 300], [548, 304], [606, 320], [650, 342], [640, 360, "c"], [612, 350], [588, 364, "c"], [560, 346], [530, 358, "c"], [508, 326, "c"]];
const FLIP_L_UNDER = [[86, 812, "c"], [128, 832], [184, 842], [230, 838], [262, 824, "c"], [254, 808], [212, 818], [166, 814], [118, 798]];
const FLIP_R_UNDER = [[850, 806, "c"], [816, 834], [770, 842], [730, 834], [734, 818], [772, 826], [812, 816]];

// 分缝下面露出来的额头：Miles 的脸在这里被帽子盖着、没画到这么高，补一块同色的皮肤。
const FOREHEAD = [[392, 486], [500, 486], [520, 566], [372, 566]];
// 刘海在额头上的影子（Miles 帽檐下那条影子的同色）。
const SHADE_L = [[446, 518], [434, 546], [416, 570], [398, 590], [386, 578], [366, 588], [338, 600], [324, 590], [304, 596], [284, 604], [268, 626], [256, 654], [248, 688], [228, 688], [228, 560], [320, 520], [430, 494]];
const SHADE_R = [[446, 518], [460, 546], [478, 568], [498, 588], [506, 576], [522, 586], [544, 598], [562, 608], [570, 598], [584, 620], [600, 650], [612, 690], [630, 640], [640, 560], [560, 520], [470, 494]];

const LASH_L = [[300, 613], [290, 606], [280, 604, "c"], [287, 613], [294, 622]];
const LASH_R = [[529, 622], [538, 615], [548, 613, "c"], [543, 622], [536, 630]];

const TEE = { "#f8e8ef": "#e9eef9", "#927882": "#8b94ae", "#7a5f68": "#646e8c", "#7a7176": "#6f7489", "#a0868f": "#929cb7", "#6f5461": "#5f6884" };
const blueTee = (s) => Object.entries(TEE).reduce((acc, [from, to]) => acc.replaceAll(from, to), s);

function drawGirl() {
  const front = subPath(head, 0, 17) + cont(EAR_TOP) + cont(FRINGE_R) + cont(FRINGE_L) + "Z";
  const body = `<g data-part="body" data-pivot="388 1182">${milesPart("arm-r")}${milesPart("neck")}${blueTee(milesPart("shirt"))}${blueTee(milesPart("collar"))}</g>`;
  // 别到耳后的那一侧：在脸和耳朵后面，比前发暗一档。
  const hairBack = `<g data-part="hair-back">${fill(spline(HEAD), C.hairBack)}${fill(spline(FLIP_R_UNDER), C.hairShade)}`
    + line("M690 548C736 566 770 610 786 668", 7, C.hairLine) + line("M748 700C756 740 758 780 760 814", 7, C.hairLine)
    + ink(subPath(head, 17, 28), 7) + `</g>`;
  const hairFront = `<g data-part="hair-front">${fill(front, C.hair)}${fill(spline(FLIP_L_UNDER), C.hairShade)}`
    + fill(spline(SHINE_L), C.hairLight) + fill(spline(SHINE_R), C.hairLight) + STRANDS.map(strand).join("")
    + ink(subPath(head, 0, 17), 3)
    + ink(spline(FRINGE_R, { closed: false }).replace(/^M[^C]*C[^C]*/, "M644 586"), 5) // 右边刘海的外沿从耳朵前面才开始描
    + ink(spline(FRINGE_L, { closed: false }), 11) + FRINGE_SPLITS.map(strand).join("") + `</g>`;
  const eye = (side, lash) => `<g data-part="eye-${side}">${milesPart(`eye-${side}`).replace(`data-part="eye-${side}" `, "")}${fill(spline(lash), C.ink)}</g>`;
  const headGroup = `<g data-part="head" data-pivot="444 806">${hairBack}`
    + milesPart("ear-r") + milesPart("airpod-r") + milesPart("face")
    + `<g data-part="forehead">${fill(spline(FOREHEAD), C.skin)}</g>`
    + `<g data-part="face-shade">${fill(spline(SHADE_L), C.shade)}${fill(spline(SHADE_R), C.shade)}</g>`
    + milesPart("blush-l") + milesPart("blush-r")
    + `<circle data-part="mole" cx="287" cy="716" r="3" fill="#4a0f0c"/>` // 泪痣（Miles 的痣在右脸）
    + milesPart("nose") + eye("l", LASH_L) + eye("r", LASH_R)
    + milesPart("eye-l-closed") + milesPart("eye-r-closed") + milesPart("mouth") + milesPart("mouth-open")
    + hairFront + `</g>`;
  // 比耶的手在头发前面、T 恤后面：手放在最上层，用 T 恤的剪影（连同描边）遮掉。放下时照样滑到衣服后面，和 Miles 一样。
  const shirt = milesPart("shirt").match(/<path d="([^"]+)"/)[1];
  const handMask = `<mask id="{id}-hand" maskUnits="userSpaceOnUse" x="20" y="140" width="860" height="1080"><rect x="20" y="140" width="860" height="1080" fill="#fff"/><path d="${shirt}" fill="#000" stroke="#000" stroke-width="12.5"/></mask>`;
  return `<defs>${milesDefs()}${handMask}</defs><g data-part="miles">${body}${headGroup}<g mask="url(#{id}-hand)">${milesPart("arm-peace")}</g></g>`;
}

module.exports = { drawGirl };
