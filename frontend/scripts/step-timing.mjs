/**
 * 一轮深研的时间去哪了。**读的是已经跑完的那一轮，不重跑、不花钱。**
 *
 *     node scripts/step-timing.mjs              # 最近一轮 A4
 *     node scripts/step-timing.mjs RUN-A4-xxx   # 指定某一轮
 *     node scripts/step-timing.mjs --list       # 库里有哪几轮
 *     node scripts/step-timing.mjs --agent A5   # 换一条链
 *
 * ## 为什么不加新的埋点
 *
 * `AgentRunRecord.trace` 上每个 model 节点都带着 `at`（开始那一刻）和 `ms`（这一次花了
 * 多久），七步之间的边界又各有一个 local 标记（`主体卡`、`先验草稿`、`检索计划` …，
 * 出处在 `a4/pipeline.ts` 的 `STEPS`）。两样凑起来就是一条完整的时间轴 —— 再加一套
 * 计时器只会多一个会和它对不上的数。
 *
 * ## 三个数不是一回事，别只看一个
 *
 * · **墙上** —— 这一步真的占了多少钟。压时间只有这一列算数。
 * · **模型占用** —— 这一步里「至少有一次调用在飞」的时间，**并行的重叠只算一次**。
 *   直接把每次的 `ms` 加起来会得出比墙上时间还大的数（成稿那一段五节是并发的）。
 * · **其他** —— 墙上减模型占用：检索、抓取、装配、还有等在那儿没事干的时间。
 *   这一列大，说明省时间要去动链路而不是动模型。
 *
 * 失败的调用**照样计时**，而且单列一栏 —— 一次网关超时能吃掉整整六分钟，那六分钟是白
 * 花的，把它混进正常调用里就看不出来了。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = process.env.TKOS_DATA_DIR || join(process.cwd(), ".data");
const snap = JSON.parse(readFileSync(join(DIR, "store.json"), "utf8"));
const runs = snap.state?.agentRuns ?? snap.agentRuns ?? [];

const args = process.argv.slice(2);
const agent = args.includes("--agent") ? args[args.indexOf("--agent") + 1] : "A4";
const wantId = args.find((a) => a.startsWith("RUN-"));

/**
 * 七步的边界。每一条是「这一步**结束**时那个 local 标记」，原话照抄
 * `a4/pipeline.ts`；同一处可能有两种说法（取证跳过时不写覆盖表），所以给的是一组候选。
 */
const BOUNDS = [
  { step: "N0 锚定主体", end: ["主体卡"] },
  { step: "N1 先验草稿", end: ["先验草稿"] },
  { step: "N2 检索计划", end: ["检索计划"] },
  { step: "N3 分维度取证", end: ["覆盖表", "分维度取证 · 跳过"] },
  { step: "N4 证据对账", end: ["证据与草稿对账"] },
  { step: "N5 分层成稿", end: ["分层成稿"] },
  { step: "N6 出口对账", end: [] /* 到收尾为止 */ },
];

const ms = (iso) => Date.parse(iso);
const s = (n) => (n / 1000).toFixed(0) + "s";
const pad = (v, n) => String(v).padEnd(n, " ");
const padL = (v, n) => String(v).padStart(n, " ");

/** 一组区间的并集长度 —— 并行的重叠只算一次。 */
const union = (spans) => {
  const xs = [...spans].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur = null;
  for (const [a, b] of xs) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    } else cur[1] = Math.max(cur[1], b);
  }
  if (cur) total += cur[1] - cur[0];
  return total;
};

const pick = () => {
  const list = runs.filter((r) => r.agent === agent && (r.trace ?? []).length > 0);
  if (wantId) return list.find((r) => r.id === wantId) ?? null;
  return list[list.length - 1] ?? null;
};

if (args.includes("--list")) {
  for (const r of runs.filter((x) => x.agent === agent)) {
    console.log(
      pad(r.id, 22) + pad(r.status, 12) + padL(s(r.latencyMs ?? 0), 7) +
        padL((r.trace ?? []).length + " 节点", 10) + "  " + r.createdAt,
    );
  }
  process.exit(0);
}

const run = pick();
if (!run) {
  console.error(`库里没有${wantId ? ` ${wantId}` : `带 trace 的 ${agent} 运行`}。--list 看看有哪些。`);
  process.exit(1);
}

const t0 = ms(run.createdAt);
const tEnd = ms(run.finishedAt ?? run.createdAt) || t0 + (run.latencyMs ?? 0);

/** 把每个结束标记落到时间轴上，切出七段。找不到的那一步并进前一步，并且说出来。 */
const segs = [];
let cursor = t0;
const missing = [];
for (let i = 0; i < BOUNDS.length; i += 1) {
  const b = BOUNDS[i];
  let end = tEnd;
  if (b.end.length) {
    const node = (run.trace ?? []).find(
      (n) => n.kind === "local" && b.end.includes(n.label) && ms(n.at) >= cursor,
    );
    if (!node) {
      missing.push(b.step);
      continue; // 这一步没留下标记：它的时间归进下一段，不凭空造一个边界
    }
    end = ms(node.at);
  }
  segs.push({ step: b.step, from: cursor, to: Math.max(cursor, end) });
  cursor = end;
}

const calls = (run.trace ?? [])
  .filter((n) => n.kind === "model")
  .map((n) => ({
    key: (n.label.match(/模型调用 · (.+)$/)?.[1] ?? n.label).trim(),
    from: ms(n.at),
    to: ms(n.at) + (n.ms ?? 0),
    ms: n.ms ?? 0,
    ok: !n.error,
    error: n.error ? String(n.error).split("\n")[0].slice(0, 46) : "",
  }));

console.log(
  `${run.id}  ${run.status}  ${s(run.latencyMs ?? tEnd - t0)}  ${run.createdAt}` +
    (run.degraded ? "  [降级]" : ""),
);
console.log(
  pad("环节", 16) + padL("墙上", 7) + padL("占比", 7) + padL("调用", 6) +
    padL("模型占用", 10) + padL("其他", 7) + padL("失败", 6) + padL("白花", 7),
);

const total = tEnd - t0 || 1;
let wasted = 0;
for (const g of segs) {
  /*
   * 按**开始那一刻**归段，两头都不放宽。放宽 0.5 秒试过一次：结束标记是那次调用返回后
   * 才写的，两者只差几毫秒，于是草稿那 299 秒被算进了它上一段 —— 一段的墙上时间只有
   * 41 秒，模型占用却有 332 秒，「其他」成了负数。负数正是这个错唯一的症状。
   */
  const inSeg = ([a, b]) => [Math.max(a, g.from), Math.min(b, g.to)];
  const mine = calls.filter((c) => c.from >= g.from && (c.from < g.to || g.to === tEnd));
  const used = union(mine.map((c) => inSeg([c.from, c.to])));
  const wall = g.to - g.from;
  const bad = mine.filter((c) => !c.ok);
  const badMs = union(bad.map((c) => inSeg([c.from, c.to])));
  wasted += badMs;
  console.log(
    pad(g.step, 16) + padL(s(wall), 7) + padL(((wall / total) * 100).toFixed(0) + "%", 7) +
      padL(mine.length, 6) + padL(s(used), 10) + padL(s(wall - used), 7) +
      padL(bad.length || "", 6) + padL(badMs ? s(badMs) : "", 7),
  );
}
console.log(
  pad("合计", 16) + padL(s(total), 7) + padL("100%", 7) + padL(calls.length, 6) +
    padL(s(union(calls.map((c) => [c.from, c.to]))), 10) +
    padL(s(total - union(calls.map((c) => [c.from, c.to]))), 7) +
    padL(calls.filter((c) => !c.ok).length || "", 6) + padL(wasted ? s(wasted) : "", 7),
);
if (missing.length) {
  console.log(`\n⚠ 这几步没留下结束标记，时间并进了下一段：${missing.join("、")}`);
}

console.log("\n最贵的那几次调用：");
for (const c of [...calls].sort((a, b) => b.ms - a.ms).slice(0, 12)) {
  console.log(
    "  " + padL(s(c.ms), 7) + "  " + pad(c.key, 40) + (c.ok ? "" : "✗ " + c.error),
  );
}

/** 同一个 promptKey 跑了几次、一共占多久 —— 并发的那一批在这里会露出真实的量。 */
const byKey = new Map();
for (const c of calls) {
  const k = c.key.replace(/（.*$/, "");
  const b = byKey.get(k) ?? { n: 0, sum: 0, spans: [], fail: 0 };
  b.n += 1;
  b.sum += c.ms;
  b.spans.push([c.from, c.to]);
  if (!c.ok) b.fail += 1;
  byKey.set(k, b);
}
console.log("\n按调用名归堆（墙上＝这一堆并起来占的时间，并行只算一次）：");
console.log("  " + pad("调用", 24) + padL("次", 4) + padL("累计", 8) + padL("墙上", 8) + padL("失败", 6));
for (const [k, b] of [...byKey].sort((a, b) => union(b[1].spans) - union(a[1].spans))) {
  console.log(
    "  " + pad(k, 24) + padL(b.n, 4) + padL(s(b.sum), 8) + padL(s(union(b.spans)), 8) +
      padL(b.fail || "", 6),
  );
}
