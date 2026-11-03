// 女伙伴形象 Mia · Q 版（2026-11-03）：第五版（提交 f94a015）的粉紫蓝 Q 版设计，用新画法重画得更精致，刘海改柔和。
// 构图、配色、饰品沿用第五版：萨拉芬尼式粉→淡紫→天蓝的长发、C 形呆毛、左边天枢 logo 发夹、右边浅蓝蝴蝶结、
// 圆圆的呆萌蓝眼睛、小小张嘴笑、白上衣配领口带宝石的蝴蝶结、右耳 AirPods、左手比耶。
// 新画法：线条用 ink.cjs 的笔刷（有粗细、两头收尖、按部位带颜色，光从左上来，背光一侧线粗），皮肤、头发、衣服加赛璐璐阴影；
// 脸、耳朵、手、脖子、上衣都重画，不再取 Miles 的部件。
// 和 milesRig 的约定照旧：同一坐标系和摆位常量、同样的 data-part 和三个转轴；眼珠 iris-l/r 裁在眼眶里；比耶的手被上衣剪影遮住。
const { spline } = require("./lib.cjs");
const { brush, ring } = require("./ink.cjs");
const fs = require("fs");
const path = require("path");

const C = {
  hairLine: "url(#{id}-hair-line)", hairLineIn: "#7b4f9f", strand: "#9a6cc4", sheenSparkle: "#ffffff",
  skin: "#ffece4", skinShade: "#f8cdc4", skinShade2: "#fcdad2", skinLine: "#c77d75", nose: "#e2a39b",
  lash: "#2e2747", irisLine: "#22266b", pupil: "#141640", irisGlow: "#c8f0ff",
  mouthLine: "#8f3550", mouthIn: "#c9465f", tongue: "#f28aa0",
  shirt: "#fdfbff", shirtShade: "#e6e0f7", shirtLine: "#a297cc",
  bow: "#9fd6ff", bowShade: "#6fb1f0", bowLine: "#3f6fb8",
  tie: "#7480e6", tieShade: "#5560c8", tieLine: "#3a3f8f", gem: "#8ff0ff",
  pod: "#ffffff", podShade: "#dfe3ec", podLine: "#8c94a8",
};

// ── 小工具 ──
let DEFS = [], K = 0;
const P = (d, fill, more = "") => `<path d="${d}" fill="${fill}"${more}/>`;
// 采样间距比 ink.cjs 的默认值放宽一点：放大两倍看不出差别，画的体积小一截
const B = (pts, fill, opts = {}, more = "") => `<path d="${brush(pts, { step: 22, ...opts })}" fill="${fill}"${more}/>`;
const R = (pts, fill, opts = {}, more = "") => `<path d="${ring(pts, { step: 20, ...opts })}" fill="${fill}" fill-rule="evenodd"${more}/>`;
const thin = (pts, color, w, more = "") => B(pts, color, { w, taper: [0.4, 0.4], ends: [0, 0] }, more);
/** 把内容裁在某个形状里（阴影、高光只落在底色上）。 */
const clipped = (d, content) => { const id = `{id}-k${++K}`; DEFS.push(`<clipPath id="${id}"><path d="${d}"/></clipPath>`); return `<g clip-path="url(#${id})">${content}</g>`; };
const stops = (list) => list.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}"${a === undefined ? "" : ` stop-opacity="${a}"`}/>`).join("");
const lin = (id, list, y1, y2) => `<linearGradient id="{id}-${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${y1}" x2="0" y2="${y2}">${stops(list)}</linearGradient>`;
const shift = (pts, dx, dy) => pts.map(([x, y, c]) => (c ? [x + dx, y + dy, c] : [x + dx, y + dy]));
/** 闭合轮廓在尖角处断开，一段一段画线：发梢处两头收尖。side 1 = 顺时针。 */
function contour(pts, color, { w = 6, heavy = 1.7, side = 1, ends = 0.25, taper = 0.14 } = {}) {
  const corners = pts.map((p, i) => (p[2] === "c" ? i : -1)).filter((i) => i >= 0);
  let out = "";
  corners.forEach((a, k) => {
    const b = corners[(k + 1) % corners.length];
    const seg = [];
    for (let i = a; ; i = (i + 1) % pts.length) { seg.push(pts[i].slice(0, 2)); if (i === b) break; }
    if (seg.length > 1) out += B(seg, color, { w, heavy, side, taper: [taper, taper], ends: [ends, ends] });
  });
  return out;
}
function sparkle(x, y, r) {
  const k = r * 0.14;
  return P(`M${x} ${y - r}C${x + k} ${y - k} ${x + k} ${y - k} ${x + r} ${y}C${x + k} ${y + k} ${x + k} ${y + k} ${x} ${y + r}C${x - k} ${y + k} ${x - k} ${y + k} ${x - r} ${y}C${x - k} ${y - k} ${x - k} ${y - k} ${x} ${y - r}Z`, C.sheenSparkle);
}
/** 刘海的一片发束：[发根, 发梢, 宽, 弯]。弧边叶形，中线是一条二次曲线。 */
function leafPts([[rx, ry], [tx, ty], w, b]) {
  const len = Math.hypot(tx - rx, ty - ry), ux = (tx - rx) / len, uy = (ty - ry) / len, nx = -uy, ny = ux;
  const mid = (t) => { const cx = (rx + tx) / 2 + nx * b, cy = (ry + ty) / 2 + ny * b, u = 1 - t; return [u * u * rx + 2 * u * t * cx + t * t * tx, u * u * ry + 2 * u * t * cy + t * t * ty]; };
  const side = (sg) => [[0, 1], [0.18, 0.98], [0.4, 0.9], [0.64, 0.7], [0.86, 0.36]].map(([t, k]) => { const [mx, my] = mid(t); return [mx + sg * nx * (w / 2) * k, my + sg * ny * (w / 2) * k]; });
  const left = side(1), right = side(-1);
  return { left, right, tip: [tx, ty], mid, shape: [...left, [tx, ty, "c"], ...right.slice().reverse()] };
}

// ── 脸 ──（额头那截藏在刘海下面，填色要连上去）
const FACE = [[190, 470], [300, 432], [422, 420], [544, 432], [654, 470], [684, 550], [690, 626], [682, 690], [662, 738], [626, 776], [580, 800], [526, 816], [472, 826], [422, 830], [372, 826], [318, 816], [264, 800], [218, 776], [182, 738], [162, 690], [154, 626], [160, 550]];
const JAW = [[158, 592], [154, 626], [162, 690], [182, 738], [218, 776], [264, 800], [318, 816], [372, 826], [422, 830], [472, 826], [526, 816], [580, 800], [626, 776], [662, 738], [682, 690], [690, 626], [688, 592]];

// ── 头发 ──
// 头四周那层（跟着头动，在脸后面）：第五版的钟形轮廓，头顶放平、两侧垂到肩膀高度；右耳四周和两缕前发外面看得到
const HEAD = [[112, 790], [104, 730], [104, 660], [108, 590], [116, 520], [132, 450], [162, 386], [218, 330], [300, 292], [400, 270], [500, 266], [592, 278], [670, 308], [734, 354], [780, 420], [804, 496], [812, 574], [814, 650], [812, 720], [808, 790], [770, 806], [720, 796], [690, 776], [668, 756], [600, 750], [450, 740], [300, 725], [236, 744], [200, 790], [150, 806]];
// 前面这层（跟着头动）：头顶 → 右耳上方 → 右边那缕前发（沿外沿下去、内沿上来）→ 刘海底下那层的下沿 → 左边那缕前发（内沿下去、外沿上来）
const CROWN = [[130, 462], [140, 420], [162, 386], [218, 330], [300, 292], [400, 270], [500, 266], [592, 278], [670, 308], [734, 354], [780, 420], [804, 496]];
const EAR_TOP = [[794, 552], [764, 584], [730, 580], [704, 572]];
const LOCK_R_OUT = [[692, 600], [684, 660], [676, 720], [670, 780], [662, 840], [648, 900], [630, 960], [604, 1006, "c"]];
const LOCK_R_IN = [[612, 950], [626, 892], [638, 836], [642, 776], [638, 716], [638, 656], [646, 604], [656, 574, "c"]];
const FRINGE = [[640, 600], [612, 574], [570, 566], [520, 578], [462, 590], [404, 590], [346, 580], [296, 572], [254, 588], [226, 606, "c"]];
const LOCK_L_IN = [[220, 640], [214, 700], [216, 756], [228, 812], [244, 866], [258, 920], [266, 970], [262, 1018, "c"]];
const LOCK_L_OUT = [[240, 990], [228, 930], [212, 876], [192, 820], [176, 760], [164, 700], [154, 640], [144, 580], [136, 520]];
const FRONT = [...CROWN, ...EAR_TOP, ...LOCK_R_OUT, ...LOCK_R_IN, ...FRINGE, ...LOCK_L_IN, ...LOCK_L_OUT];
// 空气感的刘海：九片发束，以中间那缕为中心像「ハ」一样往两边散开；长短宽窄都不一样，一片压一片，缝里透出一点额头
const LEAVES = [
  [[524, 476], [648, 600], 38, 18], [[344, 478], [230, 618], 40, -18],
  [[494, 468], [608, 590], 48, 20], [[372, 468], [262, 590], 46, -20],
  [[470, 460], [552, 586], 54, 16], [[394, 460], [318, 596], 56, -16],
  [[450, 454], [494, 610], 48, 10], [[414, 454], [376, 602], 50, -10],
  [[432, 448], [434, 638], 44, 0],
];
// 背后的长发（不跟着头转，在身子后面）：从头四周那层两侧竖直的外沿接下去，往下散开成钟形，发梢一缕缕收尖
const LONG = [[108, 740, "c"], [96, 800], [78, 866], [66, 940], [62, 1010], [50, 1080], [36, 1140], [28, 1170, "c"], [70, 1150], [102, 1186, "c"], [138, 1144], [176, 1184, "c"], [214, 1142], [260, 1152], [432, 1154], [604, 1152], [650, 1142], [690, 1184, "c"], [730, 1144], [770, 1186, "c"], [806, 1150], [852, 1172, "c"], [846, 1140], [834, 1080], [826, 1010], [824, 940], [814, 866], [808, 800], [812, 740, "c"], [740, 730], [600, 744], [432, 760], [264, 744], [150, 732]];
const LONG_LOCKS = [
  [[124, 820], [114, 900], [112, 980], [108, 1060], [108, 1130], [122, 1194, "c"], [138, 1126], [146, 1050], [148, 970], [156, 890], [164, 820]],
  [[742, 820], [752, 900], [754, 980], [758, 1060], [758, 1130], [744, 1194, "c"], [728, 1126], [720, 1050], [718, 970], [710, 890], [702, 820]],
];
const AHOGE = [[372, 276], [340, 238], [330, 204], [344, 182], [374, 176], [400, 190, "c"], [374, 192], [358, 210], [362, 240], [384, 266], [404, 272]];
const BOW = { l: [[716, 494], [692, 470], [670, 470], [664, 492], [672, 516], [694, 518], [716, 506]], r: [[736, 494], [760, 468], [782, 468], [790, 488], [784, 514], [760, 518], [736, 506]], knot: [[714, 484], [738, 484], [740, 510], [712, 510]], tails: [[[720, 508], [704, 548, "c"], [718, 546], [728, 520]], [[732, 508], [752, 546, "c"], [738, 546], [726, 520]]] };

// ── 眼睛 ──：第五版的呆萌圆眼——眼珠正好填满眼眶、瞳孔大而居中、大颗的圆高光、上眼线平缓、外角两根小睫毛。
// 眼眶（眼白、眶线、上眼线、睫毛）钉在脸上，眼珠 iris-l/r 裁在眼眶里：rig 转眼时只移眼珠，眨眼时整只合上。
const EYES = { l: { cx: 302, cy: 664, w: 50, h: 56, o: -1 }, r: { cx: 542, cy: 664, w: 50, h: 56, o: 1 } };
function eye(side) {
  const { cx, cy, w, h, o } = EYES[side];
  const X = (dx) => cx + o * dx;
  const socket = `<ellipse cx="${cx}" cy="${cy}" rx="${w}" ry="${h}"`;
  const iris = `<g data-part="iris-${side}">`
    + `${socket} fill="url(#{id}-iris)"/>`
    + `<ellipse cx="${cx}" cy="${cy - h * 0.9}" rx="${w * 1.25}" ry="${h * 0.5}" fill="#141a5c" opacity="0.35"/>`
    + `<ellipse cx="${cx}" cy="${cy - 3}" rx="${w * 0.52}" ry="${h * 0.56}" fill="${C.pupil}" opacity="0.92"/>`
    + `<path d="M${cx - w * 0.74} ${cy + h * 0.4}Q${cx} ${cy + h * 1.04} ${cx + w * 0.74} ${cy + h * 0.4}Q${cx} ${cy + h * 0.7} ${cx - w * 0.74} ${cy + h * 0.4}Z" fill="${C.irisGlow}" opacity="0.8"/>`
    + `${socket} fill="none" stroke="${C.irisLine}" stroke-width="3.5"/>`
    + `<circle cx="${cx - w * 0.3}" cy="${cy - h * 0.34}" r="${w * 0.3}" fill="#fff"/>`
    + `<circle cx="${cx + w * 0.36}" cy="${cy + h * 0.32}" r="${w * 0.15}" fill="#fff"/>`
    + `<circle cx="${cx + w * 0.22}" cy="${cy - h * 0.6}" r="${w * 0.08}" fill="#fff"/>`
    + `</g>`;
  const lash = [[X(-w * 0.92), cy - h * 0.42], [X(-w * 0.5), cy - h - 3], [X(0), cy - h - 7], [X(w * 0.56), cy - h - 3], [X(w * 0.98), cy - h * 0.46], [X(w + 10), cy - h * 0.3]];
  return `<g data-part="eye-${side}">${socket} fill="#fff"/>`
    + clipped(`M${cx - w} ${cy}a${w} ${h} 0 1 0 ${2 * w} 0a${w} ${h} 0 1 0 ${-2 * w} 0Z`, iris)
    + `${socket} fill="none" stroke="${C.irisLine}" stroke-width="2.6" opacity="0.75"/>`
    + B(lash, C.lash, { w: 12, taper: [0.55, 0.25], ends: [0.1, 0.2], profile: (s) => 0.75 + 0.4 * s })
    + B([[X(w * 0.96), cy - h * 0.5], [X(w + 10), cy - h * 0.62], [X(w + 18), cy - h * 0.7]], C.lash, { w: 4.5, taper: [0.2, 0.8], ends: [0.6, 0] })
    + B([[X(w * 0.82), cy + h * 0.62], [X(w * 0.96), cy + h * 0.48], [X(w + 2), cy + h * 0.32]], C.lash, { w: 4, taper: [0.3, 0.7], ends: [0.4, 0] })
    + `</g>`;
}
const closedEye = (side) => {
  const { cx, cy, w, h, o } = EYES[side];
  const X = (dx) => cx + o * dx;
  return `<g data-part="eye-${side}-closed" display="none">${B([[X(-w), cy + 4], [X(-w * 0.45), cy - h * 0.48], [X(w * 0.4), cy - h * 0.5], [X(w), cy + 2]], C.lash, { w: 10, taper: [0.4, 0.4], ends: [0.15, 0.15] })}${B([[X(w * 0.92), cy - 6], [X(w + 10), cy - 14], [X(w + 16), cy - 22]], C.lash, { w: 4, taper: [0.2, 0.8], ends: [0.6, 0] })}</g>`;
};

// ── 嘴 ──：平时是张着的小嘴笑；在说话时 rig 换成大一点的张嘴，并跟着音节缩放
const MO = [[404, 716, "c"], [422, 721], [440, 716, "c"], [437, 731], [422, 739], [407, 731]];
const MOPEN = [[400, 712, "c"], [422, 718], [444, 712, "c"], [441, 738], [422, 752], [403, 738]];
const mouth = (pts, part, tongueY, extra = "") => `<g data-part="${part}"${extra}>${P(spline(pts), C.mouthIn)}${clipped(spline(pts), `<ellipse cx="422" cy="${tongueY}" rx="14" ry="9" fill="${C.tongue}"/>`)}${R(pts, C.mouthLine, { w: 3.4, heavy: 1.4 })}</g>`;

// ── 天枢 logo 发夹 ──：直接读 apps/web/src/app/icon.svg 里的六片花瓣，品牌蓝；和品牌图标一模一样
const LOGO = fs.readFileSync(path.join(__dirname, "../../../apps/web/src/app/icon.svg"), "utf8").match(/<g transform="[^"]+">(.*?)<\/g>/s)[1]
  .replace(/fill="url\(#tk-p\d\)"/g, 'fill="url(#{id}-logo)"');
const LOGO_CENTER = [632.4, 615.4], LOGO_SIZE = 735.2; // 花瓣在原图坐标里的中心和外框
function logoClip(cx, cy, size) {
  const k = size / LOGO_SIZE;
  return `<g data-part="logo-clip" transform="translate(${cx} ${cy}) scale(${k.toFixed(4)}) translate(${-LOGO_CENTER[0]} ${-LOGO_CENTER[1]})" stroke="#1d3a8f" stroke-width="${(3 / k).toFixed(1)}" stroke-linejoin="round">${LOGO}</g>`;
}

// ── 耳朵和 AirPods ──（耳朵从右边那缕前发外面露出来，头发在耳朵后面）
const EAR = [[688, 614], [706, 600], [730, 608], [742, 638], [736, 676], [716, 702], [694, 698]];
const AIRPOD = `<g data-part="airpod-r"><rect x="710" y="650" width="12" height="50" rx="6" fill="${C.pod}" stroke="${C.podLine}" stroke-width="2.4"/><path d="M717.5 656V694" stroke="${C.podShade}" stroke-width="3" stroke-linecap="round"/><ellipse cx="716" cy="646" rx="14" ry="12" fill="${C.pod}" stroke="${C.podLine}" stroke-width="2.4"/><ellipse cx="711" cy="643" rx="4.5" ry="3.5" fill="#9aa3b5"/></g>`;

// ── 身子 ──：白 T 恤，两边短袖；比耶那只手的小臂从左袖口伸出来
const NECK = [[408, 786], [406, 830], [402, 872], [462, 872], [458, 830], [456, 786]];
const SHIRT = [[372, 846], [330, 856], [290, 872], [262, 896], [236, 924], [212, 960], [204, 1004], [226, 1016], [246, 1006], [244, 1060], [240, 1160], [236, 1250, "c"], [606, 1250, "c"], [602, 1160], [600, 1060], [600, 1008], [622, 1018], [646, 1008], [640, 962], [618, 926], [594, 896], [562, 874], [520, 856], [492, 846], [468, 868], [432, 878], [396, 868]];
const COLLAR = [[372, 846, "c"], [396, 868], [432, 878], [468, 868], [492, 846, "c"], [502, 858], [472, 886], [432, 896], [392, 886], [362, 858]];
const ARM_R = [[606, 1008], [646, 1004], [654, 1080], [660, 1250, "c"], [610, 1250, "c"], [606, 1100]];
const TIE = { l: [[426, 860], [400, 842], [376, 840], [366, 858], [374, 880], [398, 884], [424, 872]], r: [[438, 860], [464, 842], [488, 840], [498, 858], [490, 880], [466, 884], [440, 872]], knot: [[420, 850], [444, 850], [446, 874], [418, 874]] };

// ── 比耶的手 ──（在头发前面、上衣后面；rig 放手时整只滑进胶囊）：手心朝外，食指和中指比 V，拇指压住弯下去的两根手指
const FOREARM = [[166, 846], [204, 846], [228, 920], [240, 1000], [206, 1008], [190, 930]];
const HAND = [[166, 852, "c"], [156, 828], [152, 800], [156, 778], [146, 748], [140, 718], [142, 700], [152, 690], [164, 692], [172, 704], [178, 730], [186, 760], [190, 768, "c"], [194, 740], [200, 712], [206, 698], [218, 692], [230, 698], [232, 712], [228, 740], [222, 768], [230, 784], [232, 810], [224, 836], [206, 852]];

function drawGirl() {
  DEFS = []; K = 0;
  const skinPart = (pts, shade, { w = 4, heavy = 1.6 } = {}) => P(spline(pts), C.skin) + (shade ? clipped(spline(pts), shade) : "") + R(pts, C.skinLine, { w, heavy });
  const filled = (pts, fill, shadeD, shadeFill, line, w = 3.6) => P(spline(pts), fill) + (shadeD ? clipped(spline(pts), P(shadeD, shadeFill)) : "") + R(pts, line, { w, heavy: 1.5 });

  // ── 背后的长发 ──
  const hairLong = `<g data-part="hair-long">${P(spline(LONG), "url(#{id}-hair-back)")}`
    + [[[96, 840], [78, 960], [66, 1080], [52, 1150]], [[200, 880], [192, 1000], [186, 1130]], [[664, 880], [672, 1000], [678, 1130]], [[820, 840], [834, 960], [842, 1080], [848, 1150]]].map((d) => thin(d, C.strand, 3, ` opacity="0.65"`)).join("")
    + contour(LONG.slice(0, 29), C.hairLine, { w: 6, side: -1, heavy: 1.5 }).replace(/<path(?:(?!<path).)*$/, "")
    + LONG_LOCKS.map((L) => P(spline(L), "url(#{id}-hair)", ` opacity="0.7"`) + B(L.slice(1, -1).map((q) => q.slice(0, 2)), C.hairLineIn, { w: 3.2, taper: [0.25, 0.2], ends: [0, 0.1] }, ` opacity="0.85"`)).join("")
    + `</g>`;

  // ── 头四周那层 ──
  const hairBack = `<g data-part="hair-back">${P(spline(HEAD), "url(#{id}-hair-back)")}`
    + [[[130, 470], [118, 600], [116, 740]], [[790, 480], [802, 610], [802, 750]]].map((d) => thin(d, C.strand, 3, ` opacity="0.6"`)).join("")
    + B(HEAD.slice(0, 20), C.hairLine, { w: 6.5, heavy: 1.6, side: 1, taper: [0.08, 0.08], ends: [0.3, 0.3] })
    + `</g>`;

  // ── 前面这层 ──
  const sheenBand = (top, bottom) => P(spline([...top, ...bottom]), "url(#{id}-sheen)");
  const sheen = clipped(spline(FRONT),
    sheenBand([[200, 446, "c"], [222, 404], [258, 370], [302, 346], [348, 334, "c"]], [[334, 362, "c"], [320, 346, "c"], [304, 392, "c"], [288, 364, "c"], [270, 402, "c"], [254, 386, "c"], [238, 430, "c"], [222, 418, "c"]])
    + sheenBand([[376, 326, "c"], [420, 316], [462, 314], [504, 318], [544, 328, "c"]], [[530, 348, "c"], [514, 338, "c"], [498, 382, "c"], [482, 342, "c"], [464, 376, "c"], [448, 340, "c"], [430, 364, "c"], [412, 344, "c"], [394, 360, "c"]])
    + `<g opacity="0.6">${sheenBand([[572, 336, "c"], [612, 346], [652, 366], [688, 394], [712, 430, "c"]], [[698, 428, "c"], [686, 450, "c"], [668, 406, "c"], [652, 428, "c"], [634, 380, "c"], [618, 400, "c"], [600, 362, "c"], [586, 366, "c"]])}</g>`
    + [[[662, 640], [656, 760], [640, 880]], [[186, 650], [194, 770], [214, 880]]].map((d) => thin(d, "#ffe6f4", 6, ` opacity="0.45"`)).join(""));
  const shade = clipped(spline(FRONT),
    P(spline([[600, 290], [680, 316], [740, 360], [784, 424], [804, 496], [794, 552], [764, 584], [730, 580], [704, 572], [692, 600], [684, 660], [676, 720], [670, 780], [662, 840], [648, 900], [630, 960], [604, 1006], [642, 900], [654, 820], [660, 720], [664, 640], [672, 560], [690, 470], [660, 400], [624, 344]]), "url(#{id}-hair-shade)", ` opacity="0.6"`)
    + P(spline([[226, 606], [220, 640], [214, 700], [216, 756], [228, 812], [244, 866], [258, 920], [266, 970], [262, 1018], [248, 960], [238, 900], [222, 840], [206, 780], [198, 720], [198, 650], [206, 606]]), "url(#{id}-hair-shade)", ` opacity="0.55"`));
  const strands = [
    [[360, 300], [318, 360], [296, 430]], [[300, 330], [256, 400], [240, 460]], [[510, 298], [552, 356], [576, 424]], [[580, 318], [628, 384], [646, 446]],
    [[184, 640], [190, 760], [214, 880], [240, 980]], [[664, 640], [658, 760], [642, 880], [620, 980]],
  ].map((d) => thin(d, C.strand, 2.6, ` opacity="0.6"`)).join("");
  const leaves = LEAVES.map((L) => {
    const { left, right, tip, mid, shape } = leafPts(L);
    return P(spline(shape), "url(#{id}-hair)")
      + P(spline([...right, [...tip, "c"], ...right.map(([x, y], i) => { const [mx, my] = mid([0, 0.18, 0.4, 0.64, 0.86][i]); return [(x + mx) / 2, (y + my) / 2]; }).reverse()]), "url(#{id}-hair-shade)", ` opacity="0.35"`)
      + B([...left.slice(2), tip], C.hairLineIn, { w: 3, taper: [0.6, 0.12], ends: [0, 0.3] }) + B([...right.slice(2), tip], C.hairLineIn, { w: 3.4, taper: [0.6, 0.12], ends: [0, 0.3] })
      + thin([mid(0.16), mid(0.4), mid(0.6)], "#ffe6f4", 4, ` opacity="0.35"`);
  }).join("");
  const outer = B([[262, 1018], ...LOCK_L_OUT, ...CROWN].map((q) => q.slice(0, 2)), C.hairLine, { w: 7, heavy: 1.6, side: 1, taper: [0.06, 0.04], ends: [0.15, 0.5] })
    + B([[804, 496], ...EAR_TOP, ...LOCK_R_OUT].map((q) => q.slice(0, 2)), C.hairLine, { w: 5, heavy: 1.4, side: 1, taper: [0.12, 0.08], ends: [0.4, 0.15] });
  const inner = B([[604, 1006], ...LOCK_R_IN].map((q) => q.slice(0, 2)), C.hairLineIn, { w: 4, taper: [0.15, 0.2], ends: [0.2, 0.3] })
    + B([[226, 606], ...LOCK_L_IN].map((q) => q.slice(0, 2)), C.hairLineIn, { w: 4, taper: [0.2, 0.15], ends: [0.3, 0.2] });
  const ahoge = P(spline(AHOGE), "url(#{id}-hair)") + contour([[372, 276, "c"], ...AHOGE.slice(1, 10), [404, 272, "c"]], C.hairLine, { w: 4.5, heavy: 1.4, side: 1, ends: 0.3 }).replace(/<path(?:(?!<path).)*$/, "")
    + thin([[366, 258], [348, 234], [344, 212], [358, 194]], "#ffe6f4", 4, ` opacity="0.5"`);
  const bow = BOW.tails.map((t) => filled(t, C.bowShade, null, null, C.bowLine, 3.2)).join("")
    + filled(BOW.l, C.bow, spline([[716, 494], [700, 480], [690, 492], [698, 508], [716, 506]]), C.bowShade, C.bowLine)
    + filled(BOW.r, C.bow, spline([[736, 494], [752, 480], [764, 492], [756, 508], [736, 506]]), C.bowShade, C.bowLine)
    + filled(BOW.knot, C.bowShade, null, null, C.bowLine, 3.2)
    + thin([[674, 486], [682, 478], [692, 476]], "#ffffff", 3.4, ` opacity="0.8"`) + thin([[770, 476], [780, 480], [784, 490]], "#ffffff", 3.4, ` opacity="0.7"`);
  const hairFront = `<g data-part="hair-front">${ahoge}${P(spline(FRONT), "url(#{id}-hair)")}${shade}${sheen}${strands}${outer}${inner}${leaves}`
    + sparkle(300, 352, 20) + sparkle(560, 340, 12)
    + `<g data-part="bow">${bow}</g>` + logoClip(206, 436, 88) + `</g>`;

  // ── 脸 ──
  const leafShadow = LEAVES.map((L) => P(spline(shift(leafPts(L).shape, 3, 12)), C.skinShade)).join("");
  const faceShade = clipped(spline(FACE),
    `<g opacity="0.75">${P(spline([[150, 420], ...shift(FRINGE, 3, 12).reverse(), [700, 420]]), C.skinShade)}${leafShadow}</g>`
    + P(spline([[690, 560], [694, 640], [686, 700], [664, 746], [626, 782], [584, 806], [596, 786], [632, 754], [654, 712], [664, 650], [662, 580]]), C.skinShade2));
  const face = `<g data-part="face">${P(spline(FACE), C.skin)}${faceShade}${B(JAW, C.skinLine, { w: 5, taper: [0.16, 0.16], ends: [0.2, 0.2], side: -1, heavy: 1.8 })}</g>`;
  const blush = `<g data-part="blush"><ellipse cx="262" cy="730" rx="44" ry="26" fill="url(#{id}-blush)"/><ellipse cx="582" cy="734" rx="44" ry="26" fill="url(#{id}-blush)"/></g>`;
  const nose = `<g data-part="nose">${B([[420, 632], [424, 637], [429, 636]], C.nose, { w: 3, taper: [0.5, 0.5], ends: [0.3, 0.3] })}</g>`;
  const ear = `<g data-part="ear-r">${P(spline(EAR), C.skin)}${clipped(spline(EAR), P(spline([[716, 606], [742, 638], [736, 676], [716, 702], [724, 676], [728, 640]]), C.skinShade))}${R(EAR, C.skinLine, { w: 3.6, heavy: 1.5 })}${thin([[702, 622], [716, 626], [720, 648], [712, 670]], C.skinLine, 2.6, ` opacity="0.85"`)}</g>`;
  const head = `<g data-part="head" data-pivot="444 806">${hairBack}${ear}${AIRPOD}${face}${blush}${nose}${eye("l")}${eye("r")}${closedEye("l")}${closedEye("r")}`
    + `${mouth(MO, "mouth", 740)}${mouth(MOPEN, "mouth-open", 754, ` display="none"`)}${hairFront}</g>`;

  // ── 身子 ──
  const neck = `<g data-part="neck">${P(spline(NECK), C.skin)}${clipped(spline(NECK), P(spline([[396, 786], [422, 840], [470, 786], [470, 852], [432, 866], [396, 852]]), C.skinShade))}`
    + B([[407, 800], [405, 840], [402, 868]], C.skinLine, { w: 3.2, taper: [0.3, 0.3], ends: [0.2, 0.2] }) + B([[457, 800], [459, 840], [462, 868]], C.skinLine, { w: 3.6, taper: [0.3, 0.3], ends: [0.2, 0.2] }) + `</g>`;
  const shirt = `<g data-part="shirt">${P(spline(SHIRT), C.shirt)}`
    + clipped(spline(SHIRT), P(spline([[540, 870], [594, 896], [618, 926], [640, 962], [646, 1008], [600, 1008], [600, 1060], [606, 1250], [548, 1250], [560, 1100], [562, 1000], [556, 930]]), C.shirtShade)
      + P(spline([[262, 1000], [300, 990], [320, 1060], [300, 1250], [240, 1250], [246, 1060]]), C.shirtShade, ` opacity="0.5"`)
      + P(spline([[290, 872], [372, 846], [500, 848], [574, 876], [560, 904], [432, 906], [306, 900]]), C.shirtShade, ` opacity="0.7"`))
    + R(SHIRT, C.shirtLine, { w: 4.5, heavy: 1.7 })
    + thin([[214, 990], [226, 998], [240, 996]], C.shirtLine, 2.6, ` opacity="0.8"`) + thin([[606, 996], [622, 1004], [638, 998]], C.shirtLine, 2.6, ` opacity="0.8"`)
    + thin([[520, 960], [530, 1020], [528, 1080]], C.shirtLine, 2.6, ` opacity="0.55"`)
    + P(spline(COLLAR), C.shirt) + clipped(spline(COLLAR), P(spline([[470, 868], [492, 846], [502, 858], [472, 886], [452, 892]]), C.shirtShade)) + contour(COLLAR, C.shirtLine, { w: 3.4, heavy: 1.5, side: -1, ends: 0.4 })
    + `</g>`;
  const tie = `<g data-part="bow">${filled(TIE.l, C.tie, spline([[426, 860], [404, 852], [386, 864], [398, 880], [424, 872]]), C.tieShade, C.tieLine, 3.2)}${filled(TIE.r, C.tie, spline([[438, 860], [460, 852], [478, 864], [466, 880], [440, 872]]), C.tieShade, C.tieLine, 3.2)}`
    + `${filled(TIE.knot, C.tieShade, null, null, C.tieLine, 3)}<path d="M432 852L441 863L432 874L423 863Z" fill="${C.gem}" stroke="${C.tieLine}" stroke-width="2.6" stroke-linejoin="round"/><path d="M429 858L433 856L436 861" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" opacity="0.9"/></g>`;
  const armR = `<g data-part="arm-r">${skinPart(ARM_R, P(spline([[630, 1006], [646, 1004], [654, 1080], [660, 1250], [640, 1250], [636, 1080]]), C.skinShade))}</g>`;
  const body = `<g data-part="body" data-pivot="388 1182">${armR}${neck}${shirt}${tie}</g>`;

  // ── 比耶的手 ──
  const hand = `<g data-part="arm-peace" data-pivot="268 912">`
    + skinPart(FOREARM, P(spline([[190, 846], [204, 846], [228, 920], [240, 1000], [222, 1004], [208, 924]]), C.skinShade), { w: 3.6 })
    + P(spline(HAND), C.skin)
    + clipped(spline(HAND), P(spline([[222, 768], [230, 784], [232, 810], [224, 836], [206, 852], [212, 828], [216, 800], [214, 778]]), C.skinShade) + P(spline([[164, 692], [172, 704], [178, 730], [186, 760], [176, 756], [168, 728]]), C.skinShade) + P(spline([[230, 698], [232, 712], [228, 740], [222, 768], [214, 756], [220, 724]]), C.skinShade))
    + contour(HAND, C.skinLine, { w: 3.8, heavy: 1.5, ends: 0.35, taper: 0.1 })
    + thin([[232, 800], [214, 810], [192, 814], [174, 808]], C.skinLine, 3) + thin([[162, 790], [174, 784], [186, 788]], C.skinLine, 2.4, ` opacity="0.85"`)
    + `</g>`;

  const handMask = `<mask id="{id}-hand" maskUnits="userSpaceOnUse" x="20" y="140" width="860" height="1080"><rect x="20" y="140" width="860" height="1080" fill="#fff"/><path d="${spline(SHIRT)}" fill="#000" stroke="#000" stroke-width="4.5"/></mask>`;
  const defs = lin("hair", [[0, "#f6a3cc"], [0.5, "#c4a6f4"], [1, "#96cff7"]], 250, 900)
    + lin("hair-back", [[0, "#e08ab9"], [0.5, "#a28ce6"], [1, "#84b8f0"]], 250, 1000)
    + lin("hair-shade", [[0, "#dd86bb"], [0.5, "#9a86e6"], [1, "#6fa6ec"]], 250, 900)
    + lin("hair-line", [[0, "#7d3f86"], [0.45, "#5a4aae"], [1, "#3a66b8"]], 250, 1190)
    + lin("sheen", [[0, "#ffe1f2", 0.15], [0.3, "#ffe1f2", 0.75], [1, "#ffe1f2", 0.05]], 314, 452)
    + `<linearGradient id="{id}-iris" x1="0" y1="0" x2="0" y2="1">${stops([[0, "#23286b"], [0.45, "#3c6fe0"], [1, "#93d4ff"]])}</linearGradient>`
    + `<radialGradient id="{id}-blush">${stops([[0, "#f79aaa", 0.7], [0.65, "#f79aaa", 0.32], [1, "#f79aaa", 0]])}</radialGradient>`
    + `<linearGradient id="{id}-logo" x1="0" y1="1" x2="0" y2="0">${stops([[0, "#2459C5"], [0.45, "#2E6BDE"], [1, "#3980F8"]])}</linearGradient>`
    + DEFS.join("") + handMask;
  return `<defs>${defs}</defs><g data-part="miles">${hairLong}${body}${head}<g mask="url(#{id}-hand)">${hand}</g></g>`;
}

/** 写进 girlArt.ts 文件头的说明（每行一句，gen.cjs 会补上和 rig 的约定）。 */
const DOC = `
女伙伴形象 Mia · Q 版（2026-11-03 设计稿，待定稿）：第五版的粉紫蓝 Q 版设计，用新画法重画得更精致，刘海改柔和。
萨拉芬尼式粉→淡紫→天蓝的长发从头顶垂过肩膀、披在背后，两缕前发搭在胸前；头顶 C 形呆毛、左边天枢 logo 发夹、右边浅蓝蝴蝶结；
圆圆的呆萌蓝眼睛、小小张嘴笑、腮红；白 T 恤，领口一个带小宝石的蝴蝶结；右耳 AirPods；左手比耶。
线条用笔刷画（有粗细、两头收尖、按部位带颜色，背光一侧线粗），皮肤、头发、衣服有赛璐璐阴影；脸、手、身子都是新画的，不取 Miles 的部件。
背后的长发（data-part="hair-long"）在身子后面，不跟着头转；它从头四周那层两侧竖直的外沿接下去，侧头时接缝看不出来。
`;
module.exports = { drawGirl, DOC };
