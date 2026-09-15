import { describe, expect, it } from "vitest";

import { DECISIONS, normalizeDecision } from "./run";

describe("路由归一化", () => {
  it("三个正式取值原样通过", () => {
    for (const d of DECISIONS) {
      expect(normalizeDecision({ decision: d })).toEqual({ decision: d, raw: d });
    }
  });

  it("认得出的近义词归一化，并把原值带出来供自检标注", () => {
    expect(normalizeDecision({ decision: "修改已存的issue" }).decision).toBe("update_issue");
    expect(normalizeDecision({ decision: "Update-Existing" }).decision).toBe("update_issue");
    expect(normalizeDecision({ decision: "创建新议题" }).decision).toBe("new_issue");
    expect(normalizeDecision({ decision: "potential_issue" }).decision).toBe("new_issue");
    expect(normalizeDecision({ decision: " NOISE " }).decision).toBe("ignore");
    expect(normalizeDecision({ decision: "噪音" }).raw).toBe("噪音");
  });

  it("认不出就是 null —— 不猜", () => {
    // 随便挑一条会产出一份格式完整、却走错了路的议题，而且毫无迹象。
    expect(normalizeDecision({ decision: "也许吧" }).decision).toBeNull();
    expect(normalizeDecision({}).decision).toBeNull();
    expect(normalizeDecision({}).raw).toBe("");
    expect(normalizeDecision({ decision: 3 }).decision).toBeNull();
    expect(normalizeDecision({ decision: 3 }).raw).toBe("3");
  });
});
