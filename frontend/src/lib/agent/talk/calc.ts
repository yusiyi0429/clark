/**
 * 对谈里的**程序复算**：报告里的 `param_model` 由代码算，模型只解释（2026-09-05）。
 *
 * ## 为什么
 *
 * ISS-223 的对话里，一号位问「把决策等待从 2 天压到 0.25 天，看爬坡期能买回多少空转，什么意思」。
 * 参数模型的四个默认值（2 天 / 0.25 天 / 10 件 / 5%）就在它的上下文里（`buildReportBody` 渲染了
 * 「参数：…」那一行），模型仍然把后两个说成了 20 件和 0.5%，结果差 5 倍，再往上编了一层
 * 「单日固定成本数千万、千万级/月」。提示词说「引用报告里的数字不与报告矛盾」拦不住这个：数字一旦
 * 由模型誊写，就会被它"合理化"。所以数值段必须来自确定性结果。
 *
 * ## 做什么
 *
 * - `catalog(doc)`：这份报告里有哪几套算式，各自的引用、标题、层、参数与输出。轮首给模型一份，
 *   它要数值时调 `report_calculate`。
 * - `calculate(doc, ask)`：按引用取那一套，用 `a4/blocks/expr.ts` 的受限求值器（只有参数 id、数字、
 *   四则和括号，不执行任何代码）算每个输出。覆盖值只收模型明确传入且指回用户要求的那几个，
 *   校验 id、范围、有限性；除零 / 缺参数 / 非法表达式逐条报错，不猜值。
 *
 * ## 引用怎么定
 *
 * `ref = <doc.at>#<blockIndex>`。`doc.at` 是这份报告落库的时刻，报告重跑后它变了 —— 旧引用会被
 * 拒绝（「这份算式属于旧版报告」），不拿同一个下标去指新模型。一份报告里只有一套算式时可以不传
 * `ref`；多套时必须传，不默认拿第一套。
 */
import type { ResearchDoc } from "@/lib/data/types";
import { compileExpr } from "@/lib/agent/a4/blocks/expr";
import type { Block } from "@/lib/agent/a4/blocks/schema";

type ParamModel = Extract<Block, { type: "param_model" }>;

export type CalcModel = {
  ref: string;
  index: number;
  heading: string;
  layer: string;
  params: ParamModel["params"];
  outputs: ParamModel["outputs"];
  disclaimer: string;
};

export type CalcAsk = {
  /** `<doc.at>#<index>`。只有一套算式时可省。 */
  ref?: string;
  /** 用户明确要求改的参数。键是参数 id，值是数。没有就是全按默认。 */
  overrides?: Record<string, unknown>;
  /** 用户为什么改（原话）。写进结果，让屏幕上看得出这几个值是谁给的。 */
  overrideSource?: string;
};

export type CalcOutcome =
  | {
      ok: true;
      model: CalcModel;
      params: { id: string; label: string; unit: string; value: number; origin: "default" | "override"; range: string }[];
      outputs: { label: string; expr: string; value: number; unit: string }[];
      overrideSource: string | null;
    }
  | { ok: false; why: string; models?: CalcModel[] };

export const modelRef = (doc: Pick<ResearchDoc, "at">, index: number): string => `${doc.at}#${index}`;

/** 这份报告里全部可复算的对象。没有就是空数组。 */
export function catalog(doc: Pick<ResearchDoc, "at" | "blocks"> | null | undefined): CalcModel[] {
  const blocks = doc?.blocks?.blocks ?? [];
  const out: CalcModel[] = [];
  blocks.forEach((b, index) => {
    if (b.type !== "param_model") return;
    out.push({
      ref: modelRef(doc!, index),
      index,
      heading: b.heading?.trim() || `算式 ${out.length + 1}`,
      layer: b.layer?.trim() || "",
      params: b.params,
      outputs: b.outputs,
      disclaimer: b.disclaimer?.trim() || "",
    });
  });
  return out;
}

/** 轮首递给模型的那一段目录：只有标题、引用、层、参数名与单位 —— 不带数值，数值要算了才有。 */
export function catalogText(doc: Pick<ResearchDoc, "at" | "blocks"> | null | undefined): string {
  const models = catalog(doc);
  if (!models.length) return "";
  const lines = models.map(
    (m) =>
      `- 「${m.heading}」 引用 ${m.ref}${m.layer ? ` · 属于${m.layer}` : ""}` +
      `\n  参数：${m.params.map((p) => `${p.id}（${p.label}${p.unit ? `，${p.unit}` : ""}）`).join("；")}` +
      `\n  输出：${m.outputs.map((o) => o.label).join("；")}`
  );
  return (
    `## 报告里可复算的算式（${models.length} 套）\n` +
    `要数值就调 report_calculate，**不要自己心算或誊写默认值**；解释含义也先调它拿到默认值再说。\n` +
    lines.join("\n")
  );
}

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/[,，%]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

export function calculate(doc: Pick<ResearchDoc, "at" | "blocks"> | null | undefined, ask: CalcAsk): CalcOutcome {
  const models = catalog(doc);
  if (!models.length) return { ok: false, why: "这份报告里没有可复算的算式。" };

  let model: CalcModel | undefined;
  const ref = (ask.ref ?? "").trim();
  if (ref) {
    model = models.find((m) => m.ref === ref);
    if (!model) {
      const [version, idx] = ref.split("#");
      const sameVersion = doc && version === doc.at;
      if (!sameVersion) {
        return { ok: false, why: `引用 ${ref} 属于另一版报告（当前版本 ${doc?.at ?? "未知"}），那一套算式不在了。用下面列出的引用。`, models };
      }
      return { ok: false, why: `当前报告里没有第 ${idx} 块这一套算式。用下面列出的引用。`, models };
    }
  } else if (models.length === 1) {
    model = models[0];
  } else {
    return { ok: false, why: `这份报告里有 ${models.length} 套算式，要指明引用，不默认拿第一套。`, models };
  }

  const known = new Map(model.params.map((p) => [p.id, p]));
  const vars: Record<string, number> = {};
  const params: Extract<CalcOutcome, { ok: true }>["params"] = [];
  const problems: string[] = [];

  const overrides = ask.overrides && typeof ask.overrides === "object" ? ask.overrides : {};
  for (const [id, raw] of Object.entries(overrides)) {
    const p = known.get(id);
    if (!p) {
      problems.push(`没有叫 ${id} 的参数（有的是：${[...known.keys()].join("、")}）`);
      continue;
    }
    const v = num(raw);
    if (v === null) {
      problems.push(`参数 ${id} 的值「${String(raw)}」不是数`);
      continue;
    }
    if (v < p.min || v > p.max) {
      problems.push(`参数 ${id} = ${v} 超出算式给的范围 ${p.min}–${p.max}${p.unit ?? ""}`);
      continue;
    }
    vars[id] = v;
  }
  if (problems.length) return { ok: false, why: problems.join("；"), models: [model] };

  for (const p of model.params) {
    const overridden = Object.prototype.hasOwnProperty.call(vars, p.id);
    const value = overridden ? vars[p.id] : p.default;
    vars[p.id] = value;
    params.push({
      id: p.id,
      label: p.label,
      unit: p.unit ?? "",
      value,
      origin: overridden ? "override" : "default",
      range: `${p.min}–${p.max}`,
    });
  }

  const outputs: Extract<CalcOutcome, { ok: true }>["outputs"] = [];
  for (const o of model.outputs) {
    const compiled = compileExpr(o.expr);
    if (!compiled.ok) return { ok: false, why: `「${o.label}」的算式读不了：${compiled.why}`, models: [model] };
    const missing = compiled.expr.ids.filter((id) => !(id in vars));
    if (missing.length) return { ok: false, why: `「${o.label}」用到了没声明的参数 ${missing.join("、")}`, models: [model] };
    const v = compiled.expr.run(vars);
    if (v === null || !Number.isFinite(v)) return { ok: false, why: `「${o.label}」算不出来（除零或结果不是有限值）`, models: [model] };
    outputs.push({ label: o.label, expr: o.expr, value: v, unit: o.unit ?? "" });
  }

  // 「刘明华问：…」这种第三人称前缀剥掉：这一段是给他本人看的（ISS-223 实测模型会这么写）。
  const source = (ask.overrideSource ?? "").trim().replace(/^[^：:，,。\s]{1,12}(?:问|说|提出|要求)[：:，,]\s*/, "");
  return { ok: true, model, params, outputs, overrideSource: source || null };
}

const fmt = (v: number): string => {
  if (Number.isInteger(v)) return String(v);
  const abs = Math.abs(v);
  const digits = abs >= 100 ? 1 : abs >= 1 ? 2 : 3;
  return Number(v.toFixed(digits)).toString();
};

/**
 * 上屏的那一段「这次怎么算」。**全部数字来自 `calculate`**，模型只负责解释，不许重新誊写一套。
 * 没有每日固定成本金额时，只交「个单日固定支出」这类相对单位，不补成金额。
 */
export function renderCalculation(r: Extract<CalcOutcome, { ok: true }>): string {
  const lines: string[] = [`这次怎么算 · 「${r.model.heading}」${r.model.layer ? `（${r.model.layer}）` : ""}`];
  lines.push(
    "参数：" +
      r.params
        .map((p) => `${p.label} ${fmt(p.value)}${p.unit}${p.origin === "override" ? "（您改的）" : "（报告默认）"}`)
        .join("；")
  );
  for (const o of r.outputs) lines.push(`${o.label} ＝ ${fmt(o.value)}${o.unit ? ` ${o.unit}` : ""}　（${o.expr}）`);
  if (r.overrideSource) lines.push(`改动来源：${r.overrideSource}`);
  lines.push(
    r.model.disclaimer
      ? `边界：${r.model.disclaimer}`
      : "边界：默认值是报告里的占位假设，不是实测数；结果是量级情景，不是已兑现收益。"
  );
  return lines.join("\n");
}

/** 递回给模型的工具结果：结构化 + 一句纪律。 */
export function toolResultText(r: CalcOutcome): string {
  if (!r.ok) {
    const list = r.models?.length ? `\n可用的算式：\n${r.models.map((m) => `- ${m.ref} 「${m.heading}」`).join("\n")}` : "";
    return `算不了：${r.why}${list}\n照实告诉他算不了、差什么；不要自己补一个数。`;
  }
  return (
    `${renderCalculation(r)}\n\n` +
    `这一段会原样出现在屏幕上。你只解释它对经营意味着什么、哪个参数最敏感、他该拿这套算式去问对方什么；` +
    `**不要在正文里重新写一遍数字**，也不要把「个单日固定支出」换算成金额 —— 报告里没有单日固定成本的数。`
  );
}
