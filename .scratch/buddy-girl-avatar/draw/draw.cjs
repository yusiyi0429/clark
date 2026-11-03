// 女伙伴形象的画法（2026-11-03 第四版）：Q 版萌系（参考网上流行的 Q 版 DeepSeek 拟人的画风和发型）+ 萨拉芬尼式的粉紫蓝配色，不穿女仆装。
// 不画鲸鱼鳍、鲸鱼尾巴和鲸鱼图案：那是 DeepSeek 的品牌形象，放进天枢会让人以为两家有关系。
// 和 Miles 同一坐标系、同一缩放、同一套 data-part；脸型、鼻子、耳朵和两只 AirPods、比耶的手、脖子和手臂的形状取自 Miles
// （肤色整套换浅、描边换成深紫蓝并略细），新画的是头发、眼睛、嘴、腮红和领口的蝴蝶结。输出内层 SVG，由 gen.cjs 写成 girl.svg 和 girlArt.ts。
const { spline, splineSegs, subPath, cont, milesPart, milesDefs } = require("./lib.cjs");
const { wobble } = require("./wobble.cjs");

const C = {
  ink: "#2e2747", line: "#8a5fb0", hi: "#ffd9ee", sparkle: "#ffffff", shade: "#f2b4b0",
  bow: "#8fd0ff", bowShade: "#5aa5e6", star: "#ffe39a", starHi: "#fff6d2",
  tie: "#6c78e0", tieShade: "#4f5bc4", gem: "#8ff0ff",
  pupil: "#1c1846", lid: "#2e2747",
  mouthLine: "#8f3550", mouthIn: "#c9465f", tongue: "#f28aa0",
};
const W = 10.5; // 主描边：深紫蓝，比 Miles 的 12.5 黑线细一点，产品尺寸下仍然清楚
const SKIN = {
  "#f5c1b4": "#fde3d8", "#dc9592": "#f3b8b0", "#bd6b6b": "#eaa39f", "#e98e84": "#f59aa0", "#d77a73": "#ee8c93", "#d7766d": "#ef9097",
  "#64201a": "#cf8488", "#3a0b0d": "#ad5d68", "#86302f": "#b0485a", "#d8706f": "#f08a96", "#e4a596": "#f2b8ad", "#7d2e27": "#c26a6d",
  "#c27c7c": "#eda7a8", "#80353a": "#c4727c", "#a86b6c": "#e2a6a6", "#84414c": "#cf8e95",
};
const TEE = { "#f8e8ef": "#fdfbff", "#927882": "#d6d0ee", "#7a5f68": "#a49bcd", "#7a7176": "#aaa3cc", "#a0868f": "#cfc7ec", "#6f5461": "#9389c2" };
const recolor = (map) => (s) => Object.entries(map).reduce((acc, [a, b]) => acc.replaceAll(a, b), s);
// 复用的 Miles 部件：肤色换浅，描边换成深紫蓝、略细。
const soften = (s) => recolor({ ...SKIN, "#0b090d": C.ink })(s).replaceAll('stroke-width="12.5"', `stroke-width="${W}"`).replaceAll('stroke="#c26a6d" stroke-width="13"', 'stroke="#c26a6d" stroke-width="10"');
const tee = (s) => soften(recolor(TEE)(s));

const fill = (d, color, extra = "") => `<path d="${d}" fill="${color}"${extra}/>`;
const line = (d, w = W, color = C.ink) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`;
const outlined = (d, color, w = W) => `<path d="${d}" fill="${color}" stroke="${C.ink}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`;
const ink = (d, seed) => line(wobble(d, { seed }));
const strand = (d, w = 6) => line(d, w, C.line);
const gradient = (id, stops, y1 = 250, y2 = 870) => `<linearGradient id="{id}-${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${y1}" x2="0" y2="${y2}">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("")}</linearGradient>`;
function sparkle(x, y, r, color = C.sparkle) {
  const k = r * 0.12;
  return fill(`M${x} ${y - r}C${x + k} ${y - k} ${x + k} ${y - k} ${x + r} ${y}C${x + k} ${y + k} ${x + k} ${y + k} ${x} ${y + r}C${x - k} ${y + k} ${x - k} ${y + k} ${x - r} ${y}C${x - k} ${y - k} ${x - k} ${y - k} ${x} ${y - r}Z`, color);
}
function star(cx, cy, R, r, rot = -12) {
  const pts = Array.from({ length: 10 }, (_, i) => { const a = ((rot - 90 + i * 36) * Math.PI) / 180; const rad = i % 2 ? r : R; return `${(cx + rad * Math.cos(a)).toFixed(1)} ${(cy + rad * Math.sin(a)).toFixed(1)}`; });
  return `M${pts.join("L")}Z`;
}
const HAIR = "url(#{id}-hair)", HAIR_BACK = "url(#{id}-hair-back)";

const HEAD = [ // 头四周的头发：两侧垂到肩膀高度，和后面那层长发（hair-long）在竖直的外沿上衔接
  [60, 800], [46, 740], [66, 680], [54, 620], [72, 560], [86, 500], [112, 440], [150, 376], [212, 318], [300, 274],
  [400, 250], [500, 246], [592, 260], [674, 294], [742, 346], [792, 418], [822, 498], [846, 570], [860, 640], [874, 704],
  [870, 770], [866, 800], [820, 810], [760, 800], [704, 790], [668, 756], [600, 750], [450, 740], [300, 725], [236, 744],
  [200, 800], [120, 812],
];
// 背后的长发：在身体后面，从后脑勺一路垂到腰下，脖子和肩膀周围、手臂两边都露出来。不跟着头转，所以和上面那层的接缝放在两侧竖直的外沿上。
const LONG = [
  [56, 740], [46, 800], [64, 860], [42, 930], [62, 1000], [40, 1070], [66, 1150, "c"], [110, 1120], [150, 1160, "c"], [196, 1124],
  [240, 1158, "c"], [290, 1130], [340, 1160, "c"], [420, 1150], [500, 1150], [560, 1160, "c"], [610, 1128], [660, 1160, "c"], [710, 1124], [760, 1162, "c"],
  [812, 1124], [860, 1152, "c"], [888, 1080], [866, 1010], [890, 940], [868, 870], [884, 800], [872, 740],
  [800, 730], [700, 740], [600, 760], [450, 770], [300, 760], [200, 740], [120, 730],
];
const head = splineSegs(HEAD);
const BACK_WAVES = ["M86 470C64 540 84 600 64 664C54 724 78 776 66 796", "M832 480C856 550 842 610 862 672C874 732 852 784 862 796"];
const LONG_WAVES = ["M70 800C50 870 74 940 54 1010C46 1070 66 1110 62 1140", "M176 860C166 940 186 1020 170 1100", "M748 860C760 940 742 1020 758 1100", "M858 800C880 870 858 940 878 1010C886 1070 868 1110 872 1140"];
// 两侧各一缕靠前的波浪卷发，让发量更足。
const MID = [
  [[118, 470], [100, 540], [112, 610], [96, 680], [114, 750], [100, 820], [116, 890], [100, 960], [118, 1030], [104, 1100, "c"], [134, 1060], [140, 990], [128, 920], [142, 850], [134, 780], [146, 710], [134, 640], [146, 570], [142, 500]],
  [[806, 520], [826, 590], [814, 660], [834, 730], [818, 800], [836, 870], [820, 940], [838, 1010], [822, 1080], [836, 1130, "c"], [804, 1090], [808, 1020], [794, 950], [806, 880], [794, 810], [806, 740], [792, 670], [804, 600], [790, 560]],
];
// 头顶 + 刘海 + 两侧垂在脸边的前发（一整块）。EAR_TOP 绕过右耳上方，耳朵和 AirPods 露在外面。
const EAR_TOP = [[822, 498], [800, 560], [756, 580], [716, 558], [676, 566], [650, 552]];
const LOCK_R = [[650, 552], [646, 590], [638, 636], [632, 690], [630, 744], [634, 800], [630, 860], [612, 910], [604, 970], [580, 1004, "c"], [574, 944], [584, 884], [600, 832], [610, 772], [608, 714], [606, 662], [606, 620, "c"]];
const FRINGE = [ // 从右往左：几缕从中间那缕长发往两边散开（长斜边朝外、短陡边朝里），像「ハ」
  [606, 620, "c"], [592, 594], [580, 572], [568, 558], [562, 556], [560, 568], [558, 582, "c"], [546, 570], [530, 562], [516, 554],
  [510, 554], [508, 566], [504, 582, "c"], [490, 568], [474, 558], [460, 554], [452, 572], [442, 600], [430, 630, "c"], [420, 600],
  [410, 572], [402, 554], [388, 560], [372, 570], [362, 586, "c"], [358, 568], [354, 554], [340, 556], [322, 564], [306, 574],
  [296, 574, "c"], [294, 564], [292, 554], [280, 562], [264, 580], [250, 602], [238, 622, "c"],
];
const LOCK_L = [[238, 622, "c"], [232, 660], [228, 706], [236, 756], [252, 806], [270, 850], [284, 900], [290, 962], [280, 1022, "c"], [254, 990], [246, 930], [232, 880], [214, 840], [200, 790], [190, 730], [180, 670], [166, 610], [150, 550], [136, 490], [130, 462]];
const FRONT_SPLITS = ["M562 556C568 536 576 520 588 508", "M510 554C514 532 520 516 530 502", "M460 554C462 530 466 512 472 496", "M402 554C400 530 400 512 404 496", "M354 554C348 530 346 512 348 496", "M292 556C284 534 280 516 280 500"];
const STRANDS = ["M300 470C360 400 450 350 560 330", "M220 520C260 430 330 360 430 320", "M620 520C660 450 700 400 740 380", "M200 640C214 700 222 760 236 820", "M618 640C622 700 624 760 622 800"];
const SHINE = [[196, 420], [244, 368], [312, 330], [396, 308], [480, 304], [560, 314], [626, 338], [610, 356, "c"], [578, 346], [552, 362, "c"], [520, 350], [490, 366, "c"], [456, 352], [424, 370, "c"], [392, 354], [360, 374, "c"], [326, 362], [296, 390, "c"], [266, 384], [232, 420, "c"]];
const SHADE = [[200, 520], [238, 634], [256, 590], [292, 568], [296, 592], [354, 566], [362, 598], [402, 566], [430, 642], [460, 566], [504, 594], [510, 566], [558, 600], [562, 568], [606, 632], [630, 640], [640, 520], [420, 440]];
const AHOGE = [[372, 264], [340, 228], [330, 196], [344, 176], [374, 172], [400, 186, "c"], [374, 188], [358, 204], [362, 232], [384, 256], [404, 260]];
const BOW = { l: [[716, 494], [692, 470], [670, 470], [664, 492], [672, 516], [694, 518], [716, 506]], r: [[736, 494], [760, 468], [782, 468], [790, 488], [784, 514], [760, 518], [736, 506]], knot: [[714, 484], [738, 484], [740, 510], [712, 510]], tails: [[[720, 508], [704, 548, "c"], [718, 546], [728, 520]], [[732, 508], [752, 546, "c"], [738, 546], [726, 520]]] };

// 萌系大眼睛：上深下浅的蓝，深色瞳孔，几层高光，粗上眼线带一笔外挑的睫毛。眨眼、转眼照旧由 rig 套在外面。
const EYES = {
  l: { cx: 300, cy: 656, rx: 46, ry: 55, rot: 0, outer: -1 },
  r: { cx: 530, cy: 660, rx: 48, ry: 57, rot: 0, outer: 1 },
};
function eye(side) {
  const e = EYES[side], o = e.outer;
  const top = e.cy - e.ry, lidY = top + 4;
  const lid = spline([[e.cx - o * (e.rx * 1.0), e.cy - e.ry * 0.38], [e.cx - o * e.rx * 0.62, top - 4], [e.cx, top - 9], [e.cx + o * e.rx * 0.64, top - 4], [e.cx + o * e.rx * 1.08, e.cy - e.ry * 0.5], [e.cx + o * (e.rx + 16), e.cy - e.ry * 0.88, "c"], [e.cx + o * (e.rx + 8), e.cy - e.ry * 0.58], [e.cx + o * (e.rx + 16), e.cy - e.ry * 0.5, "c"], [e.cx + o * (e.rx * 1.02), e.cy - e.ry * 0.22], [e.cx + o * e.rx * 0.62, top + 14], [e.cx, top + 10], [e.cx - o * e.rx * 0.62, top + 14]]);
  return `<g data-part="eye-${side}">`
    + `<ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}" fill="url(#{id}-iris)" stroke="#2b2f7a" stroke-width="4"/>`
    + `<ellipse cx="${e.cx}" cy="${e.cy - 6}" rx="${e.rx * 0.5}" ry="${e.ry * 0.5}" fill="${C.pupil}" opacity="0.8"/>`
    + `<path d="M${e.cx - e.rx * 0.7} ${e.cy + e.ry * 0.45}Q${e.cx} ${e.cy + e.ry * 0.98} ${e.cx + e.rx * 0.7} ${e.cy + e.ry * 0.45}Q${e.cx} ${e.cy + e.ry * 0.72} ${e.cx - e.rx * 0.7} ${e.cy + e.ry * 0.45}Z" fill="#c8f0ff" opacity="0.85"/>`
    + `<ellipse cx="${e.cx - e.rx * 0.32}" cy="${e.cy - e.ry * 0.34}" rx="${e.rx * 0.36}" ry="${e.ry * 0.3}" fill="#fff"/>`
    + `<circle cx="${e.cx + e.rx * 0.38}" cy="${e.cy + e.ry * 0.28}" r="${e.rx * 0.16}" fill="#fff"/>`
    + line(`M${e.cx + o * e.rx * 0.78} ${e.cy + e.ry * 0.72}Q${e.cx + o * e.rx * 0.98} ${e.cy + e.ry * 0.5} ${e.cx + o * e.rx * 1.02} ${e.cy + e.ry * 0.28}`, 4, C.lid)
    + `<circle cx="${e.cx + e.rx * 0.08}" cy="${e.cy - e.ry * 0.62}" r="${e.rx * 0.07}" fill="#fff" opacity="0.9"/>`
    + fill(lid, C.lid) + `</g>`;
}
const closedEye = (side) => { const e = EYES[side]; return `<g data-part="eye-${side}-closed" display="none">${line(`M${e.cx - e.rx} ${e.cy}Q${e.cx} ${e.cy - e.ry * 0.7} ${e.cx + e.rx} ${e.cy}`, 11)}</g>`; };
// 平时是张着的小嘴笑；在说话时 rig 换成大一点的张嘴，并跟着音节缩放。
const MOUTH = `<g data-part="mouth"><path d="M400 712Q418 718 436 712Q434 734 418 736Q402 734 400 712Z" fill="${C.mouthIn}" stroke="${C.mouthLine}" stroke-width="5" stroke-linejoin="round"/><path d="M408 728Q418 722 428 728Q424 734 418 735Q412 734 408 728Z" fill="${C.tongue}"/></g>`;
const MOUTH_OPEN = `<g data-part="mouth-open" display="none"><path d="M396 708Q418 716 440 708Q438 748 418 752Q398 748 396 708Z" fill="${C.mouthIn}" stroke="${C.mouthLine}" stroke-width="5" stroke-linejoin="round"/><path d="M404 738Q418 728 432 738Q428 750 418 751Q408 750 404 738Z" fill="${C.tongue}"/></g>`;
const blush = (side, cx, cy, rx, ry) => `<g data-part="blush-${side}"><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#{id}-blush-${side}-g)"/></g>`;

function drawGirl() {
  const collarBow = outlined(spline([[436, 838], [408, 820], [382, 818], [372, 838], [380, 860], [404, 864], [434, 852]]), C.tie)
    + outlined(spline([[452, 838], [480, 818], [506, 816], [516, 836], [508, 858], [484, 864], [454, 852]]), C.tie)
    + outlined(spline([[432, 832], [456, 832], [458, 858], [430, 858]]), C.tieShade)
    + `<path d="M444 834L452 845L444 856L436 845Z" fill="${C.gem}" stroke="${C.ink}" stroke-width="4" stroke-linejoin="round"/>`;
  const body = `<g data-part="body" data-pivot="388 1182">${soften(milesPart("arm-r"))}${soften(milesPart("neck"))}${tee(milesPart("shirt"))}${tee(milesPart("collar"))}<g data-part="bow">${collarBow}</g></g>`;
  const hairBack = `<g data-part="hair-back">${fill(spline(HEAD), HAIR_BACK)}${BACK_WAVES.map((d) => strand(d)).join("")}${ink(subPath(head, 0, 21), 7)}`
    + MID.map((p, i) => `<path d="${spline(p)}" fill="${HAIR}"/>` + ink(spline(p), 51 + i)).join("") + `</g>`;
  const front = subPath(head, 7, 16) + cont(EAR_TOP) + cont(LOCK_R) + cont(FRINGE) + cont(LOCK_L) + cont([[130, 462], [126, 420], [150, 376]]) + "Z";
  const hairFront = `<g data-part="hair-front">${fill(front, HAIR)}${fill(spline(SHINE), C.hi)}${sparkle(300, 344, 24)}${sparkle(560, 330, 14)}`
    + STRANDS.map((d) => strand(d)).join("") + FRONT_SPLITS.map((d) => strand(d)).join("")
    + ink(subPath(head, 6, 16), 3) + ink(spline([...LOCK_R, ...FRINGE.slice(1), ...LOCK_L.slice(1)], { closed: false }), 11)
    + outlined(spline(AHOGE), HAIR) + strand("M366 248C348 226 344 204 358 188")
    + BOW.tails.map((t) => outlined(spline(t), C.bowShade, 8)).join("") + outlined(spline(BOW.l), C.bow, 8) + outlined(spline(BOW.r), C.bow, 8) + outlined(spline(BOW.knot), C.bowShade, 8)
    + outlined(star(214, 432, 30, 13), C.star, 7) + fill(star(208, 426, 9, 4), C.starHi)
    + `</g>`;
  const hairLong = `<g data-part="hair-long">${fill(spline(LONG), HAIR_BACK)}${LONG_WAVES.map((d) => strand(d)).join("")}${ink(spline(LONG.slice(0, 28), { closed: false }), 61)}</g>`;
  const headGroup = `<g data-part="head" data-pivot="444 806">${hairBack}`
    + soften(milesPart("ear-l")) + soften(milesPart("airpod-l")) + soften(milesPart("ear-r")) + soften(milesPart("airpod-r")) + soften(milesPart("face"))
    + `<g data-part="face-shade">${fill(spline(SHADE), C.shade)}</g>`
    + blush("l", 256, 728, 42, 28) + blush("r", 572, 732, 44, 28)
    + soften(milesPart("nose")) + eye("l") + eye("r") + closedEye("l") + closedEye("r") + MOUTH + MOUTH_OPEN
    + hairFront + `</g>`;
  const shirt = milesPart("shirt").match(/<path d="([^"]+)"/)[1];
  const handMask = `<mask id="{id}-hand" maskUnits="userSpaceOnUse" x="20" y="140" width="960" height="1080"><rect x="20" y="140" width="960" height="1080" fill="#fff"/><path d="${shirt}" fill="#000" stroke="#000" stroke-width="${W}"/></mask>`;
  const iris = `<linearGradient id="{id}-iris" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2f7a"/><stop offset="0.5" stop-color="#3f6fd8"/><stop offset="1" stop-color="#8fd3ff"/></linearGradient>`;
  const blushG = (side) => `<radialGradient id="{id}-blush-${side}-g"><stop offset="0" stop-color="#f79aaa" stop-opacity="0.75"/><stop offset="0.7" stop-color="#f79aaa" stop-opacity="0.35"/><stop offset="1" stop-color="#f79aaa" stop-opacity="0"/></radialGradient>`;
  const jaw = milesDefs().match(/<linearGradient id="\{id\}-jaw-l-g".*?<\/linearGradient>/)[0];
  const defs = soften(jaw) + iris + blushG("l") + blushG("r") + gradient("hair", [[0, "#f29ac6"], [0.5, "#b9a3f2"], [1, "#8cc8f5"]]) + gradient("hair-back", [[0, "#d87fb2"], [0.5, "#9a86e3"], [1, "#6aa8ea"]], 250, 900) + handMask;
  return `<defs>${defs}</defs><g data-part="miles">${hairLong}${body}${headGroup}<g mask="url(#{id}-hand)">${soften(milesPart("arm-peace"))}</g></g>`;
}
module.exports = { drawGirl };
