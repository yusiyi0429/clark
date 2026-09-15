import { describe, expect, it } from "vitest";
import { makeProvenance } from "./provenance";

describe("makeProvenance", () => {
  it("每份产物都答得出是哪个议题、哪一段", () => {
    const p = makeProvenance("I-7");
    expect(p).toEqual({ issueId: "I-7", stage: "pre_research" });
  });

  it("给了会话号就带上，没给就不留空键", () => {
    expect(makeProvenance("I-7", "S-3").sessionId).toBe("S-3");
    expect("sessionId" in makeProvenance("I-7")).toBe(false);
  });

  it("议题号是空串直接抛 —— 挂不上来源的产物不许生出来", () => {
    expect(() => makeProvenance("")).toThrow(/议题/);
  });
});
