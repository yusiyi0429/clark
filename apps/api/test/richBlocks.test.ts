import { describe, expect, it } from "vitest";
import { CEO_SYSTEM_PROMPT, SYSTEM_PROMPT, driSystemPrompt } from "../src/piConversationRuntime.js";
import { ANSWER_OPTIONS_RULES } from "../src/decisionJudgement.js";
import { SOURCE_CITATION_RULES } from "../src/sourceCitations.js";
import { findForbiddenPhrase } from "../src/promptStyle.js";
import { METRIC_COMPARE_FENCE, RICH_BLOCK_RULES, ROADMAP_FENCE, TIMELINE_FENCE } from "../src/richBlocks.js";
import { RICH_BLOCK_BRIEF } from "../src/conversationPrompt.js";

const fenced = (fence: string) => {
  const start = RICH_BLOCK_RULES.indexOf(`${fence}\n`);
  const end = RICH_BLOCK_RULES.indexOf("\n```", start + fence.length);
  return RICH_BLOCK_RULES.slice(start + fence.length + 1, end);
};

// 对话里的富内容块：模型只输出声明式代码块（前端 apps/web/src/conversation/richBlocks 渲染），公式用 LaTeX。
describe("富内容块提示词", () => {
  it("教会何时用：差距 / 完成度给对比条，推算给公式，时间 / 截止给时间线；结论先行、不每条都给、不编数字", () => {
    for (const text of ["差距", "完成度", "能不能达成", "当前值与目标值", "公式", "代入", "时间 / 节奏 / 截止", "里程碑", "先用一句话写结论",
      "大多数回答不需要", "不估、不补、不凑整", "就不给这个块", "不要用 $ 表示货币"]) expect(RICH_BLOCK_RULES).toContain(text);
    expect(findForbiddenPhrase(RICH_BLOCK_RULES)).toBeNull();
  });

  it("两个示例是合法 JSON，字段与前端解析一致", () => {
    const metric = JSON.parse(fenced(METRIC_COMPARE_FENCE));
    expect(Object.keys(metric)).toEqual(["title", "unit", "items"]);
    expect(metric.items[0]).toEqual({ label: "甲业务收入", current: 120, target: 200 });
    const timeline = JSON.parse(fenced(TIMELINE_FENCE));
    expect(Object.keys(timeline)).toEqual(["title", "now", "items"]);
    expect(timeline.items.map((item: { kind: string }) => item.kind)).toEqual(["now", "milestone", "deadline"]);
  });

  it("roadmap 示例是合法 JSON：泳道、单点与一段、三种状态都有，字段与前端解析一致", () => {
    const roadmap = JSON.parse(fenced(ROADMAP_FENCE));
    expect(Object.keys(roadmap)).toEqual(["title", "now", "lanes"]);
    expect(roadmap.lanes).toHaveLength(2);
    const items = roadmap.lanes.flatMap((lane: { items: Record<string, string>[] }) => lane.items);
    expect(items.map((item: Record<string, string>) => item.status)).toEqual(["confirmed", "planned", "inferred"]);
    expect(items[0]).toEqual({ label: "方案评审会", date: "2026-03-20", status: "confirmed" });
    expect(items[1]).toMatchObject({ start: "2026-04", end: "2026-05" });
  });

  it("什么时候用哪种固定格式；推断要标出来、不补没有依据的内容；不教自由图示（visual 待定）", () => {
    expect(RICH_BLOCK_RULES).not.toContain("visual");
    for (const text of ["一条主线上的时间安排", "几条主线共用一条时间轴", "roadmap",
      "固定格式能表达的用固定格式", "status 写 inferred", "不为了把图画满补没有依据的内容",
      "一个名字、一个数字、一个日期就能答清的问题不出图"]) expect(RICH_BLOCK_RULES, text).toContain(text);
  });

  it("不带完整规则时的一句能力说明提到三种固定格式", () => {
    for (const name of ["timeline", "roadmap", "metric-compare"]) expect(RICH_BLOCK_BRIEF).toContain(name);
    expect(RICH_BLOCK_BRIEF).not.toContain("visual");
  });

  it("公式示例是 LaTeX 块（前后各一行 $$，中文写在 \\text{} 里）", () => {
    expect(RICH_BLOCK_RULES).toMatch(/\n\$\$\n\\text\{所需月均增量\} = \\frac\{\\text\{目标\} - \\text\{当前\}\}\{\\text\{剩余月数\}\} = \\frac\{200 - 120\}\{4\} = 20\n\$\$\n/);
  });

  it("原生只读提示词不带图表块规则", () => {
    expect(SYSTEM_PROMPT).not.toContain("# 图表块与公式");
  });

  it("CEO 提示词带图表块、回答末尾选项与句末出处规则，DRI 提示词不带；不再指向演示版的确认卡工具", () => {
    for (const block of [RICH_BLOCK_RULES, ANSWER_OPTIONS_RULES, SOURCE_CITATION_RULES]) {
      expect(CEO_SYSTEM_PROMPT).toContain(block);
      expect(driSystemPrompt("某人")).not.toContain(block);
    }
    expect(CEO_SYSTEM_PROMPT).not.toContain("propose_business_change");
  });
});
