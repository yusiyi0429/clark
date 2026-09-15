/**
 * ISS-223 硬验收（GPT-6 交接 §6）：原参数 lagNow=2、lagFast=0.25、events=10、lossRate=5（%），
 * 三个结果 1 / 0.125 / 0.875 个单日固定支出。旧回答擅改成 20 件、0.5%，结果 0.175 —— 差 5 倍。
 */
import { describe, expect, it } from "vitest";
import type { ResearchDoc } from "@/lib/data/types";
import type { Block } from "@/lib/agent/a4/blocks/schema";
import { calculate, catalog, catalogText, modelRef, renderCalculation, toolResultText } from "./calc";

const PARAM: Block = {
  type: "param_model",
  heading: "把决策等待从 2 天压到 0.25 天，看爬坡期能买回多少空转",
  layer: "重资产产线爬坡期的经营决策层",
  params: [
    { id: "lagNow", label: "当前从异常出现到决定落地的等待时间", default: 2, min: 0.1, max: 10, step: 0.1, unit: "天" },
    { id: "lagFast", label: "闭环压缩后的等待时间", default: 0.25, min: 0.02, max: 5, step: 0.01, unit: "天" },
    { id: "events", label: "每月需要跨部门判断的经营事件数", default: 10, min: 1, max: 60, step: 1, unit: "件" },
    { id: "lossRate", label: "每件事每滞后一天被空转吃掉的产出，折合单日固定支出的比例", default: 5, min: 0, max: 50, step: 1, unit: "%" },
  ],
  outputs: [
    { label: "当前每月被等待吃掉的量", expr: "lagNow * events * lossRate / 100", unit: "个单日固定支出" },
    { label: "压缩后仍会被吃掉的残余", expr: "lagFast * events * lossRate / 100", unit: "个单日固定支出" },
    { label: "每月可回收", expr: "(lagNow - lagFast) * events * lossRate / 100", unit: "个单日固定支出" },
  ],
  disclaimer: "四个默认值都是便于试算的占位，既不是维信诺的数据，也不是行业统计值。",
};

const doc = (blocks: Block[], at = "2026-09-03T19:04:31+08:00"): Pick<ResearchDoc, "at" | "blocks"> =>
  ({ at, blocks: { blocks, evidence: [], title: "", confidence: "初步提示", dataCutoff: "", lane: {} as never } }) as never;

describe("目录", () => {
  it("列出每套算式的引用、参数名和单位，不带数值", () => {
    const text = catalogText(doc([{ type: "prose", md: "x" }, PARAM]));
    expect(text).toContain(`引用 2026-09-03T19:04:31+08:00#1`);
    expect(text).toContain("lagNow（当前从异常出现到决定落地的等待时间，天）");
    // 目录不带数值：默认值要算了才有（"誊写默认值"那句是纪律，不是数）。
    expect(text).not.toContain("10件");
    expect(text).not.toContain("5%");
  });
  it("没有算式就是空串", () => {
    expect(catalogText(doc([{ type: "prose", md: "x" }]))).toBe("");
    expect(catalog(null)).toEqual([]);
  });
});

describe("复算 · ISS-223 硬验收", () => {
  it("全按默认：1 / 0.125 / 0.875 个单日固定支出", () => {
    const r = calculate(doc([PARAM]), {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.outputs.map((o) => o.value)).toEqual([1, 0.125, 0.875]);
    expect(r.params.every((p) => p.origin === "default")).toBe(true);
  });

  it("旧回答那组值（20 件、0.5%）算出来是 0.175 —— 比默认差 5 倍，屏幕上标「您改的」", () => {
    const r = calculate(doc([PARAM]), { overrides: { events: 20, lossRate: 0.5 }, overrideSource: "他说一个月二十件" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.outputs[2].value).toBeCloseTo(0.175, 6);
    const text = renderCalculation(r);
    expect(text).toContain("20件（您改的）");
    expect(text).toContain("改动来源：他说一个月二十件");
    // 模型爱写「刘明华问：…」——这段是给他本人看的，前缀剥掉。
    const r2 = calculate(doc([PARAM]), { overrides: { events: 4 }, overrideSource: "刘明华问：如果一个月只有 4 件事呢？" });
    expect(r2.ok && r2.overrideSource).toBe("如果一个月只有 4 件事呢？");
    expect(text).toContain("个单日固定支出");
  });

  it("边界：未知参数、非数、超范围各报一条，不猜值", () => {
    const r = calculate(doc([PARAM]), { overrides: { foo: 1, events: "很多", lossRate: 80 } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toContain("没有叫 foo 的参数");
    expect(r.why).toContain("不是数");
    expect(r.why).toContain("超出算式给的范围");
  });

  it("引用属于旧版报告时拒绝，不拿同一下标指新模型", () => {
    const r = calculate(doc([PARAM], "2026-09-05T10:00:00+08:00"), { ref: "2026-09-03T19:04:31+08:00#0" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("另一版报告");
  });

  it("多套算式不传引用就拒绝，不默认拿第一套", () => {
    const r = calculate(doc([PARAM, { ...PARAM, heading: "另一套" }]), {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("要指明引用");
    const ok = calculate(doc([PARAM, { ...PARAM, heading: "另一套" }]), { ref: modelRef({ at: "2026-09-03T19:04:31+08:00" }, 1) });
    expect(ok.ok).toBe(true);
  });

  it("除零与非法表达式各自报错", () => {
    const bad: Block = { ...PARAM, outputs: [{ label: "x", expr: "lagNow / (events - 10)" }] };
    const r = calculate(doc([bad]), {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("算不出来");
    const ill: Block = { ...PARAM, outputs: [{ label: "y", expr: "lagNow ** 2" }] };
    const r2 = calculate(doc([ill]), {});
    expect(r2.ok).toBe(false);
  });

  it("工具结果文本：数字段在前，纪律在后，失败时列出可用引用", () => {
    const ok = calculate(doc([PARAM]), {});
    expect(toolResultText(ok)).toContain("不要在正文里重新写一遍数字");
    const bad = calculate(doc([PARAM, PARAM]), {});
    expect(toolResultText(bad)).toContain("可用的算式");
  });
});
