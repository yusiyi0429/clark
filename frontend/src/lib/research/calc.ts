/**
 * 确定性复算。**报告里的衍生数字由代码算一遍，不由模型心算。**
 *
 * spec 那一档要一个 Python 沙箱。MVP 不上沙箱 —— 上一个隔离 runner、加一套模型产出
 * 模型定义 JSON 的协议，是几人日的活，而真正拦住黄金错误的其实只有三条确定性规则。
 * 这里就写这三条 TypeScript，满足「全部经 deterministic code」这句话本身的要求。
 * 沙箱那一档留给场景与敏感性矩阵，那时候它才是必需的。
 *
 * ## 三条规则，各对着一个真实发生过的错
 *
 *  · **占比加总超界** —— 「折旧 40–50% + 电费 30–50% + 运维 10–20%」，上界 120%。
 *    区间加总必须按上界算：按中值算就正好落在 100% 以内，而那恰恰是这类错能活下来的原因。
 *  · **增速对不上** —— 「1037.3 增长至 2185，同比 +177%」。实际 +111%。
 *  · **数量级矛盾** —— 同口径同期两个数差两个数量级，二者不可同真。
 *
 * 前两条读的是报告正文（模型自己写出来的算术），第三条读的是台账（两条各自都定位得到
 * 的原文，但放在一起不成立）。
 */

import type { Evidence } from "./ledger";

/** 一次复算的留痕。上屏和进运行记录都用它。 */
export type Calculation = {
  id: string;
  kind: "share_sum" | "growth_rate" | "magnitude";
  /** 人话说明算了什么、拿什么算的。 */
  note: string;
  /** 算术站不住就是 false —— 这是要拦下来的那一类。 */
  ok: boolean;
};

/** 中文数量级词。「万亿」必须排在「亿」和「万」前面，否则会先匹配到「万」。 */
const SCALE: [string, number][] = [
  ["万亿", 1e12],
  ["亿", 1e8],
  ["万", 1e4],
  ["千", 1e3],
];

/** 「8.82亿」→ 8.82e8；「1037.3」→ 1037.3。认不出返回 `null`。 */
export function numeric(raw: string): number | null {
  const m = /(-?\d+(?:\.\d+)?)\s*(万亿|亿|万|千)?/.exec(raw.replace(/,/g, ""));
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  const scale = m[2] ? (SCALE.find(([w]) => w === m[2])?.[1] ?? 1) : 1;
  return v * scale;
}

/* -------------------------------------------------------------------------- */
/* 一：占比加总                                                                */
/* -------------------------------------------------------------------------- */

/** 只在成本结构那类句子上算。全文所有百分数乱加会满屏假警报 —— 那种闸没人会留着。 */
const SHARE_CUE = /(占比|构成|结构|合计|前两项|分别占|占总)/;
/** 「40–50%」「30-50%」「约 12%」都要认。区间的两头都收下，加总取上界。 */
const PERCENT = /(\d+(?:\.\d+)?)\s*(?:[–—~-]\s*(\d+(?:\.\d+)?))?\s*%/g;

/** 加总上界能超过多少才算错。留一点余量给「约」和四舍五入。 */
const SUM_TOLERANCE = 102;
/**
 * 同一句里出现两个以上**不同时点**，那几个百分数是同一指标的时间序列，不是一个整体的几块。
 * ISS-229 的假警报：「全年合计份额 49.2%，半年口径 50.7%、Q1 口径 53.4%」被按 153% 打回 p0。
 * 认时点的词：年份、季度、上/下半年、Q1–Q4、H1/H2、月。
 */
const PERIOD = /(20\d{2}\s*年|(?:一|二|三|四|[1-4])\s*季度|Q[1-4]|H[12]|上半年|下半年|全年|半年|\d{1,2}\s*月)/g;
const distinctPeriods = (p: string): number => new Set([...p.matchAll(PERIOD)].map((m) => m[1].replace(/\s/g, ""))).size;
/**
 * 标着没核的句子不算。ISS-230 的假警报出在未核面板里：「手机收入约 60%、穿戴约 20%、前三大客户占比
 * 超过 80%」—— 这句本来就是报告自己标成待核的先验，拿它打 p0 是拿没核的数当错数。
 */
const UNVERIFIED = /(未核|待核|未经核实|未能核实|P!)/;
/**
 * 「超过 80%」「不足 5%」「以上」这一类是阈值，不是结构里的一块：同一句里「收入占 60%、穿戴占 20%、
 * 前三大客户超过 80%」，前两个是收入构成，第三个是客户集中度，分母不同。阈值词后面的那个数不进加总。
 * 「达」不在这张表上：「占比达 60%」是陈述一块占多少的常规写法，拦它等于把这条闸关掉一半。
 *
 * 未核那条是整句跳过：一句里只要有一项标着待核，其余几项的分母也多半没核，宁可少报一条。
 */
const THRESHOLD_BEFORE = /(超过|不足|不低于|不高于|低于|高于|逾)\s*$/;
const THRESHOLD_AFTER = /^\s*(以上|以下|以内)/;

function shareSum(text: string): Calculation[] {
  const out: Calculation[] = [];
  const paras = text.split(/\n{2,}|(?<=。)/).filter((p) => SHARE_CUE.test(p));
  paras.forEach((p, i) => {
    // 同一指标的几个时点放一句里，不是占比结构，不加。
    if (distinctPeriods(p) >= 2) return;
    if (UNVERIFIED.test(p)) return;
    /*
     * 括号里的百分数不进加总（2026-09-06）。ISS-232：「54.8%（该季柔性占比 76.4%）」—— 括号里是另一个
     * 分母的旁注，和主句不是同一个整体的两块。按 131% 打回等于拿一条口径脚注当算术错。
     */
    const main = p.replace(/（[^）]*）|\([^)]*\)/g, "");
    const uppers: number[] = [];
    for (const m of main.matchAll(PERCENT)) {
      const before = main.slice(Math.max(0, (m.index ?? 0) - 4), m.index);
      const after = main.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 3);
      if (THRESHOLD_BEFORE.test(before) || THRESHOLD_AFTER.test(after)) continue;
      uppers.push(Number(m[2] ?? m[1]));
    }
    if (uppers.length < 2) return;
    const sum = uppers.reduce((a, b) => a + b, 0);
    if (sum <= SUM_TOLERANCE) return;
    out.push({
      id: `C-share-${i + 1}`,
      kind: "share_sum",
      note: `占比按上界加总为 ${sum.toFixed(1)}%，超过 100%：${uppers.join("% + ")}%。原句「${p.trim().slice(0, 60)}」`,
      ok: false,
    });
  });
  return out;
}

/* -------------------------------------------------------------------------- */
/* 二：增速                                                                    */
/* -------------------------------------------------------------------------- */

/** 「从 A 增长至 B……同比 +N%」。三个数落在同一句里才算 —— 跨句配对必然配错。 */
const GROWTH =
  /(?<![A-Za-z\d])从?\s*([\d.,]+\s*(?:万亿|亿|万|千)?)\s*[^。；\n]{0,12}?(?:增长|增至|升至|上升)[到至]?\s*([\d.,]+\s*(?:万亿|亿|万|千)?)(?![\d.]*\s*%)[^。；\n]{0,24}?(?:同比|增长|增幅)[^\d%]{0,6}([\d.]+)\s*%/g;
/*
 * 两处否定断言都是为假警报加的（2026-09-06/07）：
 * - 起点前面不能是字母或数字：ISS-238 把「[E2]，……同比增长 44.3%」里证据编号的 2 当成了起点。
 * - 终点后面不能接着数字再接 %：`(?!\s*%)` 拦不住回溯 —— 「44.3%」会退成「44.」再看见「3%」而放行。
 */

const UNIT = /(万亿|亿|万|千)\s*$/;

/** 差多少个百分点才算错。模型口径不同、四舍五入都会差一两点。 */
const GROWTH_TOLERANCE = 5;

function growthRate(text: string): Calculation[] {
  const out: Calculation[] = [];
  let i = 0;
  for (const m of text.matchAll(GROWTH)) {
    const from = numeric(m[1]);
    const to = numeric(m[2]);
    const claimed = Number(m[3]);
    if (from === null || to === null || !from || !Number.isFinite(claimed)) continue;
    /*
     * 起点带单位、终点不带 —— 那不是「从 A 到 B」，是「A 亿元、同比增长 B%」这类句子里被错配的一个
     * 百分数（ISS-235：「79.29 亿元、同比增长 33.8%，其中……同比增长 46.01%」被读成 79.29 亿 → 33.8，
     * 复算 -100%，p0，整份返修一分五十秒）。
     */
    if (UNIT.test(m[1].trim()) !== UNIT.test(m[2].trim())) continue;
    const actual = ((to - from) / Math.abs(from)) * 100;
    i += 1;
    if (Math.abs(actual - claimed) <= GROWTH_TOLERANCE) continue;
    out.push({
      id: `C-growth-${i}`,
      kind: "growth_rate",
      note: `文中写增幅 ${claimed}%，按文中自己给的 ${m[1].trim()} → ${m[2].trim()} 复算是 ${actual.toFixed(1)}%。两者对不上，或者这两个数不同口径、本来不可比`,
      ok: false,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 三：数量级                                                                  */
/* -------------------------------------------------------------------------- */

/** 差几倍才算数量级矛盾。100 倍是「两个数量级」，留够口径差异的空间。 */
const MAGNITUDE_RATIO = 100;

/**
 * 同一条命题下、同单位同地域同期的两个数差到两个数量级 —— 不可同真。
 *
 * 只比 `statistic` 类且口径填齐的条目：口径没填的比出来的「矛盾」全是假的，而假警报
 * 会让整道闸被关掉。
 */
function magnitude(entries: Evidence[]): Calculation[] {
  const out: Calculation[] = [];
  const comparable = entries.filter(
    (e) => e.evidenceType === "statistic" && typeof e.value === "number" && e.value !== 0 && e.unit
  );
  let i = 0;
  for (let a = 0; a < comparable.length; a += 1) {
    for (let b = a + 1; b < comparable.length; b += 1) {
      const x = comparable[a];
      const y = comparable[b];
      if (x.propositionId !== y.propositionId) continue;
      if (x.unit !== y.unit) continue;
      if ((x.geography ?? "") !== (y.geography ?? "")) continue;
      if ((x.period ?? "") !== (y.period ?? "")) continue;
      const ratio = Math.abs(x.value! / y.value!);
      if (ratio < MAGNITUDE_RATIO && ratio > 1 / MAGNITUDE_RATIO) continue;
      i += 1;
      out.push({
        id: `C-scale-${i}`,
        kind: "magnitude",
        note: `${x.id} 与 ${y.id} 同口径同期（${x.unit}，${x.period ?? "未标期"}），数值 ${x.value} 与 ${y.value} 差约 ${Math.round(ratio > 1 ? ratio : 1 / ratio)} 倍，二者不可同真`,
        ok: false,
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */

/**
 * 全跑一遍。返回的每一条都是**站不住的**算术 —— 空数组等于三条规则都没话说。
 *
 * 注意这里只报错不报对：算对了的没有留痕。真要「每个衍生数字反查 calc_id」得等
 * 沙箱那一档，模型先输出模型定义、代码填值、正文绑 id。现在做不到，就不假装做到。
 */
export function recompute(report: string, entries: Evidence[]): Calculation[] {
  return [...shareSum(report), ...growthRate(report), ...magnitude(entries)];
}
