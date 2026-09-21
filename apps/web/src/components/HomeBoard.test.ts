import { describe, expect, it } from "vitest";
import { radarIssueSummary } from "./HomeBoard";

describe("Radar Issue Hover 摘要", () => {
  it("只读取 Radar originRef 中已持久化的 strategicImpact，不编造内容", () => {
    expect(radarIssueSummary({ strategicImpact: "该变化直接涉及企业 Agent 的授权与执行边界。" }))
      .toBe("该变化直接涉及企业 Agent 的授权与执行边界。");
    expect(radarIssueSummary({ summary: "不是摘要字段" })).toBeNull();
    expect(radarIssueSummary(null)).toBeNull();
  });
});
