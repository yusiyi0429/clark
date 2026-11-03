// 女伙伴形象 Mia「原版」的画法（2026-11-03）：照孙铭泽给的参考图，正常动漫比例的头肩半身像，安静好看。
// 黑发从发根渐变到发尾的深蓝紫；头发柔顺，刘海侧分、一缕缕长短不一地扫向左边，缝里透出额头；右边头发别在耳后露出 AirPods。
// 只留天枢 logo 发夹（在参考图小兔发夹的位置）；白色吊带配蕾丝边。线条细、带颜色、两头收尖（ink.cjs），阴影用柔和的晕染。
// 和 milesRig 的约定照旧：同样的 data-part 和三个转轴；眼珠 iris-l/r 裁在眼眶里；比耶的手被吊带的剪影遮住。
const { spline } = require("./lib.cjs");
const { brush, ring } = require("./ink.cjs");
const fs = require("fs");
const path = require("path");

const C = {
  hairLine: "#0d0b14", hairInner: "#14121d", sheen: "#a3b3e2", glint: "#a8b0f0", strandLight: "#5d6ca8", strandDark: "#0b0a12",
  skin: "#fff1eb", skinShade: "#f0cdc4", skinDeep: "#e5b2a7", skinLine: "#c08a7f", nose: "#cf9488",
  lash: "#271d2b", brow: "#3b3040", pupil: "#0c0e1d", irisRim: "#141629", irisGlow: "#b4cbf5", lid: "#3a3450", socketRim: "#b48d8a",
  mouthLine: "#ad676c", lip: "#e9a0a6", mouthIn: "#c35f6c", tongue: "#f19aa6",
  cami: "#ffffff", camiShade: "#e7e4ee", camiLine: "#a9a3bc", lace: "#b6afc6",
  pod: "#ffffff", podShade: "#dfe3ec", podLine: "#8c94a8",
};

// ── 小工具 ──
let DEFS = [], K = 0;
const P = (d, fill, more = "") => `<path d="${d}" fill="${fill}"${more}/>`;
const B = (pts, fill, opts = {}, more = "") => `<path d="${brush(pts, opts)}" fill="${fill}"${more}/>`;
const R = (pts, fill, opts = {}, more = "") => `<path d="${ring(pts, opts)}" fill="${fill}" fill-rule="evenodd"${more}/>`;
const thin = (pts, color, w, more = "") => B(pts, color, { w, taper: [0.4, 0.4], ends: [0, 0], step: 28 }, more);
/** 把内容裁在某个形状里（阴影、高光只落在底色上）。 */
const clipped = (d, content) => { const id = `{id}-k${++K}`; DEFS.push(`<clipPath id="${id}"><path d="${d}"/></clipPath>`); return `<g clip-path="url(#${id})">${content}</g>`; };
const soft = (content, level = 1) => `<g filter="url(#{id}-soft${level})">${content}</g>`;
const stops = (list) => list.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}"${a === undefined ? "" : ` stop-opacity="${a}"`}/>`).join("");
const lin = (id, list, y1, y2) => `<linearGradient id="{id}-${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${y1}" x2="0" y2="${y2}">${stops(list)}</linearGradient>`;
const shift = (pts, dx, dy) => pts.map(([x, y, c]) => (c ? [x + dx, y + dy, c] : [x + dx, y + dy]));
/** 闭合轮廓在尖角处断开，一段一段画线：发梢处两头收尖。side 1 = 顺时针。 */
function contour(pts, color, { w = 3, heavy = 1.5, side = 1, ends = 0.25, taper = 0.14 } = {}) {
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

/** 一缕头发：发根到发梢的三次曲线中线，宽度从发根往发梢收尖；b1、b2 让中线弯（正 = 朝中线左手边鼓）。 */
function lock([rx, ry], [tx, ty], w, b1 = 0, b2 = 0) {
  const len = Math.hypot(tx - rx, ty - ry), ux = (tx - rx) / len, uy = (ty - ry) / len, nx = -uy, ny = ux;
  const c1 = [rx + (tx - rx) / 3 + nx * b1, ry + (ty - ry) / 3 + ny * b1], c2 = [rx + (2 * (tx - rx)) / 3 + nx * b2, ry + (2 * (ty - ry)) / 3 + ny * b2];
  const mid = (t) => { const u = 1 - t; return [u * u * u * rx + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * tx, u * u * u * ry + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * ty]; };
  const normal = (t) => { const a = mid(Math.max(0, t - 0.01)), b = mid(Math.min(1, t + 0.01)); const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l]; };
  const ts = [0, 0.18, 0.38, 0.58, 0.76, 0.9];
  const half = (t) => (w / 2) * (1 - Math.pow(t, 2.6));
  const side = (sg) => ts.map((t) => { const [mx, my] = mid(t), [qx, qy] = normal(t); return [mx + sg * qx * half(t), my + sg * qy * half(t)]; });
  const left = side(1), right = side(-1);
  return { left, right, tip: [tx, ty], mid, shape: [...left, [tx, ty, "c"], ...right.slice().reverse()] };
}

// ── 脸 ──（正常比例的鹅蛋脸，小下巴；额头那截藏在刘海下面，填色要连上去）
const FACE = [[312, 392], [376, 356], [440, 346], [504, 356], [568, 392], [586, 444], [592, 500], [588, 552], [574, 602], [550, 646], [520, 686], [488, 714], [460, 730], [440, 736], [420, 730], [392, 714], [360, 686], [330, 646], [306, 602], [292, 552], [288, 500], [294, 444]];
const JAW = [[294, 560], [306, 602], [330, 646], [360, 686], [392, 714], [420, 730], [440, 736], [460, 730], [488, 714], [520, 686], [550, 646], [574, 602], [584, 566]];

// ── 头发 ──
// 头顶到左边那片垂发（跟着头动，在脸前面）：顺时针，从左边垂发最外那缕发梢起，沿外沿上去、过头顶，到右边耳朵上方折回，沿发际线（被刘海盖住）回到左边，再沿垂发内沿下来。
const CURTAIN_OUT = [[236, 1000, "c"], [222, 930], [218, 840], [226, 748], [240, 656], [254, 564], [268, 482], [286, 420]];
const CROWN = [[312, 352], [360, 298], [420, 266], [476, 256], [528, 266], [578, 300], [614, 352], [634, 420], [640, 488]];
const TEMPLE_R = [[628, 524], [606, 512], [598, 458], [572, 452], [548, 454], [520, 460], [492, 468], [462, 470], [432, 466], [404, 462], [376, 458], [350, 454], [326, 452], [306, 456]];
const CURTAIN_IN = [[304, 480], [300, 548], [304, 624], [316, 700], [324, 780], [318, 860], [302, 936], [282, 992, "c"], [270, 956], [258, 1024, "c"], [248, 970]];
const FRONT = [...CURTAIN_OUT, ...CROWN, ...TEMPLE_R, ...CURTAIN_IN];
// 头后面那层（跟着头动，在脸后面）：右边耳后到下颌那一截看得到
const BACK = [[286, 420], ...CROWN, [648, 560], [652, 640], [640, 712, "c"], [560, 724], [440, 744], [320, 724], [270, 700, "c"], [262, 560]];
// 背后的长发（不跟着头转，在身子后面）：脖子两边、右肩后面看得到，一直垂到腰下
const LONG = [[300, 620, "c"], [262, 720], [236, 840], [214, 960], [200, 1080], [196, 1170, "c"], [236, 1120], [262, 1186, "c"], [300, 1130], [440, 1150], [580, 1130], [618, 1188, "c"], [646, 1124], [684, 1172, "c"], [690, 1080], [682, 960], [672, 840], [662, 720], [646, 620, "c"], [470, 600]];

// 刘海：侧分（分缝在右边 x≈490），一缕缕弯着扫向左边，长短宽窄不一；一缕细的落在两眼之间；分缝右边几缕短的扫向右鬓
// [发根, 发梢, 宽, 弯1, 弯2]，从后往前画（后画的压在上面）
const BANGS = [
  [[530, 318], [624, 490], 34, -18, -4],
  [[514, 312], [600, 500], 58, -26, -4],
  [[504, 318], [566, 516], 48, -16, 4],
  [[496, 326], [492, 514], 32, -8, 6],
  [[468, 298], [298, 478], 80, 56, 18],
  [[474, 304], [318, 520], 70, 50, 10],
  [[480, 310], [354, 516], 60, 40, 2],
  [[484, 316], [394, 514], 50, 30, -2],
  [[488, 322], [434, 532], 40, 18, -6],
  [[492, 330], [452, 528], 12, 8, -4],
  [[522, 322], [586, 510], 26, -10, 4],
];
const WISPS = [[[466, 344], [350, 512], 10, 22, 8], [[520, 330], [618, 500], 8, -16, -8]];

// ── 眼睛 ──（杏仁眼，看得到眼白；眼眶钉在脸上，眼珠 iris-l/r 裁在眼眶里：rig 转眼时只移眼珠，眨眼时整只合上）
const EYES = { l: { cx: 374, cy: 552, o: -1 }, r: { cx: 506, cy: 552, o: 1 } };
function socketPts(side) {
  const { cx, cy, o } = EYES[side];
  const X = (dx) => cx + o * dx;
  return [[X(-49), cy + 5, "c"], [X(-32), cy - 22], [X(-9), cy - 31], [X(16), cy - 31], [X(38), cy - 19], [X(52), cy + 5, "c"], [X(37), cy + 19], [X(12), cy + 26], [X(-16), cy + 24], [X(-37), cy + 16]];
}
function eye(side) {
  const { cx, cy, o } = EYES[side];
  const X = (dx) => cx + o * dx;
  const sock = spline(socketPts(side));
  const ix = cx + o * 2, iy = cy - 1;
  const iris = `<g data-part="iris-${side}">`
    + `<ellipse cx="${ix}" cy="${iy}" rx="31" ry="35" fill="url(#{id}-iris)"/>`
    + `<ellipse cx="${ix}" cy="${iy - 21}" rx="35" ry="19" fill="#0b0d1e" opacity="0.5"/>`
    + `<ellipse cx="${ix}" cy="${iy + 1}" rx="12.5" ry="17" fill="${C.pupil}" opacity="0.92"/>`
    + soft(`<path d="M${ix - 24} ${iy + 13}Q${ix} ${iy + 42} ${ix + 24} ${iy + 13}Q${ix} ${iy + 27} ${ix - 24} ${iy + 13}Z" fill="${C.irisGlow}" opacity="0.85"/>`, 2)
    + `<path d="M${ix - 19} ${iy + 17}Q${ix} ${iy + 36} ${ix + 19} ${iy + 17}" fill="none" stroke="#d6e4ff" stroke-width="2" stroke-linecap="round" opacity="0.55"/>`
    + `<ellipse cx="${ix}" cy="${iy}" rx="31" ry="35" fill="none" stroke="${C.irisRim}" stroke-width="2.4"/>`
    + `<circle cx="${ix - 11}" cy="${iy - 13}" r="8.5" fill="#fff" opacity="0.95"/>`
    + `<circle cx="${ix + 12}" cy="${iy + 12}" r="4" fill="#fff" opacity="0.9"/>`
    + `</g>`;
  const lash = [[X(-49), cy + 4], [X(-32), cy - 23], [X(-9), cy - 33], [X(16), cy - 33], [X(38), cy - 21], [X(53), cy + 3], [X(63), cy + 1]];
  return `<g data-part="eye-${side}">`
    + soft(`<ellipse cx="${X(14)}" cy="${cy - 40}" rx="48" ry="12" fill="#dc9a9c" opacity="0.38"/><ellipse cx="${X(46)}" cy="${cy - 20}" rx="18" ry="11" fill="#d48f95" opacity="0.32"/>`, 2)
    + P(sock, "#fff")
    + clipped(sock, iris + soft(`<ellipse cx="${cx}" cy="${cy - 26}" rx="58" ry="15" fill="${C.lid}" opacity="0.38"/>`, 2))
    + `<path d="${sock}" fill="none" stroke="${C.socketRim}" stroke-width="1.3" opacity="0.5"/>`
    + B([[X(-22), cy - 43], [X(7), cy - 48], [X(38), cy - 38]], C.skinLine, { w: 2, taper: [0.5, 0.5], ends: [0, 0] }, ` opacity="0.45"`)
    + B(lash, C.lash, { w: 9.5, taper: [0.55, 0.2], ends: [0.08, 0.05], profile: (s) => 0.5 + 0.75 * s })
    + B([[X(43), cy - 12], [X(55), cy - 20], [X(65), cy - 20]], C.lash, { w: 3.2, taper: [0.2, 0.8], ends: [0.5, 0] })
    + B([[X(50), cy - 4], [X(62), cy - 6], [X(71), cy - 2]], C.lash, { w: 3, taper: [0.2, 0.8], ends: [0.5, 0] })
    + B([[X(53), cy + 4], [X(63), cy + 8], [X(69), cy + 14]], C.lash, { w: 2.5, taper: [0.2, 0.8], ends: [0.5, 0] })
    + B([[X(52), cy + 7], [X(36), cy + 20], [X(11), cy + 27]], C.lash, { w: 2.2, taper: [0.35, 0.6], ends: [0.3, 0] }, ` opacity="0.6"`)
    + B([[X(-30), cy + 20], [X(-44), cy + 13]], C.lash, { w: 1.6, taper: [0.5, 0.5], ends: [0, 0] }, ` opacity="0.35"`)
    + `</g>`;
}
const closedEye = (side) => {
  const { cx, cy, o } = EYES[side];
  const X = (dx) => cx + o * dx;
  return `<g data-part="eye-${side}-closed" display="none">${B([[X(-49), cy + 4], [X(-18), cy + 14], [X(16), cy + 14], [X(48), cy + 4], [X(60), cy - 2]], C.lash, { w: 6.2, taper: [0.5, 0.3], ends: [0.1, 0.1] })}${B([[X(50), cy], [X(62), cy + 3], [X(69), cy + 9]], C.lash, { w: 2.6, taper: [0.2, 0.8], ends: [0.5, 0] })}</g>`;
};
// 眉毛细、平缓，透过刘海露出来：画在头发上面，半透明
const BROWS = [[[324, 490], [350, 477], [386, 472], [414, 478]], [[466, 478], [494, 472], [530, 477], [556, 490]]];

// ── 嘴 ──：平时是淡淡的浅笑；在说话时 rig 换成小小的张嘴，并跟着音节缩放
const OPEN = [[426, 656, "c"], [440, 659], [454, 656, "c"], [450, 668], [440, 673], [430, 668]];

// ── 天枢 logo 发夹 ──：直接读 apps/web/src/app/icon.svg 里的六片花瓣，品牌蓝；和品牌图标一模一样
const LOGO = fs.readFileSync(path.join(__dirname, "../../../apps/web/src/app/icon.svg"), "utf8").match(/<g transform="[^"]+">(.*?)<\/g>/s)[1]
  .replace(/fill="url\(#tk-p\d\)"/g, 'fill="url(#{id}-logo)"');
const LOGO_CENTER = [632.4, 615.4], LOGO_SIZE = 735.2; // 花瓣在原图坐标里的中心和外框
function logoClip(cx, cy, size) {
  const k = size / LOGO_SIZE;
  return `<g data-part="logo-clip" transform="translate(${cx} ${cy}) scale(${k.toFixed(4)}) translate(${-LOGO_CENTER[0]} ${-LOGO_CENTER[1]})" stroke="#1d3a8f" stroke-width="${(2 / k).toFixed(1)}" stroke-linejoin="round">${LOGO}</g>`;
}

// ── 耳朵和 AirPods ──（右边头发别在耳后，耳朵画在头发上面）
const EAR = [[600, 534], [614, 522], [628, 530], [636, 556], [632, 588], [616, 610], [600, 604]];
const AIRPOD = `<g data-part="airpod-r"><rect x="609" y="568" width="10" height="42" rx="5" fill="${C.pod}" stroke="${C.podLine}" stroke-width="1.8"/><path d="M615 573V605" stroke="${C.podShade}" stroke-width="2.4" stroke-linecap="round"/><ellipse cx="614" cy="564" rx="11" ry="9.5" fill="${C.pod}" stroke="${C.podLine}" stroke-width="1.8"/><ellipse cx="610" cy="562" rx="3.6" ry="2.8" fill="#9aa3b5"/></g>`;

// ── 身子 ──：细长的脖子、锁骨，肩膀露在胶囊上沿之上；白色吊带配蕾丝边
const NECK = [[410, 660], [472, 660], [474, 750], [482, 798], [398, 798], [406, 750]];
const TORSO = [[400, 786], [370, 808], [314, 826], [268, 848], [242, 884], [232, 960], [226, 1220], [656, 1220], [650, 960], [640, 884], [614, 848], [566, 826], [510, 808], [480, 786]];
const CAMI = [[296, 904], [360, 914], [440, 920], [520, 914], [588, 904], [604, 980], [614, 1220], [266, 1220], [278, 980]];
const STRAPS = [[[334, 908], [336, 866], [340, 826]], [[546, 908], [544, 866], [540, 826]]];

// ── 比耶的手 ──（手心朝外，中指和食指比 V，拇指压住弯下去的无名指和小指；在头发前面、吊带后面，rig 放手时整只滑进胶囊）
const FOREARM = [[225, 724], [248, 726], [252, 800], [256, 900], [260, 1080], [210, 1090], [206, 920], [212, 812]];
const HAND = [[222, 728, "c"], [208, 704], [200, 674], [198, 648], [202, 626], [214, 612], [212, 590], [204, 556], [200, 528], [202, 512], [210, 504], [220, 506], [224, 534], [230, 566], [236, 594, "c"], [242, 566], [250, 534], [256, 512], [262, 502], [272, 502], [278, 512], [274, 546], [268, 584], [266, 602], [278, 616], [288, 636], [286, 662], [276, 692], [262, 716], [250, 730, "c"]];

function drawGirl() {
  DEFS = []; K = 0;

  // ── 头发 ──
  const hairLong = `<g data-part="hair-long">${P(spline(LONG), "url(#{id}-hair-long)")}`
    + clipped(spline(LONG), soft(P(spline([[600, 640], [660, 720], [676, 900], [690, 1100], [640, 1140], [620, 900], [606, 760]]), "#0a0911", ` opacity="0.5"`)))
    + soft(B([[652, 760], [664, 900], [670, 1040]], C.sheen, { w: 12, taper: [0.4, 0.4], ends: [0, 0] }, ` opacity="0.22"`) + B([[640, 1060], [652, 1110], [664, 1150]], C.glint, { w: 12, taper: [0.4, 0.4], ends: [0, 0] }, ` opacity="0.3"`), 2)
    + [[[648, 740], [660, 880], [666, 1020], [670, 1140]], [[628, 780], [638, 920], [644, 1060]], [[606, 840], [616, 980], [622, 1100]]].map((d) => thin(d, C.glint, 1.5, ` opacity="0.42"`)).join("")
    + [[[640, 700], [656, 880], [660, 1060], [664, 1150]], [[620, 760], [630, 920], [636, 1100]], [[262, 760], [238, 900], [224, 1060], [214, 1150]], [[580, 860], [596, 1000], [606, 1120]], [[660, 780], [672, 920], [676, 1060]]]
      .map((d, i) => thin(d, i % 2 ? C.strandDark : C.strandLight, 1.8, ` opacity="${i % 2 ? 0.6 : 0.4}"`)).join("")
    + B(LONG.slice(0, 6).map((p) => p.slice(0, 2)), C.hairLine, { w: 3.4, side: -1, heavy: 1.4, taper: [0.2, 0.1], ends: [0, 0.3] })
    + B(LONG.slice(14, 19).map((p) => p.slice(0, 2)).reverse(), C.hairLine, { w: 3.4, side: 1, heavy: 1.4, taper: [0.2, 0.1], ends: [0, 0.3] })
    + contour([[196, 1170, "c"], ...LONG.slice(6, 13), [618, 1188, "c"]].concat([[646, 1124], [684, 1172, "c"]]), C.hairLine, { w: 3, side: -1, heavy: 1.3 }).replace(/<path(?:(?!<path).)*$/, "")
    + `</g>`;
  // 和背后长发用同一个渐变：两层在下颌下面交接，颜色接得上就看不出接缝
  const hairBack = `<g data-part="hair-back">${P(spline(BACK), "url(#{id}-hair-long)")}</g>`;

  const front = spline(FRONT);
  const bangs = BANGS.map((b) => lock(...b));
  const wisps = WISPS.map((b) => lock(...b));
  // 柔光：头顶一条弧形的光带（晕开），上面几笔顺着发流的细高光
  const sheen = clipped(front,
    soft(B([[296, 440], [326, 370], [378, 322], [430, 302], [470, 300]], C.sheen, { w: 34, taper: [0.35, 0.35], ends: [0, 0] }, ` opacity="0.42"`)
      + B([[516, 306], [566, 330], [606, 378], [622, 430]], C.sheen, { w: 22, taper: [0.4, 0.4], ends: [0, 0] }, ` opacity="0.22"`)
      + B([[236, 620], [228, 720], [226, 820]], C.sheen, { w: 14, taper: [0.4, 0.4], ends: [0, 0] }, ` opacity="0.25"`)
      + B([[270, 600], [262, 720], [264, 840], [274, 940]], C.glint, { w: 16, taper: [0.4, 0.4], ends: [0, 0] }, ` opacity="0.22"`)
      + B([[244, 900], [250, 950], [262, 990]], C.glint, { w: 12, taper: [0.4, 0.4], ends: [0, 0] }, ` opacity="0.25"`), 2)
    + [[[306, 420], [334, 366], [376, 330]], [[330, 424], [362, 368], [404, 330]], [[358, 420], [390, 364], [436, 326]], [[410, 330], [440, 314], [470, 312]], [[530, 320], [566, 344], [590, 378]], [[560, 330], [594, 362], [612, 404]],
      [[232, 620], [228, 720], [226, 820], [230, 900]], [[250, 600], [244, 700], [240, 800]], [[270, 560], [266, 680], [270, 800], [276, 900]]]
      .map((d, i) => thin(d, C.sheen, i < 6 ? 2.2 : 1.8, ` opacity="${i < 6 ? 0.55 : 0.35}"`)).join("")
    + [[[452, 270], [404, 296], [356, 340], [322, 400]], [[462, 268], [420, 304], [384, 352], [360, 404]], [[498, 268], [548, 296], [592, 346]], [[300, 470], [290, 580], [288, 700], [294, 820]],
      [[284, 520], [276, 640], [276, 760], [284, 880], [280, 960]], [[256, 560], [248, 680], [246, 800], [250, 920], [256, 1000]], [[238, 700], [234, 820], [238, 940], [236, 990]]]
      .map((d, i) => thin(d, C.glint, i < 3 ? 1.6 : 1.5, ` opacity="${i < 3 ? 0.55 : 0.45}"`)).join(""));
  const shade = clipped(front,
    soft(P(spline([[560, 300], [620, 360], [640, 450], [636, 520], [600, 470], [576, 400], [540, 340]]), "#08070d", ` opacity="0.45"`)
      + P(spline([[296, 480], [292, 600], [300, 720], [304, 840], [292, 940], [270, 940], [272, 800], [270, 650], [276, 520]]), "#08070d", ` opacity="0.4"`), 1));
  const strands = [
    [[470, 264], [410, 290], [350, 336], [310, 410]], [[476, 262], [430, 300], [390, 360]], [[490, 266], [540, 296], [584, 350]], [[500, 270], [560, 316], [600, 400]],
    [[296, 470], [282, 580], [280, 700], [288, 820], [282, 930]], [[262, 520], [250, 640], [244, 780], [246, 900]], [[240, 680], [232, 800], [232, 920]],
  ].map((d, i) => thin(d, i % 2 ? C.strandLight : C.strandDark, 1.7, ` opacity="${i % 2 ? 0.4 : 0.55}"`)).join("");
  // 头顶飘出来的几根碎发
  const flyaways = [[[322, 344], [304, 330], [292, 334]], [[598, 334], [618, 324], [630, 330]], [[262, 560], [246, 540], [240, 520]]]
    .map((d) => B(d, C.hairLine, { w: 2, taper: [0.2, 0.8], ends: [1, 0] }, ` opacity="0.8"`)).join("");
  const bangsDraw = bangs.map(({ shape, left, right, tip, mid }) =>
    P(spline(shape), "url(#{id}-hair)")
    + B([...left.slice(3), tip], C.hairInner, { w: 1.7, taper: [0.7, 0.12], ends: [0, 0.3] }, ` opacity="0.85"`)
    + B([...right.slice(3), tip], C.hairInner, { w: 2, taper: [0.7, 0.12], ends: [0, 0.3] }, ` opacity="0.85"`)
    + thin([mid(0.12), mid(0.3), mid(0.5)], C.sheen, 3, ` opacity="0.28"`)).join("");
  const wispsDraw = wisps.map(({ shape }) => P(spline(shape), "url(#{id}-hair)")).join("");
  const bangsShape = bangs.map(({ shape }) => spline(shape)).join("");
  const bangsSheen = clipped(bangsShape, soft(B([[312, 448], [348, 420], [392, 404], [430, 400]], C.sheen, { w: 14, taper: [0.4, 0.4], ends: [0, 0] }, ` opacity="0.2"`), 2));
  const ahoge = B([[452, 262], [456, 228], [474, 204], [500, 196], [516, 204]], "url(#{id}-hair)", { w: 7, taper: [0.1, 0.85], ends: [1, 0] });
  const outer = B([...CURTAIN_OUT, ...CROWN].map((p) => p.slice(0, 2)), C.hairLine, { w: 2.8, heavy: 1.45, side: 1, taper: [0.08, 0.12], ends: [0.15, 0.1] });
  const inner = B([[294, 500], ...CURTAIN_IN.slice(1, 6).map((p) => p.slice(0, 2)), [280, 980]], C.hairInner, { w: 2.6, taper: [0.2, 0.15], ends: [0, 0.3] })
    + contour([[280, 980, "c"], [264, 948], [250, 1008, "c"], [240, 960], [226, 990, "c"]], C.hairLine, { w: 2.8, heavy: 1.3 }).replace(/<path(?:(?!<path).)*$/, "");
  const hairFront = `<g data-part="hair-front">${ahoge}${flyaways}${P(front, "url(#{id}-hair)")}${shade}${sheen}${strands}${outer}${inner}${bangsDraw}${bangsSheen}${wispsDraw}`
    + logoClip(334, 330, 70)
    + `</g>`;

  // ── 脸 ──
  const face = `<g data-part="face">${P(spline(FACE), C.skin)}`
    + clipped(spline(FACE), soft(
      bangs.map(({ shape }) => P(spline(shift(shape, 4, 12)), C.skinShade, ` opacity="0.75"`)).join("")
      + P(spline([[300, 380], [580, 380], [600, 440], [440, 452], [280, 440]]), C.skinShade, ` opacity="0.6"`)
      + P(spline([[588, 500], [588, 580], [572, 630], [544, 676], [506, 712], [526, 672], [552, 624], [566, 560]]), C.skinShade, ` opacity="0.55"`)
      + P(spline([[452, 584], [460, 604], [456, 618], [448, 606]]), C.skinDeep, ` opacity="0.35"`), 1))
    + B(JAW, C.skinLine, { w: 2.8, taper: [0.2, 0.25], ends: [0, 0.1], side: -1, heavy: 1.6 })
    + `</g>`;
  const blush = `<g data-part="blush"><ellipse cx="338" cy="612" rx="42" ry="19" fill="url(#{id}-blush)"/><ellipse cx="542" cy="612" rx="42" ry="19" fill="url(#{id}-blush)"/></g>`;
  const nose = `<g data-part="nose">${B([[438, 618], [446, 620], [452, 617]], C.nose, { w: 2, taper: [0.5, 0.5], ends: [0.2, 0.2] })}</g>`;
  const mouth = `<g data-part="mouth">${B([[425, 657], [434, 661], [440, 662], [447, 661], [455, 657]], C.mouthLine, { w: 2.4, taper: [0.35, 0.35], ends: [0.1, 0.1] })}${soft(`<ellipse cx="440" cy="668" rx="9" ry="3" fill="${C.lip}" opacity="0.6"/>`, 2)}</g>`;
  const mouthOpen = `<g data-part="mouth-open" display="none">${P(spline(OPEN), C.mouthIn)}${clipped(spline(OPEN), `<ellipse cx="440" cy="673" rx="10" ry="6" fill="${C.tongue}"/>`)}${R(OPEN, C.mouthLine, { w: 1.8, heavy: 1.4 })}</g>`;
  const ear = `<g data-part="ear-r">${P(spline(EAR), C.skin)}${clipped(spline(EAR), soft(P(spline([[620, 530], [638, 556], [632, 590], [616, 612], [624, 586], [628, 556]]), C.skinShade), 2))}${R(EAR, C.skinLine, { w: 2.2, heavy: 1.5 })}${thin([[610, 540], [622, 542], [625, 562], [618, 582]], C.skinLine, 1.8, ` opacity="0.8"`)}</g>`;
  const brows = `<g data-part="brows" opacity="0.55">${BROWS.map((b) => B(b, C.brow, { w: 3.4, taper: [0.35, 0.6], ends: [0.2, 0] })).join("")}</g>`;
  const head = `<g data-part="head" data-pivot="444 806">${hairBack}${face}${blush}${nose}${eye("l")}${eye("r")}${closedEye("l")}${closedEye("r")}${mouth}${mouthOpen}`
    + `${hairFront}${brows}${ear}${AIRPOD}</g>`;

  // ── 身子 ──
  const torso = `<g data-part="torso">${P(spline(TORSO), C.skin)}`
    + clipped(spline(TORSO), soft(P(spline([[560, 830], [640, 884], [650, 1000], [600, 960], [590, 880]]), C.skinShade, ` opacity="0.7"`)
      + P(spline([[396, 790], [440, 812], [484, 790], [500, 830], [440, 846], [380, 830]]), C.skinShade, ` opacity="0.5"`), 1))
    + B(TORSO.slice(0, 7).map((p) => p.slice(0, 2)).reverse(), C.skinLine, { w: 2.6, taper: [0.15, 0.3], ends: [0.2, 0], side: 1, heavy: 1.4 })
    + B(TORSO.slice(8).map((p) => p.slice(0, 2)), C.skinLine, { w: 2.6, taper: [0.15, 0.3], ends: [0.2, 0], side: 1, heavy: 1.4 })
    + thin([[414, 836], [384, 843], [342, 838]], C.skinLine, 1.9, ` opacity="0.75"`) + thin([[466, 836], [496, 843], [538, 838]], C.skinLine, 1.9, ` opacity="0.75"`)
    + `</g>`;
  const neck = `<g data-part="neck">${P(spline(NECK), C.skin)}${clipped(spline(NECK), soft(`<ellipse cx="440" cy="730" rx="56" ry="34" fill="${C.skinShade}" opacity="0.9"/>`, 1))}`
    + thin([[410, 712], [408, 752], [400, 790]], C.skinLine, 2.2, ` opacity="0.85"`) + thin([[472, 712], [474, 752], [482, 790]], C.skinLine, 2.4, ` opacity="0.85"`) + `</g>`;
  let lace = "";
  for (let x = 300; x < 584; x += 15) { const y = 904 + Math.sin(((x - 296) / 292) * Math.PI) * 15; lace += `M${x} ${Math.round(y)}a7.5 6 0 0 0 15 0`; }
  const cami = `<g data-part="cami">${P(spline(CAMI), C.cami)}${clipped(spline(CAMI), soft(P(spline([[560, 900], [604, 980], [614, 1220], [560, 1220], [570, 1000]]), C.camiShade) + P(spline([[296, 904], [440, 920], [588, 904], [588, 930], [440, 944], [296, 930]]), C.camiShade, ` opacity="0.7"`), 1))}`
    + R(CAMI, C.camiLine, { w: 2.4, heavy: 1.5 })
    + `<path d="${lace}" fill="#fff" stroke="${C.lace}" stroke-width="1.4"/>`
    + STRAPS.map((s) => B(s, "#fff", { w: 9, taper: [0, 0], ends: [1, 1] }) + `<path d="M${s[0][0] - 4} ${s[0][1]}L${s[2][0] - 4} ${s[2][1]}M${s[0][0] + 4} ${s[0][1]}L${s[2][0] + 4} ${s[2][1]}" stroke="${C.camiLine}" stroke-width="1.3" fill="none"/>`).join("")
    + `</g>`;
  const body = `<g data-part="body" data-pivot="388 1182">${torso}${neck}${cami}</g>`;

  // ── 比耶的手 ──
  const hand = `<g data-part="arm-peace" data-pivot="268 912">`
    + P(spline(FOREARM), C.skin)
    + clipped(spline(FOREARM), soft(P(spline([[240, 724], [252, 726], [256, 800], [260, 900], [264, 1080], [240, 1086], [238, 900], [238, 800]]), C.skinShade, ` opacity="0.9"`)
      + P(spline([[214, 820], [222, 818], [220, 920], [218, 1080], [210, 1084], [208, 920]]), "#ffffff", ` opacity="0.35"`)
      + `<ellipse cx="236" cy="736" rx="20" ry="10" fill="${C.skinShade}" opacity="0.7"/>`, 2))
    + R(FOREARM, C.skinLine, { w: 2.2, heavy: 1.5 })
    + `<g transform="translate(236 728) scale(0.9) translate(-236 -728)">`
    + P(spline(HAND), C.skin)
    + clipped(spline(HAND), soft(P(spline([[266, 602], [278, 616], [288, 636], [286, 662], [276, 692], [262, 716], [266, 680], [272, 640]]), C.skinShade) + P(spline([[220, 506], [224, 534], [230, 566], [236, 594], [228, 590], [222, 560], [216, 530]]), C.skinShade, ` opacity="0.8"`) + P(spline([[278, 512], [274, 546], [268, 584], [262, 584], [266, 548], [270, 516]]), C.skinShade, ` opacity="0.8"`), 2))
    + contour(HAND, C.skinLine, { w: 2.6, heavy: 1.5, ends: 0.3, taper: 0.1 })
    + thin([[287, 630], [264, 640], [242, 648], [226, 646]], C.skinLine, 2) + thin([[203, 628], [214, 620], [226, 622]], C.skinLine, 1.6, ` opacity="0.8"`) + thin([[200, 650], [212, 644], [224, 646]], C.skinLine, 1.6, ` opacity="0.7"`)
    + `</g></g>`;

  const handMask = `<mask id="{id}-hand" maskUnits="userSpaceOnUse" x="20" y="140" width="960" height="1080"><rect x="20" y="140" width="960" height="1080" fill="#fff"/><path d="${spline(CAMI)}" fill="#000" stroke="#000" stroke-width="3"/></mask>`;
  const defs = lin("hair", [[0, "#211e2a"], [0.4, "#222640"], [0.72, "#28335f"], [1, "#36468e"]], 250, 1000)
    + lin("hair-shade", [[0, "#13111b"], [0.5, "#171b30"], [1, "#1f2a58"]], 250, 760)
    + lin("hair-long", [[0, "#17151f"], [0.4, "#1d2340"], [1, "#34448a"]], 620, 1180)
    + `<linearGradient id="{id}-iris" x1="0" y1="0" x2="0" y2="1">${stops([[0, "#10122a"], [0.32, "#232c58"], [0.62, "#3e5698"], [0.86, "#6f8fd0"], [1, "#9cbaf0"]])}</linearGradient>`
    + `<radialGradient id="{id}-blush">${stops([[0, "#ff9eab", 0.5], [0.6, "#ff9eab", 0.22], [1, "#ff9eab", 0]])}</radialGradient>`
    + `<linearGradient id="{id}-logo" x1="0" y1="1" x2="0" y2="0">${stops([[0, "#2459C5"], [0.45, "#2E6BDE"], [1, "#3980F8"]])}</linearGradient>`
    + `<filter id="{id}-soft1" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9"/></filter>`
    + `<filter id="{id}-soft2" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="4"/></filter>`
    + DEFS.join("") + handMask;
  return `<defs>${defs}</defs><g data-part="miles">${hairLong}${body}${head}<g mask="url(#{id}-hand)">${hand}</g></g>`;
}

/** 写进 girlArt.ts 文件头的说明（每行一句，gen.cjs 会补上和 rig 的约定）。 */
const DOC = `
女伙伴形象 Mia「原版」的画（2026-11-03 设计稿，待定稿）：照参考图的正常动漫比例，头肩半身像，安静好看。
黑发从发根渐变到发尾的深蓝紫，头发柔顺；刘海侧分，一缕缕长短不一地扫向左边；右边头发别在耳后，露出耳朵和 AirPods。
杏仁眼看得到眼白，淡淡的浅笑；细长的脖子和锁骨，白色吊带配蕾丝边；只留天枢 logo 发夹（头顶偏左）。
线条用 ink.cjs 的笔刷画（细、带颜色、两头收尖），阴影是柔和的晕染（id 为 {id}-soft1、{id}-soft2 的模糊滤镜）。
背后的长发（data-part="hair-long"）在身子后面，不跟着头转；它从耳后和左边垂发的后面起头，侧头时接缝被盖住。
`;
module.exports = { drawGirl, DOC };
