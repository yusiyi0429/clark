import { describe, expect, it } from "vitest";
import type { Card } from "@/lib/api/client";
import { referenceTarget } from "./references";

const issue = (id: string) => ({ id: `issue:${id}`, kind: "issue" }) as Card;

describe("引用按钮写清引用了什么（巡检 P2-25）", () => {
  it("整体 / 战场卡引用的是卡上的议题：写「X 的 N 个议题」", () => {
    expect(referenceTarget("AIDC", [issue("a"), issue("b"), issue("c")])).toBe("AIDC 的 3 个议题");
    expect(referenceTarget("整体", [issue("a"), issue("b")])).toBe("整体的 2 个议题");
    expect(referenceTarget("某议题", [issue("a")])).toBe("某议题");
  });
});
