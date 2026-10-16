import { describe, expect, it } from "vitest";
import { beijingLabel, withBeijingTimes } from "../src/agentTime.js";

describe("交给 Agent 的时间一律是北京时间", () => {
  it("把 UTC ISO 串换成北京时间文字，跨日也正确", () => {
    expect(beijingLabel(new Date("2026-10-09T08:20:00.000Z"))).toBe("2026-10-09 16:20（北京时间）");
    expect(withBeijingTimes("2026-10-09T17:30:00Z")).toBe("2026-10-10 01:30（北京时间）");
  });

  it("递归处理群讨论与历史分层结果，不碰正文、引用和数字", () => {
    const evidence = {
      discussions: [{ cite: "discussion:3", author: "何静", at: "2026-10-09T08:20:00.000Z", content: "27天是按9月18日确认书的口径，2026-10-09T08:20:00Z 不是时间字段" }],
      materials: [{ cite: "material:x@v2", version: 2, updatedAt: "2026-10-09T07:30:00.000Z", truncated: false, text: null }],
      history: { effective: [{ ref: "decision:1", decidedAt: "2026-09-25T09:20:00.000Z", statusAt: null }] },
    };
    const out = withBeijingTimes(evidence);
    expect(out.discussions[0].at).toBe("2026-10-09 16:20（北京时间）");
    expect(out.discussions[0].content).toBe(evidence.discussions[0].content);
    expect(out.discussions[0].cite).toBe("discussion:3");
    expect(out.materials[0]).toEqual({ cite: "material:x@v2", version: 2, updatedAt: "2026-10-09 15:30（北京时间）", truncated: false, text: null });
    expect(out.history.effective[0]).toEqual({ ref: "decision:1", decidedAt: "2026-09-25 17:20（北京时间）", statusAt: null });
    expect(JSON.stringify(out)).not.toMatch(/"\d{4}-\d{2}-\d{2}T[^"]*Z"/);
    // 原对象不被改写（接口和界面仍用 ISO）。
    expect(evidence.discussions[0].at).toBe("2026-10-09T08:20:00.000Z");
  });

  it("不是完整 UTC 时间戳的字符串保持原样", () => {
    for (const value of ["2026-10-09", "16:20", "2026-10-09T08:20:00+08:00", "material:abc@v2#p3", ""]) expect(withBeijingTimes(value)).toBe(value);
  });
});
