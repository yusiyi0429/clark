// 女伙伴形象 Mia 的画法（2026-11-03 第六版）：Q 版比例，借孙铭泽给的参考图的气质——细软的线、克制的颜色、安静好看。
// 黑发从发根渐变到发尾的深蓝紫，空气刘海透出眉毛，右边头发别在耳后露出 AirPods；只留一个天枢 logo 发夹点睛；白上衣。
// 不再沿用 Miles 的贴纸画法和部件：线条用 ink.cjs 的笔刷画，有粗细、两头收尖、带颜色，光从左上来，背光一侧线粗、带赛璐璐阴影。
// 和 milesRig 的约定照旧：同一坐标系和摆位常量、同样的 data-part 和三个转轴；眼珠 iris-l/r 裁在眼眶里；比耶的手被上衣剪影遮住。
// 输出内层 SVG，由 gen.cjs 写成 girl.svg 和 girlArt.ts。
const { spline } = require("./lib.cjs");
const { brush, ring } = require("./ink.cjs");
const fs = require("fs");
const path = require("path");

const C = {
  hairLine: "#100e19", sheen: "#93a6dc", strand: "#40508f",
  skin: "#fff5f1", skinShade: "#f7dad4", skinShade2: "#fbe8e3", skinLine: "#b9847c", nose: "#d6a198",
  lash: "#231c36", brow: "#2b2540", irisTop: "#0d0f24", pupil: "#0a0c20", irisGlow: "#a9c3ee", irisRim: "#11142c", socketRim: "#3a3150",
  mouthLine: "#a8626b", lip: "#e9a0a8", mouthIn: "#c95c6e", tongue: "#f29aa8",
  shirt: "#ffffff", shirtShade: "#e7e4f0", shirtLine: "#9a95b3",
  pod: "#ffffff", podShade: "#dfe3ec", podLine: "#8c94a8",
};

// ── 小工具 ──
let DEFS = [], K = 0;
const P = (d, fill, more = "") => `<path d="${d}" fill="${fill}"${more}/>`;
const B = (pts, fill, opts = {}, more = "") => `<path d="${brush(pts, opts)}" fill="${fill}"${more}/>`;
const R = (pts, fill, opts = {}, more = "") => `<path d="${ring(pts, opts)}" fill="${fill}" fill-rule="evenodd"${more}/>`;
/** 把内容裁在某个形状里（阴影、高光只落在底色上）。 */
const clipped = (d, content) => { const id = `{id}-k${++K}`; DEFS.push(`<clipPath id="${id}"><path d="${d}"/></clipPath>`); return `<g clip-path="url(#${id})">${content}</g>`; };
const stops = (list) => list.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}"${a === undefined ? "" : ` stop-opacity="${a}"`}/>`).join("");
const lin = (id, list, y1, y2) => `<linearGradient id="{id}-${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${y1}" x2="0" y2="${y2}">${stops(list)}</linearGradient>`;
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

// ── 脸 ──（额头那截藏在刘海下面，填色要连上去，免得刘海缝里露底）
const FACE = [[196, 478], [300, 436], [433, 424], [566, 436], [670, 478], [700, 556], [706, 630], [698, 690], [676, 738], [640, 776], [594, 804], [540, 822], [486, 834], [433, 840], [380, 834], [326, 822], [272, 804], [226, 776], [190, 738], [168, 690], [160, 630], [166, 556]];
const JAW = [[164, 600], [160, 630], [168, 690], [190, 738], [226, 776], [272, 804], [326, 822], [380, 834], [433, 840], [486, 834], [540, 822], [594, 804], [640, 776], [676, 738], [698, 690], [706, 630], [704, 600]];

// ── 头发 ──
// 前面这层（跟着头动）：顺时针，从左边那缕的发梢起，沿外沿上去、过头顶、下到右边那缕的发梢，再沿内沿上来、走刘海下沿、回到左边。
// 右边那缕别在耳后：内沿贴着脸，耳朵画在头发上面。
const LOCK_L_OUT = [[170, 908, "c"], [148, 846], [130, 768], [120, 690], [114, 610], [114, 540], [122, 474]];
const CROWN = [[146, 398], [198, 336], [282, 292], [376, 268], [433, 262], [490, 268], [584, 292], [668, 336], [720, 398], [746, 474]];
const LOCK_R_OUT = [[754, 540], [756, 610], [752, 690], [746, 768], [740, 846], [732, 906, "c"]];
const LOCK_R_IN = [[716, 840], [710, 770], [710, 700], [708, 630], [700, 560]];
// 刘海底下那层的下沿（比发束的尖短一截，大部分被发束盖住）
const FRINGE = [[694, 544, "c"], [672, 562], [630, 568], [572, 572], [510, 574], [450, 576], [390, 574], [330, 568], [272, 562], [232, 556], [214, 550, "c"]];
// 空气刘海的发束：[发根, 发梢, 宽, 弯]，从两边往中间一片压一片，朝两边散开；中间偏右那片最长，落在两眼之间
const LEAVES = [[[620, 476], [648, 604], 46, 10], [[244, 482], [224, 598], 42, -8], [[298, 474], [280, 622], 54, -12], [[568, 470], [592, 632], 54, 9], [[352, 470], [342, 640], 52, -6], [[514, 466], [522, 648], 50, 3], [[404, 466], [396, 634], 48, -3], [[458, 464], [462, 666], 52, 1]];
const LOCK_L_IN = [[204, 620], [200, 700], [196, 780], [186, 856]];
const FRONT = [...LOCK_L_OUT, ...CROWN, ...LOCK_R_OUT, ...LOCK_R_IN, ...FRINGE, ...LOCK_L_IN];
// 头后面那层（跟着头动，在脸后面）：脸和两侧那缕之间的缝里看得到，比前面暗
const BACK = [[120, 640], [118, 560], [126, 476], ...CROWN, [748, 560], [750, 640], [744, 740, "c"], [700, 790], [433, 806], [166, 790], [126, 740, "c"]];
// 背后的长发（不跟着头转，在身子后面）：脖子两边看得到，一直垂到腰下
const LONG = [[124, 700, "c"], [116, 780], [100, 860], [86, 960], [78, 1060], [72, 1140, "c"], [100, 1120], [126, 1176, "c"], [150, 1136], [190, 1184, "c"], [216, 1146], [244, 1170, "c"], [270, 1150], [433, 1156], [596, 1150], [622, 1172, "c"], [652, 1144], [684, 1186, "c"], [716, 1138], [748, 1178, "c"], [770, 1124], [794, 1142, "c"], [788, 1060], [780, 960], [766, 860], [750, 780], [742, 700, "c"], [433, 688]];

// ── 眼睛 ──（眼眶钉在脸上，眼珠 iris-l/r 裁在眼眶里：rig 转眼时只移眼珠，眨眼时整只合上）
const EYES = { l: { cx: 318, cy: 676, o: -1 }, r: { cx: 548, cy: 676, o: 1 } };
const ERX = 55, ERY = 61;
function eye(side) {
  const { cx, cy, o } = EYES[side];
  const X = (dx) => cx + o * dx;
  const socket = `<ellipse cx="${cx}" cy="${cy}" rx="${ERX}" ry="${ERY}"`;
  const iris = `<g data-part="iris-${side}">`
    + `${socket} fill="url(#{id}-iris)"/>`
    + `<ellipse cx="${cx}" cy="${cy - 50}" rx="66" ry="36" fill="${C.irisTop}" opacity="0.55"/>`
    + `<ellipse cx="${cx}" cy="${cy - 2}" rx="20" ry="28" fill="${C.pupil}" opacity="0.9"/>`
    + `<path d="M${cx - 38} ${cy + 28}Q${cx} ${cy + 74} ${cx + 38} ${cy + 28}Q${cx} ${cy + 48} ${cx - 38} ${cy + 28}Z" fill="${C.irisGlow}" opacity="0.55"/>`
    + `${socket} fill="none" stroke="${C.irisRim}" stroke-width="3.5"/>`
    + `<ellipse cx="${cx - 17}" cy="${cy - 26}" rx="15" ry="19" fill="#fff" opacity="0.95"/>`
    + `<circle cx="${cx + 22}" cy="${cy + 22}" r="7" fill="#fff" opacity="0.9"/>`
    + `<circle cx="${cx + 26}" cy="${cy - 37}" r="4" fill="#fff" opacity="0.85"/>`
    + `</g>`;
  const lash = [[X(-44), cy - 44], [X(-20), cy - 62], [X(8), cy - 68], [X(34), cy - 62], [X(52), cy - 46], [X(62), cy - 28], [X(68), cy - 14]];
  return `<g data-part="eye-${side}">`
    + `${socket} fill="#fff"/>`
    + clipped(`M${cx - ERX} ${cy}a${ERX} ${ERY} 0 1 0 ${2 * ERX} 0a${ERX} ${ERY} 0 1 0 ${-2 * ERX} 0Z`, iris)
    + `${socket} fill="none" stroke="${C.socketRim}" stroke-width="2.2" opacity="0.6"/>`
    + B([[X(-16), cy - 86], [X(16), cy - 90], [X(46), cy - 78]], C.skinLine, { w: 2.4, taper: [0.5, 0.5], ends: [0, 0] }, ` opacity="0.5"`)
    + B(lash, C.lash, { w: 11, taper: [0.6, 0.3], ends: [0.08, 0.1], profile: (s) => 0.7 + 0.45 * s })
    + B([[X(54), cy - 42], [X(68), cy - 46], [X(80), cy - 42]], C.lash, { w: 4.2, taper: [0.2, 0.8], ends: [0.5, 0] })
    + B([[X(61), cy - 26], [X(73), cy - 22], [X(81), cy - 13]], C.lash, { w: 3.6, taper: [0.2, 0.8], ends: [0.5, 0] })
    + B([[X(52), cy + 28], [X(40), cy + 48], [X(22), cy + 59]], C.lash, { w: 3, taper: [0.4, 0.6], ends: [0.3, 0] }, ` opacity="0.7"`)
    + `</g>`;
}
const closedEye = (side) => {
  const { cx, cy, o } = EYES[side];
  const X = (dx) => cx + o * dx;
  return `<g data-part="eye-${side}-closed" display="none">${B([[X(-44), cy - 4], [X(-14), cy + 10], [X(20), cy + 10], [X(50), cy - 2], [X(64), cy - 12]], C.lash, { w: 9, taper: [0.5, 0.3], ends: [0.1, 0.1] })}${B([[X(56), cy - 6], [X(70), cy - 4], [X(80), cy + 4]], C.lash, { w: 3.6, taper: [0.2, 0.8], ends: [0.5, 0] })}</g>`;
};
// 眉毛透过空气刘海露出来：画在头发上面，半透明
const brow = (side) => { const { cx, cy, o } = EYES[side]; const X = (dx) => cx + o * dx; return B([[X(-34), cy - 108], [X(0), cy - 120], [X(38), cy - 114]], C.brow, { w: 5, taper: [0.35, 0.6], ends: [0.2, 0] }); };

// ── 嘴 ──：平时是安静的浅笑；在说话时 rig 换成小小的张嘴，并跟着音节缩放
const MOUTH = `<g data-part="mouth">${B([[414, 768], [424, 774], [433, 775], [442, 774], [452, 768]], C.mouthLine, { w: 4, taper: [0.35, 0.35], ends: [0.15, 0.15] })}<path d="M424 778Q433 782 442 778" fill="none" stroke="${C.lip}" stroke-width="2.2" stroke-linecap="round" opacity="0.55"/></g>`;
const OPEN = [[414, 766, "c"], [433, 770], [452, 766, "c"], [446, 784], [433, 790], [420, 784]];
const MOUTH_OPEN = () => `<g data-part="mouth-open" display="none">${P(spline(OPEN), C.mouthIn)}${clipped(spline(OPEN), `<ellipse cx="433" cy="791" rx="14" ry="8" fill="${C.tongue}"/>`)}${R(OPEN, C.mouthLine, { w: 2.8, heavy: 1.4 })}</g>`;

// ── 天枢 logo 发夹 ──：直接读 apps/web/src/app/icon.svg 里的六片花瓣，品牌蓝；和品牌图标一模一样
const LOGO = fs.readFileSync(path.join(__dirname, "../../../apps/web/src/app/icon.svg"), "utf8").match(/<g transform="[^"]+">(.*?)<\/g>/s)[1]
  .replace(/fill="url\(#tk-p\d\)"/g, 'fill="url(#{id}-logo)"');
const LOGO_CENTER = [632.4, 615.4], LOGO_SIZE = 735.2; // 花瓣在原图坐标里的中心和外框
function logoClip(cx, cy, size) {
  const k = size / LOGO_SIZE;
  return `<g data-part="logo-clip" transform="translate(${cx} ${cy}) scale(${k.toFixed(4)}) translate(${-LOGO_CENTER[0]} ${-LOGO_CENTER[1]})" stroke="#1d3a8f" stroke-width="${(2.5 / k).toFixed(1)}" stroke-linejoin="round">${LOGO}</g>`;
}

// ── 耳朵和 AirPods ──（右边头发别在耳后，耳朵画在头发上面）
const EAR = [[702, 628], [716, 618], [732, 626], [740, 650], [736, 680], [720, 702], [704, 698]];
const AIRPOD = `<g data-part="airpod-r"><rect x="716" y="662" width="12" height="50" rx="6" fill="${C.pod}" stroke="${C.podLine}" stroke-width="2.2"/><path d="M723.5 668V706" stroke="${C.podShade}" stroke-width="3" stroke-linecap="round"/><ellipse cx="721" cy="658" rx="14" ry="12" fill="${C.pod}" stroke="${C.podLine}" stroke-width="2.2"/><ellipse cx="716" cy="655" rx="4.5" ry="3.5" fill="#9aa3b5"/></g>`;

// ── 身子 ──
const NECK = [[412, 790], [410, 840], [406, 894], [460, 894], [456, 840], [454, 790]];
const SHIRT = [[382, 872], [344, 882], [306, 900], [284, 926], [270, 968], [264, 1040], [260, 1220], [606, 1220], [602, 1040], [596, 968], [582, 926], [560, 900], [522, 882], [484, 872], [464, 890], [433, 898], [402, 890]];
const SLEEVE_L = [[284, 924], [252, 940], [232, 978], [234, 1024], [264, 1038], [278, 1020], [282, 976]];
const SLEEVE_R = [[582, 924], [614, 940], [634, 978], [632, 1024], [602, 1038], [588, 1020], [584, 976]];
const ARM_R = [[594, 1028], [626, 1028], [632, 1120], [636, 1220], [596, 1220], [592, 1120]];

// ── 比耶的手 ──（在头发前面、上衣后面；rig 放手时整只滑进胶囊）
const FOREARM = [[184, 840], [218, 840], [242, 920], [258, 1000], [220, 1008], [200, 930]];
const HAND = [[184, 850, "c"], [174, 828], [170, 800], [175, 778], [164, 746], [157, 716], [159, 698], [168, 689], [180, 692], [188, 724], [201, 764, "c"], [207, 728], [213, 702], [220, 690], [232, 686], [241, 695], [240, 730], [235, 766], [242, 786], [244, 812], [236, 836], [216, 850]];

function drawGirl() {
  DEFS = []; K = 0;
  const skinPart = (pts, shade, { w = 4, heavy = 1.6 } = {}) => P(spline(pts), C.skin) + (shade ? clipped(spline(pts), shade) : "") + R(pts, C.skinLine, { w, heavy });
  const thin = (pts, color, w, more = "") => B(pts, color, { w, taper: [0.4, 0.4], ends: [0, 0] }, more);

  // ── 头发 ──
  // 背后的长发：外沿一笔（两头藏在前面那层后面），发梢一段段收尖
  const longEdge = LONG.slice(0, 27);
  const hairLong = `<g data-part="hair-long">${P(spline(LONG), "url(#{id}-hair-long)")}`
    + [[[150, 860], [136, 1000], [126, 1170]], [[120, 900], [104, 1020], [100, 1118]], [[200, 900], [194, 1040], [190, 1178]], [[716, 860], [714, 1000], [716, 1132]], [[690, 900], [686, 1040], [684, 1180]], [[760, 900], [764, 1030], [770, 1120]]].map((d) => thin(d, C.strand, 2.4, ` opacity="0.6"`)).join("")
    + contour(longEdge, C.hairLine, { w: 5.5, side: -1 }).replace(/<path(?:(?!<path).)*$/, "")
    + `</g>`;
  const hairBack = `<g data-part="hair-back">${P(spline(BACK), "url(#{id}-hair-shade)")}</g>`;
  // 光泽：头顶一圈柔和的光带，下沿顺着发丝不规则地断开；再加几笔顺着发流的细高光
  const sheenBand = (top, bottom) => P(spline([...top, ...bottom]), "url(#{id}-sheen)");
  const sheen = clipped(spline(FRONT),
    sheenBand([[190, 440, "c"], [212, 398], [248, 364], [292, 340], [338, 334, "c"]], [[324, 360, "c"], [312, 344, "c"], [296, 388, "c"], [280, 360, "c"], [262, 396, "c"], [246, 382, "c"], [230, 424, "c"], [214, 412, "c"]])
    + sheenBand([[364, 334, "c"], [398, 322], [433, 318], [468, 322], [502, 334, "c"]], [[490, 352, "c"], [476, 342, "c"], [460, 384, "c"], [446, 346, "c"], [428, 378, "c"], [412, 344, "c"], [394, 364, "c"], [380, 346, "c"]])
    + `<g opacity="0.55">${sheenBand([[530, 340, "c"], [572, 346], [612, 366], [646, 392], [668, 428, "c"]], [[654, 424, "c"], [642, 446, "c"], [626, 404, "c"], [610, 424, "c"], [592, 378, "c"], [576, 396, "c"], [558, 358, "c"], [544, 362, "c"]])}</g>`
    + [[[300, 352], [282, 398], [270, 446]], [[392, 334], [386, 380], [384, 420]], [[512, 336], [522, 376], [530, 420]], [[124, 560], [120, 660], [128, 760]], [[748, 600], [750, 680], [744, 760]]]
      .map((d, k) => thin(d, C.sheen, k < 3 ? 5 : 4, ` opacity="${k < 3 ? 0.4 : 0.3}"`)).join(""));
  const shade = clipped(spline(FRONT),
    P(spline([[566, 286], [668, 336], [720, 398], [746, 474], [754, 540], [756, 610], [752, 690], [746, 768], [740, 846], [732, 906], [716, 840], [710, 770], [710, 700], [708, 630], [700, 560], [694, 544], [690, 470], [660, 404], [604, 336]]), "url(#{id}-hair-shade)", ` opacity="0.7"`)
    + P(spline([[214, 550], [204, 620], [200, 700], [194, 780], [184, 856], [170, 908], [168, 830], [170, 720], [176, 620], [188, 540]]), "url(#{id}-hair-shade)", ` opacity="0.65"`));
  const strands = [
    [[433, 300], [396, 380], [372, 450]], [[433, 300], [446, 380], [456, 450]], [[433, 300], [480, 380], [508, 450]],
    [[300, 330], [262, 400], [250, 460]], [[566, 330], [604, 400], [616, 460]],
    [[150, 520], [140, 660], [150, 790], [166, 890]], [[742, 520], [746, 660], [744, 790], [744, 890]],
  ].map((d) => thin(d, C.strand, 2.4, ` opacity="0.55"`)).join("");
  // 透过空气刘海飘下来的几根细发
  // 刘海的发束：弧边的叶形，两侧下半截描线、收到发梢的尖；中线上一笔淡淡的光
  const leafPts = ([[rx, ry], [tx, ty], w, b]) => {
    const len = Math.hypot(tx - rx, ty - ry), ux = (tx - rx) / len, uy = (ty - ry) / len, nx = -uy, ny = ux;
    const mid = (t) => { const cx = (rx + tx) / 2 + nx * b, cy = (ry + ty) / 2 + ny * b, u = 1 - t; return [u * u * rx + 2 * u * t * cx + t * t * tx, u * u * ry + 2 * u * t * cy + t * t * ty]; };
    const side = (sg) => [[0, 1], [0.16, 0.98], [0.36, 0.92], [0.62, 0.72], [0.86, 0.38]].map(([t, k]) => { const [mx, my] = mid(t); return [mx + sg * nx * (w / 2) * k, my + sg * ny * (w / 2) * k]; });
    return { left: side(1), right: side(-1), tip: [tx, ty], mid };
  };
  const leaves = LEAVES.map((L) => {
    const { left, right, tip, mid } = leafPts(L);
    const shape = [...left, [...tip, "c"], ...right.slice().reverse()];
    return P(spline(shape), "url(#{id}-hair)")
      + B([...left.slice(1), tip], "#1b1930", { w: 3, taper: [0.7, 0.12], ends: [0, 0.3] }) + B([...right.slice(1), tip], "#1b1930", { w: 3.4, taper: [0.7, 0.12], ends: [0, 0.3] })
      + thin([mid(0.18), mid(0.42), mid(0.62)], C.sheen, 4, ` opacity="0.25"`);
  }).join("");
  const ahoge = B([[442, 266], [436, 236], [446, 212], [470, 200], [490, 206]], "url(#{id}-hair)", { w: 12, taper: [0.1, 0.85], ends: [1, 0] })
    + B([[424, 266], [416, 248], [404, 238]], "url(#{id}-hair)", { w: 6, taper: [0.1, 0.9], ends: [1, 0] });
  const outer = B([...LOCK_L_OUT, ...CROWN, ...LOCK_R_OUT].map((p) => p.slice(0, 2)), C.hairLine, { w: 6, heavy: 1.7, side: 1, taper: [0.06, 0.06], ends: [0.2, 0.2] });
  const inner = B([[732, 906], ...LOCK_R_IN, [694, 544]], "#1b1930", { w: 3.4, taper: [0.15, 0.2], ends: [0.3, 0.2] })
    + B(FRINGE.map((q) => q.slice(0, 2)), "#1b1930", { w: 2.2, taper: [0.2, 0.2], ends: [0.2, 0.2] })
    + B([[214, 550], ...LOCK_L_IN, [170, 908]], "#1b1930", { w: 3.4, taper: [0.2, 0.15], ends: [0.2, 0.3] });
  const hairFront = `<g data-part="hair-front">${ahoge}${P(spline(FRONT), "url(#{id}-hair)")}${shade}${sheen}${strands}${outer}${inner}${leaves}`
    + logoClip(214, 432, 88)
    + `</g>`;

  // ── 脸 ──
  const leafShadow = LEAVES.map((L) => { const { left, right, tip } = leafPts(L); return P(spline([...left, [...tip, "c"], ...right.slice().reverse()].map(([x, y, c]) => (c ? [x + 3, y + 13, c] : [x + 3, y + 13]))), C.skinShade); }).join("");
  const faceShade = clipped(spline(FACE),
    `<g opacity="0.75">${P(spline([[160, 420], ...FRINGE.map(([x, y]) => [x + 3, y + 13]).reverse(), [712, 420]]), C.skinShade)}${leafShadow}</g>`
    + P(spline([[706, 560], [710, 640], [702, 698], [680, 744], [640, 782], [596, 808], [610, 788], [648, 754], [672, 712], [682, 650], [680, 580]]), C.skinShade2));
  const face = `<g data-part="face">${P(spline(FACE), C.skin)}${faceShade}${B(JAW, C.skinLine, { w: 4.2, taper: [0.18, 0.18], ends: [0.2, 0.2], side: -1, heavy: 1.9 })}</g>`;
  const blush = `<g data-part="blush"><ellipse cx="258" cy="748" rx="46" ry="22" fill="url(#{id}-blush)"/><ellipse cx="608" cy="748" rx="46" ry="22" fill="url(#{id}-blush)"/></g>`;
  const nose = `<g data-part="nose">${B([[428, 730], [433, 735], [438, 734]], C.nose, { w: 2.8, taper: [0.5, 0.5], ends: [0.3, 0.3] })}</g>`;
  const ear = `<g data-part="ear-r">${P(spline(EAR), C.skin)}${clipped(spline(EAR), P(spline([[724, 626], [742, 650], [738, 684], [720, 704], [728, 680], [732, 652]]), C.skinShade))}${R(EAR, C.skinLine, { w: 3.2, heavy: 1.5 })}${thin([[714, 638], [726, 640], [729, 660], [722, 680]], C.skinLine, 2.4, ` opacity="0.8"`)}</g>`;
  const head = `<g data-part="head" data-pivot="444 806">${hairBack}${face}${blush}${nose}${eye("l")}${eye("r")}${closedEye("l")}${closedEye("r")}${MOUTH}${MOUTH_OPEN()}`
    + `${hairFront}<g data-part="brows" opacity="0.6">${brow("l")}${brow("r")}</g>${ear}${AIRPOD}</g>`;

  // ── 身子 ──
  const neck = `<g data-part="neck">${P(spline(NECK), C.skin)}${clipped(spline(NECK), P(spline([[400, 790], [433, 846], [466, 790], [466, 858], [433, 874], [400, 858]]), C.skinShade))}`
    + B([[411, 806], [409, 850], [406, 890]], C.skinLine, { w: 3, taper: [0.3, 0.3], ends: [0.2, 0.2] }) + B([[455, 806], [457, 850], [460, 890]], C.skinLine, { w: 3.4, taper: [0.3, 0.3], ends: [0.2, 0.2] }) + `</g>`;
  const cloth = (pts, shadeD) => P(spline(pts), C.shirt) + (shadeD ? clipped(spline(pts), P(shadeD, C.shirtShade)) : "") + R(pts, C.shirtLine, { w: 4, heavy: 1.7 });
  const shirt = `<g data-part="shirt">${cloth(SHIRT, spline([[540, 900], [582, 926], [596, 968], [602, 1040], [606, 1220], [550, 1220], [560, 1100], [562, 1000], [556, 940]]) + spline([[382, 872], [433, 898], [484, 872], [488, 886], [433, 914], [378, 886]]))}`
    + B([[388, 878], [410, 892], [433, 902], [456, 892], [478, 878]], C.shirtLine, { w: 2.2, taper: [0.3, 0.3], ends: [0, 0] }, ` opacity="0.6"`) + `</g>`;
  const sleeves = `<g data-part="sleeves">${cloth(SLEEVE_L, spline([[264, 1038], [278, 1020], [282, 976], [284, 924], [270, 960], [266, 1006]]))}${cloth(SLEEVE_R, spline([[602, 1038], [632, 1024], [634, 978], [614, 940], [620, 990], [612, 1022]]))}</g>`;
  const armR = `<g data-part="arm-r">${skinPart(ARM_R, P(spline([[612, 1028], [626, 1028], [632, 1120], [636, 1220], [618, 1220], [616, 1120]]), C.skinShade))}</g>`;
  const body = `<g data-part="body" data-pivot="388 1182">${armR}${neck}${shirt}${sleeves}</g>`;

  // ── 比耶的手 ──：手心朝外，食指和中指比 V，拇指压住弯下去的两根手指
  const hand = `<g data-part="arm-peace" data-pivot="268 912">`
    + skinPart(FOREARM, P(spline([[204, 840], [216, 840], [238, 920], [254, 1000], [236, 1004], [222, 924]]), C.skinShade), { w: 3.6 })
    + P(spline(HAND), C.skin)
    + clipped(spline(HAND), P(spline([[233, 766], [240, 786], [242, 812], [234, 836], [216, 850], [222, 828], [228, 800], [226, 776]]), C.skinShade) + P(spline([[180, 694], [186, 726], [201, 766], [192, 760], [182, 728]]), C.skinShade) + P(spline([[239, 698], [237, 732], [233, 766], [226, 756], [230, 724]]), C.skinShade))
    + contour(HAND, C.skinLine, { w: 3.6, heavy: 1.5, ends: 0.35, taper: 0.1 })
    + thin([[241, 798], [224, 808], [202, 812], [186, 806]], C.skinLine, 3) + thin([[178, 788], [190, 782], [200, 786]], C.skinLine, 2.4, ` opacity="0.85"`)
    + `</g>`;

  const handMask = `<mask id="{id}-hand" maskUnits="userSpaceOnUse" x="20" y="140" width="960" height="1080"><rect x="20" y="140" width="960" height="1080" fill="#fff"/>`
    + [SHIRT, SLEEVE_L, SLEEVE_R].map((d) => `<path d="${spline(d)}" fill="#000" stroke="#000" stroke-width="4"/>`).join("") + `</mask>`;
  const defs = lin("hair", [[0, "#2a2534"], [0.35, "#262a45"], [0.7, "#2b3666"], [1, "#3a4a94"]], 260, 900)
    + lin("hair-shade", [[0, "#15131e"], [0.4, "#171b31"], [0.75, "#1c2550"], [1, "#25336f"]], 260, 900)
    + lin("hair-long", [[0, "#1d1b29"], [0.45, "#212849"], [1, "#34428c"]], 650, 1180)
    + lin("sheen", [[0, "#aebde8", 0.1], [0.3, "#aebde8", 0.42], [1, "#aebde8", 0.03]], 318, 446)
    + `<linearGradient id="{id}-iris" x1="0" y1="0" x2="0" y2="1">${stops([[0, "#161a33"], [0.45, "#28346c"], [0.8, "#4f6fb2"], [1, "#89a8de"]])}</linearGradient>`
    + `<radialGradient id="{id}-blush">${stops([[0, "#ffadb9", 0.55], [0.6, "#ffadb9", 0.25], [1, "#ffadb9", 0]])}</radialGradient>`
    + `<linearGradient id="{id}-logo" x1="0" y1="1" x2="0" y2="0">${stops([[0, "#2459C5"], [0.45, "#2E6BDE"], [1, "#3980F8"]])}</linearGradient>`
    + DEFS.join("") + handMask;
  return `<defs>${defs}</defs><g data-part="miles">${hairLong}${body}${head}<g mask="url(#{id}-hand)">${hand}</g></g>`;
}
module.exports = { drawGirl };
