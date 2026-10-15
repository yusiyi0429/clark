import { describe, expect, it, vi } from "vitest";
import { ANSWER_OPTION_EVENT, chooseAnswerOption, optionPrefill, parseAnswerOptions } from "./answerOptions";

/** 回答末尾的选项块（10/11 首演版定稿）：前端解析后隐藏，解析失败不显示选项，原文一律不显示。 */
const BODY = "## 决策事项\n是否正式采用长期目标。\n\n## 备选方案\n- 维持现状\n- 正式采用";
const block = (json: string) => `${BODY}\n\n\`\`\`options\n${json}\n\`\`\``;

describe("parseAnswerOptions", () => {
  it("合法：取出 2–4 个选项，正文不含选项块", () => {
    const parsed = parseAnswerOptions(block('[{"label":"维持现状"},{"label":"正式采用"},{"label":"暂不决定"}]'));
    expect(parsed.options).toEqual(["维持现状", "正式采用", "暂不决定"]);
    expect(parsed.body).toBe(BODY);
    expect(parsed.body).not.toContain("options");
  });

  it("不合法：JSON 坏了、个数不对、名称超过 12 字，都不显示选项，也不显示原文", () => {
    for (const json of ["[{label:维持现状}]", '[{"label":"只有一个"}]', '[{"label":"一"},{"label":"二"},{"label":"三"},{"label":"四"},{"label":"五"}]',
      '[{"label":"维持现状"},{"label":"这是一个超过十二个字的方案名称啊"}]', '{"label":"维持现状"}', '[{"label":""},{"label":"正式采用"}]']) {
      const parsed = parseAnswerOptions(block(json));
      expect(parsed.options).toEqual([]);
      expect(parsed.body).toBe(BODY);
    }
  });

  it("流式中没写完的块：不露出任何一段（含只写了一半的围栏行）", () => {
    const full = block('[{"label":"维持现状"},{"label":"正式采用"}]');
    const start = full.indexOf("```options");
    for (let end = start; end <= full.length; end++) {
      const parsed = parseAnswerOptions(full.slice(0, end), true);
      expect(parsed.body).toBe(BODY);
      expect(parsed.body).not.toMatch(/`|options|label/);
      if (end < full.length) expect(parsed.options).toEqual([]);
    }
    expect(parseAnswerOptions(full, true).options).toEqual(["维持现状", "正式采用"]);
  });

  it("结束后仍未闭合：隐藏，不显示选项", () => {
    const parsed = parseAnswerOptions(`${BODY}\n\n\`\`\`options\n[{"label":"维持现状"},{"label":"正式`);
    expect(parsed).toEqual({ body: BODY, options: [] });
  });

  it("没有选项块：正文原样，普通代码块不受影响", () => {
    expect(parseAnswerOptions("交付按计划。")).toEqual({ body: "交付按计划。", options: [] });
    const code = "示例：\n\n```ts\nconst a = 1;\n```";
    expect(parseAnswerOptions(code)).toEqual({ body: code, options: [] });
    // 流式中普通代码块的围栏只在还可能是选项块时短暂不显示，写出语言名后照常出现。
    expect(parseAnswerOptions("示例：\n\n```t", true).body).toBe("示例：\n\n```t");
  });
});

describe("选项点击", () => {
  it("填入「选择：{方案名}」，按对话范围派发，不发送", () => {
    expect(optionPrefill("暂不决定")).toBe("选择：暂不决定");
    const dispatch = vi.fn();
    vi.stubGlobal("window", { dispatchEvent: dispatch });
    chooseAnswerOption("battlefield:aidc", "正式采用");
    const event = dispatch.mock.calls[0][0] as CustomEvent<{ scope: string; text: string }>;
    expect(event.type).toBe(ANSWER_OPTION_EVENT);
    expect(event.detail).toEqual({ scope: "battlefield:aidc", text: "选择：正式采用" });
    vi.unstubAllGlobals();
  });
});
