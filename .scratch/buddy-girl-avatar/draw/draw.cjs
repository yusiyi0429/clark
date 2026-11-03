// 女伙伴形象的画法（2026-11-03 第五版）：Q 版萌系（参考网上流行的 Q 版 DeepSeek 拟人的画风和发型）+ 萨拉芬尼式的粉紫蓝配色，不穿女仆装。
// 不画鲸鱼鳍、鲸鱼尾巴和鲸鱼图案：那是 DeepSeek 的品牌形象，放进天枢会让人以为两家有关系。
// 和 Miles 同一坐标系、同一缩放、同一套 data-part；脸型、鼻子、耳朵和两只 AirPods、比耶的手、脖子和手臂的形状取自 Miles
// （肤色整套换浅、描边换成深紫蓝并略细），新画的是头发、眼睛、嘴、腮红、两个蝴蝶结和天枢 logo 发夹。输出内层 SVG，由 gen.cjs 写成 girl.svg 和 girlArt.ts。
const { spline, splineSegs, subPath, cont, milesPart, milesDefs } = require("./lib.cjs");
const { wobble } = require("./wobble.cjs");
const fs = require("fs");
const path = require("path");

const C = {
  ink: "#2e2747", line: "#8a5fb0", hi: "#ffd9ee", sparkle: "#ffffff", shade: "#f2b4b0",
  bow: "#8fd0ff", bowShade: "#5aa5e6",
  tie: "#6c78e0", tieShade: "#4f5bc4", gem: "#8ff0ff",
  pupil: "#141640", lid: "#2e2747", irisLine: "#22266b",
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
const HAIR = "url(#{id}-hair)", HAIR_BACK = "url(#{id}-hair-back)";

const HEAD = [ // 头四周的头发：贴着头，头顶放平一点（头不显大）；两侧垂到肩膀高度，和背后那层长发在竖直的外沿上衔接
  [112, 790], [104, 730], [104, 660], [108, 590], [116, 520], [132, 450], [162, 386], [218, 330], [300, 292], [400, 270],
  [500, 266], [592, 278], [670, 308], [734, 354], [780, 420], [804, 496], [812, 574], [814, 650], [812, 720], [808, 790],
  [770, 806], [720, 796], [690, 776], [668, 756], [600, 750], [450, 740], [300, 725], [236, 744], [200, 790], [150, 806],
];
// 背后的长发：在身体后面，从后脑勺一路垂到腰下，脖子和肩膀周围、手臂两边都露出来。不跟着头转，所以和上面那层的接缝放在两侧竖直的外沿上。
const LONG = [ // 两道大的 S 形波浪往下散开成钟形，发梢是一缕缕的尖、最外面两缕往外翘；不是一排小波纹（那样像海带）
  [106, 740], [92, 800], [70, 860], [60, 930], [78, 992], [58, 1060], [40, 1120], [30, 1168, "c"], [74, 1146], [104, 1184, "c"],
  [140, 1140], [176, 1182, "c"], [214, 1138], [260, 1150], [420, 1150], [560, 1150], [700, 1138], [740, 1182, "c"], [776, 1140], [812, 1184, "c"],
  [846, 1146], [890, 1168, "c"], [880, 1120], [862, 1060], [842, 992], [860, 930], [850, 860], [830, 800], [816, 740],
  [760, 728], [650, 740], [450, 770], [250, 740], [150, 728],
];
// 长发里两缕前后错开的大卷（尖梢），让发量有层次。
const LONG_LOCKS = [
  [[120, 820], [104, 900], [118, 980], [98, 1060], [92, 1120], [118, 1196, "c"], [136, 1120], [150, 1050], [140, 970], [156, 890], [164, 820]],
  [[756, 820], [770, 900], [756, 980], [776, 1060], [784, 1120], [758, 1196, "c"], [742, 1120], [730, 1050], [742, 970], [726, 890], [716, 820]],
];
const head = splineSegs(HEAD);
const BACK_WAVES = ["M130 470C116 560 118 650 114 740", "M790 480C804 570 806 660 802 750"];
const LONG_WAVES = ["M86 820C68 900 72 980 66 1060C62 1100 54 1130 46 1156", "M196 860C186 940 192 1030 182 1124", "M690 860C700 940 694 1030 704 1124", "M832 820C850 900 846 980 854 1060C858 1100 866 1130 874 1156"];
// 头顶 + 刘海 + 两侧垂在脸边的前发（一整块）。EAR_TOP 绕过右耳上方，耳朵和 AirPods 露在外面。
const EAR_TOP = [[804, 496], [792, 556], [756, 580], [716, 558], [676, 566], [650, 552]];
const LOCK_R = [[650, 552], [646, 590], [638, 636], [632, 690], [630, 744], [634, 800], [630, 860], [612, 910], [604, 970], [580, 1004, "c"], [574, 944], [584, 884], [600, 832], [610, 772], [608, 714], [606, 662], [606, 620, "c"]];
const FRINGE = [ // 从右往左：几缕从中间那缕长发往两边散开（长斜边朝外、短陡边朝里），像「ハ」
  [606, 620, "c"], [592, 594], [580, 572], [568, 558], [562, 556], [560, 568], [558, 582, "c"], [546, 570], [530, 562], [516, 554],
  [510, 554], [508, 566], [504, 582, "c"], [490, 568], [474, 558], [460, 554], [452, 572], [442, 600], [430, 630, "c"], [420, 600],
  [410, 572], [402, 554], [388, 560], [372, 570], [362, 586, "c"], [358, 568], [354, 554], [340, 556], [322, 564], [306, 574],
  [296, 574, "c"], [294, 564], [292, 554], [280, 562], [264, 580], [250, 602], [238, 622, "c"],
];
const LOCK_L = [[238, 622, "c"], [232, 660], [228, 706], [236, 756], [252, 806], [270, 850], [284, 900], [290, 962], [280, 1022, "c"], [254, 990], [246, 930], [232, 880], [214, 840], [200, 790], [190, 730], [180, 670], [166, 610], [150, 550], [136, 490], [130, 462]];
const FRONT_SPLITS = ["M562 556C568 536 576 520 588 508", "M510 554C514 532 520 516 530 502", "M460 554C462 530 466 512 472 496", "M402 554C400 530 400 512 404 496", "M354 554C348 530 346 512 348 496", "M292 556C284 534 280 516 280 500"];
const STRANDS = ["M300 474C360 408 450 360 560 342", "M226 520C264 436 332 372 430 334", "M620 520C660 456 700 410 740 392", "M200 640C214 700 222 760 236 820", "M618 640C622 700 624 760 622 800"];
const SHINE = [[206, 426], [252, 378], [318, 342], [398, 320], [480, 316], [560, 326], [624, 350], [608, 368, "c"], [578, 358], [552, 374, "c"], [520, 362], [490, 378, "c"], [456, 364], [424, 382, "c"], [392, 366], [360, 386, "c"], [326, 374], [298, 400, "c"], [270, 394], [238, 428, "c"]];
const SHADE = [[200, 520], [238, 634], [256, 590], [292, 568], [296, 592], [354, 566], [362, 598], [402, 566], [430, 642], [460, 566], [504, 594], [510, 566], [558, 600], [562, 568], [606, 632], [630, 640], [640, 520], [420, 440]];
const AHOGE = [[372, 276], [340, 238], [330, 204], [344, 182], [374, 176], [400, 190, "c"], [374, 192], [358, 210], [362, 240], [384, 266], [404, 272]];
const BOW = { l: [[716, 494], [692, 470], [670, 470], [664, 492], [672, 516], [694, 518], [716, 506]], r: [[736, 494], [760, 468], [782, 468], [790, 488], [784, 514], [760, 518], [736, 506]], knot: [[714, 484], [738, 484], [740, 510], [712, 510]], tails: [[[720, 508], [704, 548, "c"], [718, 546], [728, 520]], [[732, 508], [752, 546, "c"], [738, 546], [726, 520]]] };

// 萌系大眼睛，照 Q 版 DeepSeek 拟人的「呆萌」：圆眼睛、分得开一点，瞳孔大而居中，大颗的圆高光，上眼线平缓、外角两根小睫毛（不上挑）。
// 眼眶（眼白、眶线、上眼线、睫毛）钉在脸上，眼珠（iris-l/r）裁在眼眶里：rig 转眼时只移眼珠，眨眼时整只眼睛一起合上。
// 平时眼珠正好填满眼眶，看不到眼白；往旁边看时眼珠靠向眼角，另一侧露出眼白。
const EYES = {
  l: { cx: 296, cy: 662, w: 48, h: 54, outer: -1 },
  r: { cx: 536, cy: 666, w: 48, h: 54, outer: 1 },
};
function eye(side) {
  const { cx, cy, w, h, outer: o } = EYES[side];
  const lid = spline([[cx - o * w * 0.96, cy - h * 0.4], [cx - o * w * 0.56, cy - h - 4], [cx, cy - h - 9], [cx + o * w * 0.58, cy - h - 5], [cx + o * w * 1.02, cy - h * 0.46], [cx + o * (w + 8), cy - h * 0.34, "c"], [cx + o * w * 0.94, cy - h * 0.3], [cx + o * w * 0.6, cy - h + 9], [cx, cy - h + 5], [cx - o * w * 0.56, cy - h + 9]]);
  const socket = `<ellipse cx="${cx}" cy="${cy}" rx="${w}" ry="${h}"`;
  return `<g data-part="eye-${side}">`
    + `${socket} fill="#fff"/>`
    + `<g clip-path="url(#{id}-socket-${side})"><g data-part="iris-${side}">`
    + `${socket} fill="url(#{id}-iris)" stroke="${C.irisLine}" stroke-width="4"/>`
    + `<ellipse cx="${cx}" cy="${cy - 3}" rx="${w * 0.52}" ry="${h * 0.54}" fill="${C.pupil}" opacity="0.9"/>`
    + `<path d="M${cx - w * 0.72} ${cy + h * 0.42}Q${cx} ${cy + h * 1.0} ${cx + w * 0.72} ${cy + h * 0.42}Q${cx} ${cy + h * 0.7} ${cx - w * 0.72} ${cy + h * 0.42}Z" fill="#c8f0ff" opacity="0.8"/>`
    + `<circle cx="${cx - w * 0.3}" cy="${cy - h * 0.34}" r="${w * 0.3}" fill="#fff"/>`
    + `<circle cx="${cx + w * 0.36}" cy="${cy + h * 0.32}" r="${w * 0.15}" fill="#fff"/>`
    + `<circle cx="${cx + w * 0.22}" cy="${cy - h * 0.58}" r="${w * 0.08}" fill="#fff"/>`
    + `</g></g>`
    + `${socket} fill="none" stroke="${C.irisLine}" stroke-width="4"/>`
    + fill(lid, C.lid)
    + line(`M${cx + o * w * 0.98} ${cy - h * 0.5}Q${cx + o * (w + 8)} ${cy - h * 0.62} ${cx + o * (w + 14)} ${cy - h * 0.7}`, 4, C.lid)
    + line(`M${cx + o * w * 0.8} ${cy + h * 0.64}Q${cx + o * w * 0.96} ${cy + h * 0.5} ${cx + o * w * 1.0} ${cy + h * 0.34}`, 4, C.lid)
    + `</g>`;
}
const closedEye = (side) => { const { cx, cy, w, h } = EYES[side]; return `<g data-part="eye-${side}-closed" display="none">${line(`M${cx - w} ${cy}Q${cx} ${cy - h * 0.6} ${cx + w} ${cy}`, 11)}</g>`; };
// 平时是张着的小嘴笑；在说话时 rig 换成大一点的张嘴，并跟着音节缩放。
const MOUTH = `<g data-part="mouth"><path d="M400 712Q418 718 436 712Q434 734 418 736Q402 734 400 712Z" fill="${C.mouthIn}" stroke="${C.mouthLine}" stroke-width="5" stroke-linejoin="round"/><path d="M408 728Q418 722 428 728Q424 734 418 735Q412 734 408 728Z" fill="${C.tongue}"/></g>`;
const MOUTH_OPEN = `<g data-part="mouth-open" display="none"><path d="M396 708Q418 716 440 708Q438 748 418 752Q398 748 396 708Z" fill="${C.mouthIn}" stroke="${C.mouthLine}" stroke-width="5" stroke-linejoin="round"/><path d="M404 738Q418 728 432 738Q428 750 418 751Q408 750 404 738Z" fill="${C.tongue}"/></g>`;
// 天枢 logo 形状的发夹：直接读 apps/web/src/app/icon.svg 里的六片花瓣，品牌蓝，描深紫蓝边；和品牌图标保持一模一样。
const LOGO = fs.readFileSync(path.join(__dirname, "../../../apps/web/src/app/icon.svg"), "utf8").match(/<g transform="[^"]+">(.*?)<\/g>/s)[1]
  .replace(/fill="url\(#tk-p\d\)"/g, 'fill="url(#{id}-logo)"');
const LOGO_CENTER = [632.4, 615.4], LOGO_SIZE = 735.2; // 花瓣在原图坐标里的中心和外框
function logoClip(cx, cy, size) {
  const k = size / LOGO_SIZE;
  return `<g data-part="logo-clip" transform="translate(${cx} ${cy}) scale(${k.toFixed(4)}) translate(${-LOGO_CENTER[0]} ${-LOGO_CENTER[1]})" stroke="#1d3a8f" stroke-width="${(3.5 / k).toFixed(1)}" stroke-linejoin="round">${LOGO}</g>`;
}
const blush = (side, cx, cy, rx, ry) => `<g data-part="blush-${side}"><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#{id}-blush-${side}-g)"/></g>`;

function drawGirl() {
  const collarBow = outlined(spline([[436, 838], [408, 820], [382, 818], [372, 838], [380, 860], [404, 864], [434, 852]]), C.tie)
    + outlined(spline([[452, 838], [480, 818], [506, 816], [516, 836], [508, 858], [484, 864], [454, 852]]), C.tie)
    + outlined(spline([[432, 832], [456, 832], [458, 858], [430, 858]]), C.tieShade)
    + `<path d="M444 834L452 845L444 856L436 845Z" fill="${C.gem}" stroke="${C.ink}" stroke-width="4" stroke-linejoin="round"/>`;
  const body = `<g data-part="body" data-pivot="388 1182">${soften(milesPart("arm-r"))}${soften(milesPart("neck"))}${tee(milesPart("shirt"))}${tee(milesPart("collar"))}<g data-part="bow">${collarBow}</g></g>`;
  const hairBack = `<g data-part="hair-back">${fill(spline(HEAD), HAIR_BACK)}${BACK_WAVES.map((d) => strand(d)).join("")}${ink(subPath(head, 0, 19), 7)}</g>`;
  const front = subPath(head, 6, 15) + cont(EAR_TOP) + cont(LOCK_R) + cont(FRINGE) + cont(LOCK_L) + cont([[130, 462], [140, 420], [162, 386]]) + "Z";
  const hairFront = `<g data-part="hair-front">${fill(front, HAIR)}${fill(spline(SHINE), C.hi)}${sparkle(306, 356, 24)}${sparkle(560, 342, 14)}`
    + STRANDS.map((d) => strand(d)).join("") + FRONT_SPLITS.map((d) => strand(d)).join("")
    + ink(subPath(head, 5, 15), 3) + ink(spline([...LOCK_R, ...FRINGE.slice(1), ...LOCK_L.slice(1)], { closed: false }), 11)
    + outlined(spline(AHOGE), HAIR) + strand("M366 258C348 234 344 212 358 194")
    + BOW.tails.map((t) => outlined(spline(t), C.bowShade, 8)).join("") + outlined(spline(BOW.l), C.bow, 8) + outlined(spline(BOW.r), C.bow, 8) + outlined(spline(BOW.knot), C.bowShade, 8)
    + logoClip(206, 436, 92)
    + `</g>`;
  const hairLong = `<g data-part="hair-long">${fill(spline(LONG), HAIR_BACK)}${LONG_WAVES.map((d) => strand(d)).join("")}${ink(spline(LONG.slice(0, 29), { closed: false }), 61)}`
    + LONG_LOCKS.map((p, i) => fill(spline(p), HAIR) + ink(spline(p.slice(1, -1), { closed: false }), 71 + i)).join("") + `</g>`;
  const headGroup = `<g data-part="head" data-pivot="444 806">${hairBack}`
    + soften(milesPart("ear-l")) + soften(milesPart("airpod-l")) + soften(milesPart("ear-r")) + soften(milesPart("airpod-r")) + soften(milesPart("face"))
    + `<g data-part="face-shade">${fill(spline(SHADE), C.shade)}</g>`
    + blush("l", 256, 728, 42, 28) + blush("r", 572, 732, 44, 28)
    + soften(milesPart("nose")) + eye("l") + eye("r") + closedEye("l") + closedEye("r") + MOUTH + MOUTH_OPEN
    + hairFront + `</g>`;
  const shirt = milesPart("shirt").match(/<path d="([^"]+)"/)[1];
  const handMask = `<mask id="{id}-hand" maskUnits="userSpaceOnUse" x="20" y="140" width="960" height="1080"><rect x="20" y="140" width="960" height="1080" fill="#fff"/><path d="${shirt}" fill="#000" stroke="#000" stroke-width="${W}"/></mask>`;
  const iris = `<linearGradient id="{id}-iris" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#23286b"/><stop offset="0.45" stop-color="#3c6fe0"/><stop offset="1" stop-color="#93d4ff"/></linearGradient>`;
  const logo = `<linearGradient id="{id}-logo" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#2459C5"/><stop offset="0.45" stop-color="#2E6BDE"/><stop offset="1" stop-color="#3980F8"/></linearGradient>`;
  const blushG = (side) => `<radialGradient id="{id}-blush-${side}-g"><stop offset="0" stop-color="#f79aaa" stop-opacity="0.75"/><stop offset="0.7" stop-color="#f79aaa" stop-opacity="0.35"/><stop offset="1" stop-color="#f79aaa" stop-opacity="0"/></radialGradient>`;
  const jaw = milesDefs().match(/<linearGradient id="\{id\}-jaw-l-g".*?<\/linearGradient>/)[0];
  const sockets = ["l", "r"].map((side) => { const { cx, cy, w, h } = EYES[side]; return `<clipPath id="{id}-socket-${side}"><ellipse cx="${cx}" cy="${cy}" rx="${w}" ry="${h}"/></clipPath>`; }).join("");
  const defs = soften(jaw) + iris + sockets + logo + blushG("l") + blushG("r") + gradient("hair", [[0, "#f29ac6"], [0.5, "#b9a3f2"], [1, "#93cdf6"]]) + gradient("hair-back", [[0, "#d87fb2"], [0.5, "#9a86e3"], [1, "#7fb6f0"]], 250, 900) + handMask;
  return `<defs>${defs}</defs><g data-part="miles">${hairLong}${body}${headGroup}<g mask="url(#{id}-hand)">${soften(milesPart("arm-peace"))}</g></g>`;
}
module.exports = { drawGirl };
