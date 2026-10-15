import { describe, expect, it } from "vitest";
import { changedCheckableItemIds } from "../src/monthlyPlans.js";

describe("保存草案时只退回内容真正变了的核对项", () => {
  const row = {
    company_outcome: "守住毛利",
    battlefields: [{ battlefieldId: "aidc", outcome: "交付首批" }, { battlefieldId: "fdd", outcome: "跑通首单" }],
    capabilities: [{ capabilityId: "cap", outcome: "第一个客户" }],
    todos: [{ id: "t1", title: "复核合同", ownerId: "p1", sourceRef: "issue:9" }, { id: "t2", title: "排期", ownerId: "p2", sourceRef: "issue:9" }],
  };

  it("改一个战场只退回这个战场；公司结果没变不退回", () => {
    const changed = changedCheckableItemIds(row, {
      companyOutcome: "守住毛利",
      battlefields: [{ battlefieldId: "aidc", outcome: "交付首批并验收" }, { battlefieldId: "fdd", outcome: "跑通首单" }],
    });
    expect([...changed]).toEqual(["battlefield:aidc"]);
  });

  it("公司结果、能力、待办按条比较；新增的待办算变了", () => {
    const changed = changedCheckableItemIds(row, {
      companyOutcome: "守住毛利，现金流转正",
      capabilities: [{ capabilityId: "cap", outcome: "第一个客户" }],
      todos: [{ id: "t1", title: "复核合同", ownerId: "p1", sourceRef: "issue:9" }, { id: "t2", title: "排期", ownerId: "p3", sourceRef: "issue:9" }, { id: "t3", title: "新的", ownerId: "p1", sourceRef: "issue:9" }],
    });
    expect([...changed].sort()).toEqual(["company", "todo:t2", "todo:t3"]);
  });

  it("请求里没出现的类别不算变", () => {
    expect(changedCheckableItemIds(row, {}).size).toBe(0);
  });
});
