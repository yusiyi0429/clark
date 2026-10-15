import { describe, expect, it } from "vitest";
import { ANSWER_OPTIONS_RULES, DECISION_JUDGEMENT_RULES, DECISION_SECTIONS } from "../src/decisionJudgement.js";
import { SYSTEM_PROMPT } from "../src/piConversationRuntime.js";
import { findForbiddenPhrase } from "../src/promptStyle.js";

// 10/11 首演版定稿：CEO 请 Agent 判断 / 评估决策时按六节组织；给出备选方案时回答末尾附选项块（前端解析后隐藏）。
describe("决策判断的结构", () => {
  it("六节节名固定、专业，按顺序写成 Markdown 小标题", () => {
    expect(DECISION_SECTIONS).toEqual(["决策事项", "备选方案", "关键假设", "预期回报", "下行风险", "主要异议"]);
    const positions = DECISION_SECTIONS.map((name) => DECISION_JUDGEMENT_RULES.indexOf(`### ${name}：`));
    expect(positions.every((position) => position > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("各节要点与通用要求都在：维持现状、≤3 条假设与否证证据、口径与截至时间、缺什么、止损、异议来源", () => {
    for (const text of ["默认 CEO", "是否可撤回", "判断标准", "「维持现状」", "继续、追加、暂停、退出", "不超过 3 条", "即不成立",
      "口径与截至时间", "说明缺什么", "模拟数值照实读出，不加来源标注", "不在回答里标注来源性质", "止损", "依据或来源", "关键判断标明来源", "不用称呼", "推荐意见只在这里说一次", "普通问答"]) {
      expect(DECISION_JUDGEMENT_RULES).toContain(text);
    }
  });

  it("措辞严肃：不用口语化节名，不含翻案句", () => {
    for (const casual of ["最强反方", "反方", "唱反调", "拍脑袋", "大白话"]) expect(DECISION_JUDGEMENT_RULES + ANSWER_OPTIONS_RULES).not.toContain(casual);
    expect(findForbiddenPhrase(DECISION_JUDGEMENT_RULES + ANSWER_OPTIONS_RULES)).toBeNull();
  });

  it("选项块：围栏 options、JSON 数组 {label}、2–4 个、≤12 字、可加暂不决定、放在最后", () => {
    expect(ANSWER_OPTIONS_RULES).toContain('```options\n[{"label":"维持现状"},{"label":"正式采用"},{"label":"暂不决定"}]\n```');
    for (const text of ["2–4 个选项", "不超过 12 个字", "「暂不决定」", "最后内容", "没有备选方案的回答不附选项块"]) expect(ANSWER_OPTIONS_RULES).toContain(text);
  });

  it("原生只读提示词不带决策判断结构", () => {
    expect(SYSTEM_PROMPT).not.toContain("# 决策判断的结构");
  });
});

describe("回答末尾选项的触发条件（巡检 P1-11）", () => {
  it("一号位明确要几个可选的下一步 / 方案时也给选项块，普通回答不给", () => {
    expect(ANSWER_OPTIONS_RULES).toContain("给我几个可选的下一步");
    expect(ANSWER_OPTIONS_RULES).toContain("其他回答一律不附");
    expect(ANSWER_OPTIONS_RULES).toContain("先补首项目底稿");
  });
});
