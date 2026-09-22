import { describe, expect, it } from "vitest";
import { DECISION_QUESTION_MAX_LENGTH, PreflightReviewEntryKind } from "@warmap/contracts";
import {
  LEADER_LENS_FORBIDDEN_TEXT,
  MEETING_QUESTION_MAX,
  MEETING_QUESTION_MIN,
  PREFLIGHT_ENTRY_KINDS,
} from "../src/promptRules.js";
import { findForbiddenPhrase, HUMAN_WRITING_STYLE } from "../src/promptStyle.js";
import { PREFLIGHT_PROMPT } from "../src/preflightAgent.js";
import { RADAR_PROMPT } from "../src/radarAgent.js";
import { RESEARCH_PROMPT } from "../src/researchAgent.js";
import { POST_MEETING_PROMPT } from "../src/postMeetingAgent.js";
import { MONTHLY_DRAFT_PROMPT } from "../src/monthlyDraftAgent.js";

describe("turn-phrase validation", () => {
  it("hits the four core variants", () => {
    expect(findForbiddenPhrase("问题不是投入多少，而是何时投入")).toBe("不是……而是……");
    expect(findForbiddenPhrase("并非能力不足，而是节奏错了")).toBe("并非……而是……");
    expect(findForbiddenPhrase("关键不在于投入多少而在于何时投入")).toBe("不在于……而在于……");
    expect(findForbiddenPhrase("与其说缺预算不如说缺优先级")).toBe("与其说……不如说……");
  });

  it("leaves positive statements and unrelated contrast alone", () => {
    expect(findForbiddenPhrase("判断从正面直接下，先给判断，再给依据")).toBeNull();
    expect(findForbiddenPhrase("这个问题不是他提的。而是别人提的")).toBeNull();
    expect(findForbiddenPhrase("为什么现在必须选择渠道投入，而不是再等一个季度？")).toBeNull();
  });
});

describe("shared rules reach the prompts", () => {
  it("preflight prompt carries the constant counts and phrases", () => {
    expect(PREFLIGHT_PROMPT).toContain(`meeting_question 必须 ${MEETING_QUESTION_MIN}–${MEETING_QUESTION_MAX} 条`);
    expect(PREFLIGHT_PROMPT).toContain(PREFLIGHT_ENTRY_KINDS.join("、"));
    expect(PREFLIGHT_PROMPT).toContain(`禁止出现${LEADER_LENS_FORBIDDEN_TEXT}`);
  });

  it("radar prompt carries the contract decisionQuestion limit", () => {
    expect(RADAR_PROMPT).toContain(`decisionQuestion 写成不超过 ${DECISION_QUESTION_MAX_LENGTH} 个汉字`);
  });

  it("monthly draft prompt carries the long-term strategy constraint", () => {
    expect(MONTHLY_DRAFT_PROMPT).toContain("不得把长期表述原样复制成当月结果");
  });

  it("every candidate prompt carries the shared style block", () => {
    for (const prompt of [PREFLIGHT_PROMPT, RADAR_PROMPT, RESEARCH_PROMPT, POST_MEETING_PROMPT, MONTHLY_DRAFT_PROMPT]) {
      expect(prompt).toContain(HUMAN_WRITING_STYLE);
      expect(prompt).toContain("不是……而是……");
    }
  });

  it("PREFLIGHT_ENTRY_KINDS matches the contract union", () => {
    const contractKinds = PreflightReviewEntryKind.anyOf.map((schema) => (schema as { const: string }).const);
    expect([...PREFLIGHT_ENTRY_KINDS]).toEqual(contractKinds);
  });
});
