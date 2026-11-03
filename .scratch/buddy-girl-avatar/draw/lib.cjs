// 画头发用的小工具：锚点 → 平滑曲线；从 Miles 的画里按 data-part 取部件。
const fs = require("fs");
const path = require("path");

const f = (v) => (Math.round(v * 10) / 10).toString();

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

/** 一条闭合轮廓拆成段，前发和后发共用同一段曲线时线条才严丝合缝。 */
function splineSegs(points) {
  return { pts: points, segs: spline(points).replace(/Z$/, "").split("C").slice(1).map((s) => "C" + s) };
}
/** 轮廓上第 i0 到 i1 个锚点之间那一截。 */
function subPath({ pts, segs }, i0, i1) {
  let d = `M${f(pts[i0][0])} ${f(pts[i0][1])}`;
  for (let i = i0; i !== i1; i = (i + 1) % segs.length) d += segs[i];
  return d;
}
/** 接着当前终点再走一段平滑曲线（第一个锚点就是当前终点）。 */
function cont(points) {
  return spline(points, { closed: false }).replace(/^M[^C]*/, "");
}

/** Miles 10/31 定稿的画（miles-base.svg，一行一个元素），按 data-part 取出整个部件。 */
const MILES = fs.readFileSync(path.join(__dirname, "miles-base.svg"), "utf8").split("\n");
function milesPart(name) {
  const start = MILES.findIndex((l) => l.includes(`data-part="${name}"`));
  if (start < 0) throw new Error(`Miles 的画里没有 ${name}`);
  if (!/^\s*<g\b/.test(MILES[start])) return MILES[start].trim();
  const out = [];
  for (let i = start, depth = 0; i < MILES.length; i++) {
    if (/^\s*<g\b/.test(MILES[i])) depth++;
    if (/^\s*<\/g>/.test(MILES[i])) depth--;
    out.push(MILES[i].trim());
    if (depth === 0) break;
  }
  return out.join("");
}
/** Miles 的三个渐变（下颌线、两颊腮红），她原样沿用。 */
function milesDefs() {
  const a = MILES.findIndex((l) => l.trim() === "<defs>"), b = MILES.findIndex((l) => l.trim() === "</defs>");
  return MILES.slice(a + 1, b).map((l) => l.trim()).join("");
}

module.exports = { spline, splineSegs, subPath, cont, milesPart, milesDefs };
