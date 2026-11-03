// 线稿笔刷：沿锚点曲线（和 lib.spline 同一条 Catmull-Rom）按长度位置给宽度，两侧偏移后连成一个填色形状。
// 这样线条能有粗细变化、两头收尖，而不是 SVG 描边那种一样粗的线。
const { spline } = require("./lib.cjs");

/** 把锚点曲线采成密集的点（和 spline() 用同样的控制点，所以线和填色严丝合缝）。 */
function sample(points, { closed = false, per = 24 } = {}) {
  const P = points.map(([x, y, c]) => ({ x, y, c: c === "c" }));
  const n = P.length;
  const at = (i) => (closed ? P[(i + n) % n] : P[Math.max(0, Math.min(n - 1, i))]);
  const out = [];
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const c1 = p1.c ? { x: p1.x + (p2.x - p1.x) / 3, y: p1.y + (p2.y - p1.y) / 3 } : { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = p2.c ? { x: p2.x - (p2.x - p1.x) / 3, y: p2.y - (p2.y - p1.y) / 3 } : { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    for (let k = 0; k < per; k++) {
      const t = k / per, u = 1 - t;
      out.push([u * u * u * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p2.x, u * u * u * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p2.y]);
    }
  }
  if (!closed) out.push([P[n - 1].x, P[n - 1].y]);
  return out;
}

/** 按弧长等距重采样，返回点和每个点的长度位置 s（0–1）。 */
function resample(pts, step, closed) {
  const ring = closed ? [...pts, pts[0]] : pts;
  const L = [0];
  for (let i = 1; i < ring.length; i++) L.push(L[i - 1] + Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]));
  const total = L[L.length - 1];
  const count = Math.max(closed ? 12 : 4, Math.round(total / step));
  const out = [];
  for (let k = 0, j = 0; k <= (closed ? count - 1 : count); k++) {
    const s = (k / count) * total;
    while (j < L.length - 2 && L[j + 1] < s) j++;
    const t = (s - L[j]) / (L[j + 1] - L[j] || 1);
    out.push({ x: ring[j][0] + (ring[j + 1][0] - ring[j][0]) * t, y: ring[j][1] + (ring[j + 1][1] - ring[j][1]) * t, s: s / total });
  }
  return { out, total };
}

function normals(q, closed) {
  return q.map((p, i) => {
    const a = q[closed ? (i - 1 + q.length) % q.length : Math.max(0, i - 1)], b = q[closed ? (i + 1) % q.length : Math.min(q.length - 1, i + 1)];
    const tx = b.x - a.x, ty = b.y - a.y, len = Math.hypot(tx, ty) || 1;
    return { nx: -ty / len, ny: tx / len, tx: tx / len, ty: ty / len };
  });
}

const r1 = (v) => Math.round(v);

/**
 * 一笔线：w 最粗处的宽度；taper [起笔, 收笔] 是两头各用多长（占全长比例）从细变粗；
 * ends [起笔, 收笔] 是两头剩下的宽度比例（0 = 尖）；profile(s) 可以再乘一个随位置变化的系数。
 */
function brush(points, { w = 6, taper = [0.3, 0.3], ends = [0.1, 0.1], profile = () => 1, step = 18, heavy = 1, side = 0, light = [0.45, 0.89] } = {}) {
  const { out: q } = resample(sample(points), step, false);
  const N = normals(q, false);
  const ease = (x) => Math.sin((Math.min(1, Math.max(0, x)) * Math.PI) / 2);
  // side：这一笔是闭合轮廓的一段时，1 = 轮廓顺时针（外法线在右手边），-1 = 逆时针；背光那一侧按 heavy 加粗
  const shadeAt = (i) => (side ? Math.max(0, -side * (N[i].nx * light[0] + N[i].ny * light[1])) : 0);
  const width = (s, i) => {
    const a = taper[0] > 0 ? ends[0] + (1 - ends[0]) * ease(s / taper[0]) : 1;
    const b = taper[1] > 0 ? ends[1] + (1 - ends[1]) * ease((1 - s) / taper[1]) : 1;
    return w * Math.min(a, b) * profile(s) * (1 + (heavy - 1) * shadeAt(i));
  };
  const L = [], R = [];
  q.forEach((p, i) => {
    const h = width(p.s, i) / 2;
    L.push([r1(p.x + N[i].nx * h), r1(p.y + N[i].ny * h)]);
    R.push([r1(p.x - N[i].nx * h), r1(p.y - N[i].ny * h)]);
  });
  // 两头：宽度为 0 时收成一个尖，否则补一个圆头的中点
  const cap = (i, dir) => {
    const p = q[i], h = width(p.s, i) / 2;
    return [r1(p.x + N[i].tx * dir * h * 0.9), r1(p.y + N[i].ty * dir * h * 0.9), "c"];
  };
  const last = q.length - 1;
  const outline = [...L, cap(last, 1), ...R.reverse(), cap(0, -1)];
  // 左右两侧的最后一点也设成尖角，免得曲线在头上绕圈
  outline[L.length - 1] = [...outline[L.length - 1].slice(0, 2), "c"];
  outline[L.length + 1] = [...outline[L.length + 1].slice(0, 2), "c"];
  outline[outline.length - 2] = [...outline[outline.length - 2].slice(0, 2), "c"];
  outline[0] = [...outline[0].slice(0, 2), "c"];
  return spline(outline);
}

/** 闭合轮廓的线：宽度随法线方向变（光从左上来，右下那一侧粗），内外两圈，配 fill-rule="evenodd"。 */
function ring(points, { w = 6, heavy = 1.8, light = [-0.45, -0.89], step = 16 } = {}) {
  const { out: q } = resample(sample(points, { closed: true }), step, true);
  const N = normals(q, true);
  const cx = q.reduce((a, p) => a + p.x, 0) / q.length, cy = q.reduce((a, p) => a + p.y, 0) / q.length;
  const O = [], I = [];
  q.forEach((p, i) => {
    let { nx, ny } = N[i];
    if (nx * (p.x - cx) + ny * (p.y - cy) < 0) { nx = -nx; ny = -ny; }
    const shade = Math.max(0, -(nx * light[0] + ny * light[1]));
    const h = (w * (1 + (heavy - 1) * shade)) / 2;
    O.push([r1(p.x + nx * h), r1(p.y + ny * h)]);
    I.push([r1(p.x - nx * h), r1(p.y - ny * h)]);
  });
  return spline(O) + spline(I);
}

module.exports = { sample, brush, ring };
