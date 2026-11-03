// 画图的小工具：锚点 → 平滑曲线。

const f = (v) => Math.round(v).toString();

/**
 * 过锚点的 Catmull-Rom 曲线，转成三次贝塞尔。
 * 锚点写 [x, y]（平滑）或 [x, y, "c"]（尖角，发梢用）。closed 默认闭合。
 */
function spline(points, { closed = true } = {}) {
  const P = points.map(([x, y, c]) => ({ x, y, c: c === "c" }));
  const n = P.length;
  const at = (i) => (closed ? P[(i + n) % n] : P[Math.max(0, Math.min(n - 1, i))]);
  let d = `M${f(P[0].x)} ${f(P[0].y)}`;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const c1 = p1.c ? { x: p1.x + (p2.x - p1.x) / 3, y: p1.y + (p2.y - p1.y) / 3 } : { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = p2.c ? { x: p2.x - (p2.x - p1.x) / 3, y: p2.y - (p2.y - p1.y) / 3 } : { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += `C${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(p2.x)} ${f(p2.y)}`;
  }
  return closed ? d + "Z" : d;
}

module.exports = { spline };
