import { createHash } from "node:crypto";
import type { QueryResult } from "pg";
import { PreflightCandidate } from "@warmap/contracts";
import { runCandidateAgent } from "./candidateAgentRuntime.js";
import type { PreflightAgent, PreflightAgentInput } from "./meetings.js";

/** 会前预审场景 Prompt：只用注入的 Issue／ResearchDoc／CompanyMemory 段落，输出严格 candidate。 */
export const PREFLIGHT_PROMPT = [
  "你是 CEO WarMap 的会前预审 Agent，只负责装配候选材料，不替 CEO 做决定。",
  "输入包含 meeting、关联 issues（含 ResearchDoc）和 CompanyMemory 相关段落。",
  "输出必须调用 submit_candidate，包含 entries、basis 和 brief。",
  "entries 的 kind 只能是 agenda、evidence、open_question；每项都必须给出非空 sourceRefs。",
  "sourceRefs 只能使用：'issue:<issueId>'、存在 ResearchDoc 时的 'research:<issueId>'、以及 'memory:<sectionId>'。",
  "不得虚构来源、不得输出散文决策、不得声称已经确认或分派任何事项。",
].join("\n");

export function createPreflightAgent(options: {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
  baseUrl: string;
  apiKey: string;
  modelId: string;
}): PreflightAgent {
  return {
    modelSlot: "light",
    promptHash: createHash("sha256").update(PREFLIGHT_PROMPT).digest("hex"),
    async generate(input: PreflightAgentInput, signal?: AbortSignal) {
      const result = await runCandidateAgent({
        query: options.query,
        kind: "meeting_preflight",
        input,
        prompt: PREFLIGHT_PROMPT,
        schema: PreflightCandidate,
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        modelId: options.modelId,
        modelSlot: "light",
        signal,
      });
      return { candidate: result.candidate, runId: result.runId };
    },
  };
}
