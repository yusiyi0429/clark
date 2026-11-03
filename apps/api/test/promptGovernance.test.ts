import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DECISION_QUESTION_MAX_LENGTH, PreflightCandidate } from "@warmap/contracts";
import {
  PREFLIGHT_DECISIONS_MAX,
  PREFLIGHT_GAPS_MAX,
  PREFLIGHT_LENGTH,
  PREFLIGHT_OPTIONS_MAX,
  PREFLIGHT_OPTIONS_MIN,
  PREFLIGHT_QUESTIONS_MAX,
} from "../src/promptRules.js";
import { ADDRESS_STYLE, findForbiddenPhrase, HUMAN_WRITING_STYLE } from "../src/promptStyle.js";
import { PERSONAL_REVIEW_DRAFT_PROMPT } from "../src/personalReviewAgent.js";
import { MATERIAL_ANNOTATION_PROMPT } from "../src/materialAnnotationAgent.js";
import { MISSION_CARD_ANNOTATION_PROMPT } from "../src/missionCardAnnotationAgent.js";
import { MISSION_CARD_REVIEW_PROMPT } from "../src/missionCardReview.js";
import { MISSION_CARD_DRAFT_PROMPT } from "../src/missionCardDraftAgent.js";
import { MISSION_CARD_DRAFT_REVIEW_PROMPT } from "../src/missionCardWritingRules.js";
import { TASK_ACCEPTANCE_PROMPT } from "../src/taskAcceptanceDraft.js";
import { deliverableNotePrompt, DELIVERABLE_REVIEW_PROMPT } from "../src/deliverableReview.js";
import { buddyPersona } from "../src/buddyPersona.js";
import { THREAD_INTRO_PROMPT } from "../src/threadIntro.js";
import { driSystemPrompt, MISSION_CARD_EDITING_PROMPT, SYSTEM_PROMPT } from "../src/piConversationRuntime.js";
import { PREFLIGHT_PROMPT } from "../src/preflightAgent.js";
import { RADAR_PROMPT } from "../src/radarAgent.js";
import { RESEARCH_PROMPT } from "../src/researchAgent.js";
import { POST_MEETING_PROMPT } from "../src/postMeetingAgent.js";
import { MONTHLY_DRAFT_PROMPT } from "../src/monthlyDraftAgent.js";
import { PERSONAL_RADAR_PROMPT } from "../src/personalRadarAgent.js";
import { MONTHLY_REVIEW_ASSESS_PROMPT, MONTHLY_REVIEW_DRAFT_PROMPT, MONTHLY_REVIEW_SUMMARY_PROMPT } from "../src/monthlyReviewAgents.js";

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
  it("preflight prompt carries the constant caps and phrases, without any question quota", () => {
    expect(PREFLIGHT_PROMPT).toContain(`questions 写一到 ${PREFLIGHT_QUESTIONS_MAX} 个`);
    expect(PREFLIGHT_PROMPT).toContain(`decisions 写零到 ${PREFLIGHT_DECISIONS_MAX} 个`);
    expect(PREFLIGHT_PROMPT).toContain(`gaps 写一到 ${PREFLIGHT_GAPS_MAX} 句`);
    expect(PREFLIGHT_PROMPT).toContain(`每条写 ${PREFLIGHT_OPTIONS_MIN} 到 ${PREFLIGHT_OPTIONS_MAX} 个 options`);
    expect(PREFLIGHT_PROMPT).toContain(`headline 不超过 ${PREFLIGHT_LENGTH.headline} 字`);
    expect(PREFLIGHT_PROMPT).not.toMatch(/decisions 必须 \d/);
    for (const text of ["whyNow", "whyCeo", "changeIf", "material:<id>@v<版本>", "discussion:<id>", "decision:<id>"]) expect(PREFLIGHT_PROMPT).toContain(text);
  });

  it("radar prompt carries the contract decisionQuestion limit", () => {
    expect(RADAR_PROMPT).toContain(`decisionQuestion 写成不超过 ${DECISION_QUESTION_MAX_LENGTH} 个汉字`);
  });

  it("monthly draft prompt carries the long-term strategy constraint", () => {
    expect(MONTHLY_DRAFT_PROMPT).toContain("不得把长期表述原样复制成当月结果");
    expect(MONTHLY_DRAFT_PROMPT).toContain("previousReview 是上月已确认的复盘，是本月结果的重要依据");
  });

  it("personal radar prompt is versioned, owner-only and asks for no promotion", () => {
    expect(PERSONAL_RADAR_PROMPT.startsWith("Tianshu Personal Radar Assess v1\n")).toBe(true);
    expect(PERSONAL_RADAR_PROMPT).toContain("这些结果只给他本人看：不要提出决策问题、选项、紧急程度或升级建议。");
    expect(PERSONAL_RADAR_PROMPT).toContain('{"candidates":[]}');
    expect(PERSONAL_RADAR_PROMPT).not.toContain("promotion");
  });

  it("every candidate prompt carries the shared style block", () => {
    for (const prompt of [PREFLIGHT_PROMPT, RADAR_PROMPT, RESEARCH_PROMPT, POST_MEETING_PROMPT, MONTHLY_DRAFT_PROMPT, PERSONAL_RADAR_PROMPT,
      MONTHLY_REVIEW_DRAFT_PROMPT, MONTHLY_REVIEW_ASSESS_PROMPT, MONTHLY_REVIEW_SUMMARY_PROMPT]) {
      expect(prompt).toContain(HUMAN_WRITING_STYLE);
      expect(prompt).toContain("不是……而是……");
    }
  });

  it("preflight caps in the prompt match the candidate contract", () => {
    const { questions, decisions, gaps } = PreflightCandidate.properties;
    expect(questions.maxItems).toBe(PREFLIGHT_QUESTIONS_MAX);
    expect(decisions.maxItems).toBe(PREFLIGHT_DECISIONS_MAX);
    expect(gaps.maxItems).toBe(PREFLIGHT_GAPS_MAX);
    expect(decisions.items.properties.options.minItems).toBe(PREFLIGHT_OPTIONS_MIN);
    expect(decisions.items.properties.options.maxItems).toBe(PREFLIGHT_OPTIONS_MAX);
  });
});

/**
 * 称呼与开场（所有 Agent 文字）：不称头衔或姓名、不客套开场、「您」不滥用。
 * 每个 prompt 都要带 ADDRESS_STYLE；新增 prompt 没带时下面的扫描会失败。
 */
describe("address and opening rule reaches every prompt", () => {
  it("the rule names the forbidden titles and greeting, and the shared style block carries it", () => {
    expect(ADDRESS_STYLE).toContain("「王总」「X 总」「领导」「老板」");
    expect(ADDRESS_STYLE).toContain("「您好」");
    expect(ADDRESS_STYLE).toContain("第一句直接进入正题");
    expect(ADDRESS_STYLE).toContain("可以用「您」，但不要句句都用");
    expect(ADDRESS_STYLE).toContain("提议理由、晨报、会前预审报告、摘要");
    expect(HUMAN_WRITING_STYLE).toContain(ADDRESS_STYLE);
  });

  it("every Agent prompt (conversation, candidate agents, co-agents) contains the rule", () => {
    const prompts: [string, string][] = [
      ["preflight", PREFLIGHT_PROMPT], ["radar", RADAR_PROMPT], ["research", RESEARCH_PROMPT], ["post-meeting", POST_MEETING_PROMPT],
      ["monthly-draft", MONTHLY_DRAFT_PROMPT], ["personal-radar", PERSONAL_RADAR_PROMPT], ["review-draft", MONTHLY_REVIEW_DRAFT_PROMPT],
      ["review-assess", MONTHLY_REVIEW_ASSESS_PROMPT], ["review-summary", MONTHLY_REVIEW_SUMMARY_PROMPT], ["personal-review", PERSONAL_REVIEW_DRAFT_PROMPT],
      ["material-annotation", MATERIAL_ANNOTATION_PROMPT], ["mission-card-annotation", MISSION_CARD_ANNOTATION_PROMPT], ["mission-card-review", MISSION_CARD_REVIEW_PROMPT],
      ["mission-card-draft", MISSION_CARD_DRAFT_PROMPT], ["mission-card-draft-review", MISSION_CARD_DRAFT_REVIEW_PROMPT],
      ["task-acceptance", TASK_ACCEPTANCE_PROMPT], ["thread-intro", THREAD_INTRO_PROMPT],
      ["deliverable-review", DELIVERABLE_REVIEW_PROMPT], ["deliverable-note", deliverableNotePrompt("steady")], ["deliverable-note-critical", deliverableNotePrompt("critical")],
      ["ceo-conversation", SYSTEM_PROMPT],
      ["dri-conversation", driSystemPrompt("测试乙")], ["dri-mission-card", `${driSystemPrompt("测试乙", true)}\n\n${MISSION_CARD_EDITING_PROMPT}`],
    ];
    for (const [name, prompt] of prompts) expect(prompt, name).toContain(ADDRESS_STYLE);
    const personalities = ["steady", "cheerful", "calm", "critical"] as const;
    for (const prompt of [DELIVERABLE_REVIEW_PROMPT, ...personalities.map(deliverableNotePrompt), ...personalities.map((personality) => buddyPersona({ name: "团团", personality }, "测试乙"))]) {
      expect(findForbiddenPhrase(prompt)).toBeNull();
    }
  });

  it("no prompt source in apps/api/src is left without the rule (dictation polish only rewrites the speaker's own words)", () => {
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    // conversationRouting 的分诊提示词只让快模型输出一行档位 JSON，不产出给人看的文字；开场说明是固定模板（另有用例核对）。
    // conversationPrompt 只是对话系统提示的按档位替换段（快答检索条款），替换进去以后的整段仍带表达要求（另有用例核对）。
    // personalMemoryRecall 的召回提示词与分诊一样只让快模型输出一行编号 JSON，不产出给人看的文字。
    // memoryImportAgent 的分类和核对提示词只输出分类标签、把握和不超过 40 字的短标题，不产出给人看的段落。
    const exempt = new Set(["dictationPolishPrompt.ts", "promptStyle.ts", "conversationRouting.ts", "conversationPrompt.ts", "personalMemoryRecall.ts", "memoryImportAgent.ts"]);
    const missing = readdirSync(dir).filter((file) => file.endsWith(".ts") && !exempt.has(file)).filter((file) => {
      const source = readFileSync(join(dir, file), "utf8");
      const declaresPrompt = /(?:const|export const) [A-Z_]*PROMPT\s*=\s*[`[]/.test(source) || /`你是[^`]{0,40}(Agent|Co-Agent|助手)/.test(source);
      return declaresPrompt && !/ADDRESS_STYLE|HUMAN_WRITING_STYLE|CONVERSATION_WRITING_STYLE|SYSTEM_PROMPT\}/.test(source);
    });
    expect(missing).toEqual([]);
  });

  it("fixed copy in the apps carries no titles or greetings (people's names in data are untouched)", () => {
    const roots = ["../src/", "../../web/src/"].map((path) => fileURLToPath(new URL(path, import.meta.url)));
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(path); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name) || entry.name === "promptStyle.ts") continue;
        const source = readFileSync(path, "utf8");
        for (const match of source.matchAll(/王总|(?![汇合])[一-龥]总[，,。：:！]|您好|尊敬的|老板|领导/g)) hits.push(`${entry.name}: ${match[0]}`);
      }
    };
    roots.forEach(walk);
    expect(hits).toEqual([]);
  });
});

describe("一号位看得懂的用语（巡检 P2-20/21）", () => {
  it("每个带称呼规则的 Agent 都带内部代号与系统口吻的约束", async () => {
    const { ADDRESS_STYLE: style, PLAIN_TERMS_STYLE } = await import("../src/promptStyle.js");
    expect(style).toContain(PLAIN_TERMS_STYLE);
    for (const text of ["G3a", "Company LTCO", "议题 v3", "四输入边界", "用白话说", "（检索摘要，未经原文核验）", "「一号位」", "。、"]) expect(PLAIN_TERMS_STYLE).toContain(text);
  });
});

describe("一号位用语：提示词不要求写 LTO / PO 缩写", () => {
  it("共享表达要求写明：对一号位用长期目标、本月目标，不带缩写括注", async () => {
    for (const text of [HUMAN_WRITING_STYLE]) {
      expect(text).toContain("不使用 LTO、PO 缩写");
      expect(text).toContain("长期目标");
      expect(text).toContain("本月目标");
      expect(text).not.toContain("长期目标（LTO）");
    }
  });
  it("提示词与对话运行时源码里没有「长期目标（LTO）」这类带缩写的写法", () => {
    const dir = join(fileURLToPath(new URL("../src", import.meta.url)));
    for (const file of ["preflightAgent.ts", "researchAgent.ts", "piConversationRuntime.ts"]) {
      expect(readFileSync(join(dir, file), "utf8"), file).not.toContain("长期目标（LTO）");
    }
  });
});

describe("结论先行、结构化（反馈会议）", () => {
  it("共享表达要求要求结论先行，要点写成「- **加粗的核心结论或待判断的问题**：解释」，短问答直接回答", () => {
    for (const text of ["# 结论先行、结构化", "先给结论", "- **加粗的核心结论或待判断的问题**：解释", "避免大段自然语言", "一两句能答完的短问答直接回答"]) expect(HUMAN_WRITING_STYLE).toContain(text);
  });

  it("每个带共享表达要求的 prompt 都带这条规则", () => {
    for (const prompt of [PREFLIGHT_PROMPT, RADAR_PROMPT, RESEARCH_PROMPT, POST_MEETING_PROMPT, MONTHLY_DRAFT_PROMPT])
      expect(prompt).toContain("# 结论先行、结构化");
    // 对话（10/13 验收后）：结论先行，回答形状按问题选，不再强制加粗列点。
    for (const prompt of [SYSTEM_PROMPT]) {
      expect(prompt).toContain("# 结论先行与回答的形状");
      expect(prompt).not.toContain("# 结论先行、结构化");
    }
  });

  it("提示词不要求在回答里写「AI 建议」「（模拟）」这类标注，目标不分季度、不加括注", () => {
    expect(HUMAN_WRITING_STYLE).toContain("不在文字里标注来源性质");
    expect(HUMAN_WRITING_STYLE).toContain("候选内容仍不得说成已经发生的事实，不编造数字");
    expect(HUMAN_WRITING_STYLE).toContain("目标只分这两类");
    for (const prompt of [HUMAN_WRITING_STYLE, SYSTEM_PROMPT, PREFLIGHT_PROMPT, RESEARCH_PROMPT, RADAR_PROMPT])
      expect(prompt).not.toMatch(/必须(?:说明|写明|标)[^。]{0,16}(?:AI 建议|模拟)|后面标「（模拟）」|注明「模拟数据」/);
  });
});

describe("出处的写法（10/14）：正文直接陈述，出处是句末的小标记", () => {
  it("出处规则：不先报文件名、句末不括号重复，出处写成句末链接；同源合并、推断照常说明", async () => {
    const { SOURCE_CITATION_RULES } = await import("../src/sourceCitations.js");
    for (const text of ["不用「《X》写明」「据《X》」开头", "句末也不再括号重复资料名", "紧跟在那一句末尾、句号之前", "只在最后一句末尾放一个",
      "出处带网址的写原网址", "cite:source", "这是我的推断"]) expect(SOURCE_CITATION_RULES, text).toContain(text);
    // 旧写法的要求不再出现：不再让拿不准的出处「照常用文字写来源」，复盘条目不再「引用时写明出处」。
    for (const prompt of [SOURCE_CITATION_RULES]) {
      expect(prompt).not.toContain("照常用文字写来源");
      expect(prompt).not.toContain("引用时写明出处");
    }
    expect(findForbiddenPhrase(SOURCE_CITATION_RULES)).toBeNull();
  });

  it("共享用语规则：同一处出处只写一次，每个带称呼规则的 Agent 都带", async () => {
    const { PLAIN_TERMS_STYLE } = await import("../src/promptStyle.js");
    expect(PLAIN_TERMS_STYLE).toContain("同一处出处只写一次，不在句首报了文件名、句末又括号重复");
    for (const prompt of [SYSTEM_PROMPT, PREFLIGHT_PROMPT, RESEARCH_PROMPT, RADAR_PROMPT]) expect(prompt).toContain(PLAIN_TERMS_STYLE);
  });
});
