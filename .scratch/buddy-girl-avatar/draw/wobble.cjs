// 给新画的发丝轮廓加一点手描的起伏（和 Miles 从贴纸描下来的线一个质感）：沿法线做低频小幅偏移，尖角处归零；只动描边，填色仍被 12.5 的线盖住。
const f = (v) => (Math.round(v * 10) / 10).toString();
function parse(d) {
  const nums = d.match(/-?\d+(\.\d+)?/g).map(Number);
  const start = [nums[0], nums[1]];
  const segs = [];
  for (let i = 2; i + 5 < nums.length; i += 6) segs.push(nums.slice(i, i + 6));
  return { start, segs };
}
function bez(p0, c1, c2, p1, t) {
  const u = 1 - t;
  return [u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0], u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1]];
}
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function wobble(d, { amp = 1.1, seed = 1, step = 12 } = {}) {
  if (/[^MC\d\s.,-]/.test(d.replace(/Z$/, ""))) return d; // only plain M/C paths
  const closed = /Z$/.test(d);
  const { start, segs } = parse(d);
  // sample points and mark corners at segment joins where the tangent turns sharply
  const pts = [];
  let p0 = start;
  const corners = new Set();
  segs.forEach((s, k) => {
    const c1 = [s[0], s[1]], c2 = [s[2], s[3]], p1 = [s[4], s[5]];
    const n = 12;
    for (let i = k === 0 ? 0 : 1; i <= n; i++) pts.push(bez(p0, c1, c2, p1, i / n));
    if (k < segs.length - 1) {
      const nx = segs[k + 1];
      const tin = [p1[0] - c2[0], p1[1] - c2[1]], tout = [nx[0] - p1[0], nx[1] - p1[1]];
      const a = Math.atan2(tin[0] * tout[1] - tin[1] * tout[0], tin[0] * tout[0] + tin[1] * tout[1]);
      if (Math.abs(a) > 0.6) corners.add(pts.length - 1);
    }
    p0 = p1;
  });
  corners.add(0); if (!closed) corners.add(pts.length - 1);
  // arc length
  const L = [0];
  for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = L[L.length - 1];
  const cornerS = [...corners].map((i) => L[i]);
  const r = rng(seed);
  const ph1 = r() * 6.283, ph2 = r() * 6.283, l1 = 150 + r() * 60, l2 = 64 + r() * 24;
  const out = [];
  let next = 0;
  for (let i = 0; i < pts.length; i++) {
    const isCorner = corners.has(i);
    if (!isCorner && L[i] < next && i !== pts.length - 1) continue;
    next = L[i] + step;
    const a = Math.max(0, i - 1), b = Math.min(pts.length - 1, i + 1);
    const tx = pts[b][0] - pts[a][0], ty = pts[b][1] - pts[a][1];
    const tl = Math.hypot(tx, ty) || 1;
    const nx = -ty / tl, ny = tx / tl;
    const dist = Math.min(...cornerS.map((c) => Math.abs(L[i] - c)), closed ? Infinity : Math.min(L[i], total - L[i]));
    const fade = Math.min(1, dist / 22);
    const o = amp * fade * (0.7 * Math.sin((L[i] / l1) * 6.283 + ph1) + 0.3 * Math.sin((L[i] / l2) * 6.283 + ph2));
    out.push({ x: pts[i][0] + nx * o, y: pts[i][1] + ny * o, c: isCorner });
  }
  // back to cubic Béziers (Catmull-Rom, sharp at corners)
  let res = `M${f(out[0].x)} ${f(out[0].y)}`;
  for (let i = 0; i < out.length - 1; i++) {
    const q0 = out[Math.max(0, i - 1)], q1 = out[i], q2 = out[i + 1], q3 = out[Math.min(out.length - 1, i + 2)];
    const c1 = q1.c ? { x: q1.x + (q2.x - q1.x) / 3, y: q1.y + (q2.y - q1.y) / 3 } : { x: q1.x + (q2.x - q0.x) / 6, y: q1.y + (q2.y - q0.y) / 6 };
    const c2 = q2.c ? { x: q2.x - (q2.x - q1.x) / 3, y: q2.y - (q2.y - q1.y) / 3 } : { x: q2.x - (q3.x - q1.x) / 6, y: q2.y - (q3.y - q1.y) / 6 };
    res += `C${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(q2.x)} ${f(q2.y)}`;
  }
  return closed ? res + "Z" : res;
}
module.exports = { wobble };
