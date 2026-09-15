/**
 * 把 `TKOS_COST_TAP` 记下来的那一堆调用汇成一张账。
 *
 *     TKOS_COST_TAP=/tmp/cost.jsonl TKOS_COST_STAGE=A4-深研 pnpm dev   # 先跑，再算
 *     node scripts/cost-report.mjs /tmp/cost.jsonl
 *
 * ## 价目表是这个文件里唯一不是量出来的东西
 *
 * token 数、调用次数、检索次数都是真跑出来的（见 `src/lib/models/cost-tap.ts`）；
 * 单价只能从外面给。所以它们全都摆在下面 `PRICE` 一处，改一个数整张表跟着重算 ——
 * 散在计算里的话，换一次模型就得在四个地方各改一遍，而漏掉一处不会报错，只会让某一段
 * 的账悄悄偏低。
 *
 * **换了模型或者调了接入点，先回来核这张表。** 方舟那两条走的是推理接入点 id
 * （`ep-m-…`），从 id 上看不出接的是哪个模型、什么档 —— 这是最容易过期而没有症状的一处。
 */
import { readFileSync } from "node:fs";

/**
 * 单价。**每百万 token。** 币种各随各家，最后按 `FX` 折一次。
 *
 * 核对日期 2026-08-31：
 * · Bedrock us-east-2 —— `us.` 前缀是 geo CRIS，比 global 贵约一成，别照 global 那栏抄。
 * · 火山方舟 —— **按量付费直调 API 的价**，不是 Coding / Agent Plan 的订阅价。
 *   V4-Pro 的缓存命中价没有公开数，按 Flash 那一档的同比例（1/50）估的，标在下面。
 */
const PRICE = {
  "claude-opus-5": { cur: "USD", in: 5.0, cached: 0.5, out: 25.0 },
  "gpt-5.6": { cur: "USD", in: 4.4, cached: 0.44, out: 22.0 },
  "deepseek-pro": { cur: "CNY", in: 12.0, cached: 0.24 /* 估：按 Flash 同比例 */, out: 24.0 },
  "deepseek-flash": { cur: "CNY", in: 1.0, cached: 0.02, out: 2.0 },
};

/**
 * 检索按次收钱，单价看账号档位，公开页上查不到 —— 填 0 就是「这一项先不算」，
 * 那时下面会把次数单独列出来，不会把它悄悄算成免费。
 */
const SEARCH_PRICE = { bocha: 0, doubao: 0, tavily: 0 };

/** 折算汇率。只影响最后那一行合计，各家的小计仍旧按原币种给。 */
const FX = { CNY_PER_USD: 7.1 };

const path = process.argv[2];
if (!path) {
  console.error("用法：node scripts/cost-report.mjs <tap 文件>");
  process.exit(1);
}
const rows = readFileSync(path, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const money = (alias, r) => {
  const p = PRICE[alias];
  if (!p || !r.ok) return null;
  const cached = r.cachedInputTokens ?? 0;
  const fresh = Math.max(0, (r.inputTokens ?? 0) - cached);
  const v = (fresh * p.in + cached * p.cached + (r.outputTokens ?? 0) * p.out) / 1e6;
  return { cur: p.cur, v };
};

const per = new Map();
const unknown = new Set();
for (const r of rows) {
  const stage = r.stage || "(没打标签)";
  const b = per.get(stage) ?? {
    calls: 0,
    fail: 0,
    search: 0,
    in: 0,
    out: 0,
    ms: 0,
    USD: 0,
    CNY: 0,
  };
  if (r.kind === "search") {
    b.search += 1;
    b.CNY += SEARCH_PRICE[r.provider] ?? 0;
  } else {
    b.calls += 1;
    if (!r.ok) b.fail += 1;
    b.in += r.inputTokens ?? 0;
    b.out += r.outputTokens ?? 0;
    b.ms += r.ms ?? 0;
    const m = money(r.alias, r);
    if (m) b[m.cur] += m.v;
    else if (r.ok && r.alias) unknown.add(r.alias);
  }
  per.set(stage, b);
}

const pad = (s, n) => String(s).padEnd(n, " ");
console.log(
  pad("环节", 18) + pad("调用", 6) + pad("失败", 6) + pad("检索", 6) +
    pad("输入tok", 11) + pad("输出tok", 10) + pad("耗时s", 8) + pad("USD", 10) + "CNY",
);
const tot = { calls: 0, fail: 0, search: 0, in: 0, out: 0, ms: 0, USD: 0, CNY: 0 };
for (const [stage, b] of per) {
  console.log(
    pad(stage, 18) + pad(b.calls, 6) + pad(b.fail, 6) + pad(b.search, 6) +
      pad(b.in.toLocaleString(), 11) + pad(b.out.toLocaleString(), 10) +
      pad((b.ms / 1000).toFixed(0), 8) + pad(b.USD.toFixed(4), 10) + b.CNY.toFixed(4),
  );
  for (const k of Object.keys(tot)) tot[k] += b[k];
}
console.log(
  pad("合计", 18) + pad(tot.calls, 6) + pad(tot.fail, 6) + pad(tot.search, 6) +
    pad(tot.in.toLocaleString(), 11) + pad(tot.out.toLocaleString(), 10) +
    pad((tot.ms / 1000).toFixed(0), 8) + pad(tot.USD.toFixed(4), 10) + tot.CNY.toFixed(4),
);
console.log(
  `\n折算总计：¥${(tot.USD * FX.CNY_PER_USD + tot.CNY).toFixed(2)}` +
    `（按 ¥${FX.CNY_PER_USD}/$）`,
);
if (Object.values(SEARCH_PRICE).every((v) => v === 0) && tot.search > 0) {
  console.log(`  ⚠ 检索 ${tot.search} 次没算钱 —— SEARCH_PRICE 全是 0，按你账号的档位填上。`);
}
if (unknown.size) {
  console.log(`  ⚠ 价目表里没有这几个模型，它们的账没算进去：${[...unknown].join("、")}`);
}
