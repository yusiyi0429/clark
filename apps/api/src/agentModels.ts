/**
 * 对话以外各候选 Agent 的模型与思考强度配置（10/13 迁移：这些 Agent 也能用 Claude 和 gpt-6.1-sol）。
 *
 * 每个 Agent 一对环境变量，都可不配；不配时与之前完全一样：
 * | Agent | 模型 | 思考 | 不配时 |
 * |---|---|---|---|
 * | 会前预审 | PREFLIGHT_MODEL | PREFLIGHT_THINKING | HEAVY_MODEL · high（已有，写法见 preflightAgent.ts） |
 * | 后台预研 | RESEARCH_MODEL | RESEARCH_THINKING | HEAVY_MODEL · 不开思考 |
 * | 会后提取 | OUTCOME_MODEL | OUTCOME_THINKING | HEAVY_MODEL · 不开思考 |
 * | 公司雷达研判 | RADAR_MODEL | RADAR_THINKING | LIGHT_MODEL · 不开思考 |
 * | 个人雷达判定 | PERSONAL_RADAR_MODEL | PERSONAL_RADAR_THINKING | 公司雷达的配置，再不配就是 LIGHT_MODEL · 不开思考 |
 * | 记忆导入分类与去重 | MEMORY_IMPORT_MODEL | MEMORY_IMPORT_THINKING | LIGHT_MODEL · 不开思考 |
 * | 战场进展汇总 | PROGRESS_SUMMARY_MODEL | PROGRESS_SUMMARY_THINKING | HEAVY_MODEL · medium |
 * | 会后事项归位 | TASK_PLACEMENT_MODEL | TASK_PLACEMENT_THINKING | LIGHT_MODEL · 不开思考 |
 *
 * 协议与地址按模型 id 推断（conversationModel.ts）：claude-* 走 Anthropic 协议（根地址 + /anthropic），gpt-6.1-* 走根地址 + /openai，
 * 其余走 PI_BASE_URL。思考强度 off / minimal / low / medium / high / xhigh；Claude 的 off 按 effort low 发（Sonnet / Opus 5.5 不能关思考）。
 * 新加的思考变量写错直接报错，免得配置看起来生效、实际没生效。
 */
import type { CandidateThinkingLevel } from "./candidateAgentRuntime.js";

export type AgentModelKey = "research" | "outcome" | "radar" | "personalRadar" | "memoryImport" | "progressSummary" | "taskPlacement";

export const AGENT_MODEL_ENV: Readonly<Record<AgentModelKey, { model: string; thinking: string }>> = {
  research: { model: "RESEARCH_MODEL", thinking: "RESEARCH_THINKING" },
  outcome: { model: "OUTCOME_MODEL", thinking: "OUTCOME_THINKING" },
  radar: { model: "RADAR_MODEL", thinking: "RADAR_THINKING" },
  personalRadar: { model: "PERSONAL_RADAR_MODEL", thinking: "PERSONAL_RADAR_THINKING" },
  memoryImport: { model: "MEMORY_IMPORT_MODEL", thinking: "MEMORY_IMPORT_THINKING" },
  progressSummary: { model: "PROGRESS_SUMMARY_MODEL", thinking: "PROGRESS_SUMMARY_THINKING" },
  taskPlacement: { model: "TASK_PLACEMENT_MODEL", thinking: "TASK_PLACEMENT_THINKING" },
};

const THINKING_LEVELS: readonly CandidateThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export type AgentModelEnv = Partial<Record<AgentModelKey, { model?: string; thinking?: string }>>;
export type AgentModelChoice = { modelId: string; thinkingLevel: CandidateThinkingLevel };

/** 从环境变量读出各 Agent 的配置（只取非空值）。 */
export function agentModelEnvFrom(source: Record<string, string | undefined>): AgentModelEnv {
  const result: AgentModelEnv = {};
  for (const [key, names] of Object.entries(AGENT_MODEL_ENV) as [AgentModelKey, { model: string; thinking: string }][]) {
    const model = source[names.model]?.trim() || undefined;
    const thinking = source[names.thinking]?.trim() || undefined;
    if (model || thinking) result[key] = { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
  }
  return result;
}

/** 某个 Agent 用哪个模型、什么思考强度；没配的项用 fallback。个人雷达没配时跟公司雷达。 */
export function agentModel(env: AgentModelEnv | undefined, key: AgentModelKey,
  fallback: { modelId: string; thinkingLevel?: CandidateThinkingLevel }): AgentModelChoice {
  const own = env?.[key];
  const inherited = key === "personalRadar" && !own ? env?.radar : undefined;
  const setting = own ?? inherited;
  const name = AGENT_MODEL_ENV[own || !inherited ? key : "radar"].thinking;
  const thinking = setting?.thinking?.trim().toLowerCase();
  if (thinking && !THINKING_LEVELS.includes(thinking as CandidateThinkingLevel)) {
    throw new Error(`${name} 只能是 ${THINKING_LEVELS.join(" / ")}；无法识别「${setting?.thinking}」`);
  }
  return {
    modelId: setting?.model?.trim() || fallback.modelId,
    thinkingLevel: (thinking as CandidateThinkingLevel | undefined) ?? fallback.thinkingLevel ?? "off",
  };
}
