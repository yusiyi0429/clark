import { describe, expect, it } from "vitest";
import { cleanThought, thinkingHeadline } from "../src/conversationRouting.js";
import { analysisLabel, cleanThought as preflightThought } from "../src/preflightProgress.js";
import { cutText } from "../src/textCut.js";

/** 结尾落单的高位代理：网页上画成 �，写进 jsonb 也可能被 Postgres 拒收。 */
const HALF = /[\uD800-\uDBFF]$/;

describe("上屏文字的截断", () => {
  it("截断不会留下半个 emoji", () => {
    // 第 30 个 UTF-16 单元正好是 😀 的前一半。
    const long = `${"中".repeat(29)}😀尾巴`;
    expect(cutText(long, 30)).toBe("中".repeat(29));
    expect(cutText("短😀", 30)).toBe("短😀");
    expect(cutText(`ab😀`, 4)).toBe("ab😀");

    for (const text of [thinkingHeadline(`**${long}**`), cleanThought(long), preflightThought(long)]) {
      expect(text).toBe("中".repeat(29));
      expect(text).not.toMatch(HALF);
    }
    const label = analysisLabel({ relatedMeetings: [{ title: `${"会".repeat(23)}😀会`, scheduledAt: "2026-11-19T02:00:00.000Z" }] } as never);
    expect(label).toContain(`《${"会".repeat(23)}》`);
    expect(label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
