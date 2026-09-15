import { describe, expect, it } from "vitest";

import { DEFAULT_DEPTH, DEPTH, Harness, NO_COMPANY_CONTEXT, newRunId, normalizeDepth } from "./harness";
import { runTask, taskState } from "./tasks";

describe("思考深度", () => {
  it("五档取值原样是官方 effort 词表", () => {
    expect(Object.keys(DEPTH)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(DEFAULT_DEPTH).toBe("high");
  });

  it("档位越高，研究规模越大（同一个旋钮）", () => {
    expect(DEPTH.low.searchK).toBe(3);
    expect(DEPTH.high).toEqual({ searchK: 5, maxProps: 4, maxRounds: 2 });
    expect(DEPTH.max).toEqual({ searchK: 8, maxProps: 6, maxRounds: 3 });
  });

  it("旧的中文档位折成新档位，不静默降级", () => {
    // 交给 DEPTH[v] ?? 兜底的话，旧的「最重」会悄悄变成 high。
    expect(normalizeDepth("最重")).toBe("max");
    expect(normalizeDepth("轻")).toBe("low");
    expect(normalizeDepth("标准")).toBe("high");
    expect(normalizeDepth("xhigh")).toBe("xhigh");
    expect(normalizeDepth("")).toBe(DEFAULT_DEPTH);
    expect(normalizeDepth(undefined)).toBe(DEFAULT_DEPTH);
    expect(normalizeDepth("特别用力")).toBe(DEFAULT_DEPTH);
  });
});

describe("上下文段", () => {
  it("没开过上下文时，contextBlock 也不是空串", () => {
    // 空串会让模型把「这里应该有东西」当成缺口去填 —— 它会编一套公司战略假设
    // 出来，然后正常引用。那种产出格式全对、引用看着也有，只是全是假的。
    const h = new Harness({ agent: "A1a" });
    expect(h.contextBlock).toBe(NO_COMPANY_CONTEXT);
    expect(h.contextBlock.length).toBeGreaterThan(100);
    expect(h.externalOnly).toBe(true);
  });

  it("NO_COMPANY_CONTEXT 把「引用必须为空」写成硬约束", () => {
    expect(NO_COMPANY_CONTEXT).toContain("cited_member_ids");
    expect(NO_COMPANY_CONTEXT).toContain("[]");
  });
});

describe("finish", () => {
  it("没跑过任何一步也能落一条 failed 记录，复现坐标为空但字段齐全", () => {
    const h = new Harness({ agent: "A3", slot: "pro", depth: "低" });
    const rec = h.finish({ status: "failed", error: "GraphKnowledge 不可达" });
    expect(rec.agent).toBe("A3");
    expect(rec.status).toBe("failed");
    expect(rec.contextMode).toBe("");
    expect(rec.depth).toBe(DEFAULT_DEPTH);
    expect(rec.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });
    expect(rec.checkSummary.total).toBe(0);
    expect(rec.id.startsWith("RUN-A3-")).toBe(true);
    expect(rec.latencyMs).toBeGreaterThanOrEqual(0);
  });

  /*
   * 第一轮违规是**重修成功时**才有意义的那个字段：重修失败的那几条 `violations`
   * 本来就落着。所以这里锁的是「过了也留痕」和「一轮就过不留空数组」这一对。
   */
  it("重修成功也留下第一轮的违规原文，degraded 不置位", () => {
    const h = new Harness({ agent: "A3", slot: "pro" });
    const rec = h.finish({
      status: "ok",
      output: {},
      violations: [],
      firstRoundViolations: ["A3-STATUS p0 status 不是三个取值之一"],
      degraded: false,
    });
    expect(rec.firstRoundViolations).toEqual(["A3-STATUS p0 status 不是三个取值之一"]);
    expect(rec.violations).toBeUndefined();
    expect(rec.degraded).toBeUndefined();
  });

  it("一轮就过：不写空数组 —— 空数组和「没记」在统计时分不开", () => {
    const h = new Harness({ agent: "A4", slot: "pro" });
    const rec = h.finish({ status: "ok", output: {}, violations: [], firstRoundViolations: [] });
    expect("firstRoundViolations" in rec).toBe(false);
  });

  it("note 落进 trace，顺序保留", () => {
    const h = new Harness({ agent: "A1a" });
    h.note("甲", { x: 1 });
    h.note("乙");
    const rec = h.finish({ status: "ignored", output: {} });
    expect(rec.trace.map((n) => n.label)).toEqual(["甲", "乙"]);
    expect(rec.trace[0].detail).toEqual({ x: 1 });
    expect(rec.status).toBe("ignored");
  });
});

describe("上报走到第几步", () => {
  /*
   * 这一组钉的是**分母的含义**：屏幕上写着「第 N/4 步」，那个 4 是链路声明的常量。
   * 重修一轮就把 N 加一的话，第 5 步会出现在一个说好只有四步的流程里 —— 那时那个
   * 分母不再是一个可核对的事实，而它是这行字唯一的价值。
   */
  const runningTask = (id: string) => {
    let end!: () => void;
    runTask("t-h", id, () => new Promise<{ attempts?: number }>((r) => (end = () => r({}))));
    return () => end();
  };

  it("step 一格一格往前，substep 只在原话后面接一句轮次", () => {
    const end = runningTask("step");
    const h = new Harness({ agent: "A4", slot: "pro", progress: { kind: "t-h", id: "step", total: 4 } });

    h.step("装配上下文");
    expect(taskState("t-h", "step").step).toMatchObject({ no: 1, total: 4, label: "装配上下文" });

    h.step("压成四节");
    expect(taskState("t-h", "step").step).toMatchObject({ no: 2, label: "压成四节" });

    h.substep("重修第 1 轮");
    expect(taskState("t-h", "step").step).toMatchObject({
      no: 2, // ← 序号不动。重修是这一步内部再跑一遍，不是下一步。
      label: "压成四节 · 重修第 1 轮",
    });

    h.substep("重修第 2 轮");
    expect(taskState("t-h", "step").step).toMatchObject({ no: 2, label: "压成四节 · 重修第 2 轮" });

    // 重修完接着往下走：分母仍然是 4，序号接着 2 往后数。
    h.step("反证复核");
    expect(taskState("t-h", "step").step).toMatchObject({ no: 3, total: 4, label: "反证复核" });
    end();
  });

  it("没给 progress 就一个字都不报 —— 没上报的链路屏幕上只说「在跑」", () => {
    const end = runningTask("silent");
    const h = new Harness({ agent: "A3", slot: "pro" });
    h.step("装配上下文");
    h.substep("重修第 1 轮");
    expect(taskState("t-h", "silent").step).toBeUndefined();
    end();
  });
});

describe("newRunId", () => {
  it("带上 agent 名，两次不撞", () => {
    const a = newRunId("A1a");
    const b = newRunId("A1a");
    expect(a).toContain("A1a");
    expect(a).not.toBe(b);
  });
});

/**
 * 时间上限那一头。链路自己按 `msLeft` 取舍该少跑哪一步（`a4/deadline.ts`），harness 这一层
 * 只做两件事：把每一次调用的等待压到剩下的时间之内，以及**剩得连一次都发不出去时就地拒发**。
 *
 * 拒发要留一条 trace ——「这一次没发出去」和「发了但回来是空的」在账上必须分得开。
 */
describe("时间上限", () => {
  it("不给 deadline 就是不限", () => {
    const h = new Harness({ agent: "A4", slot: "pro" });
    expect(h.msLeft).toBe(Number.POSITIVE_INFINITY);
  });

  it("给了就从建 harness 那一刻起算", () => {
    const h = new Harness({ agent: "A4", slot: "pro", deadlineMs: 60_000 });
    expect(h.msLeft).toBeLessThanOrEqual(60_000);
    expect(h.msLeft).toBeGreaterThan(55_000);
  });

  it("剩下的时间不够发一次调用时就地拒发，trace 上留一条", async () => {
    process.env.TKOS_MODEL_MOCK = "1";
    try {
      const h = new Harness({ agent: "A4", slot: "pro", deadlineMs: 1 });
      expect(h.msLeft).toBeLessThanOrEqual(1);
      await expect(
        h.callMessages("模型调用 · 测试", [{ role: "user", content: "随便一句" }], { slot: "pro", maxTokens: 100 })
      ).rejects.toThrow("时间上限");
      const rec = h.finish({ status: "ok" });
      const node = rec.trace.find((n) => n.kind === "model");
      expect(node?.error).toContain("不够发一次调用");
      expect(node?.ms).toBe(0);
    } finally {
      delete process.env.TKOS_MODEL_MOCK;
    }
  });
});
