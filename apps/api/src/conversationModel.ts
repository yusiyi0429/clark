/**
 * 对话主答模型的协议与思考参数（10/13 重新探测网宿网关后加的选项，默认行为不变）。
 *
 * 网宿网关根地址 https://api.edgecloudapp.com/v2/llm 下有三条路（10/13 实测）：
 * - `/responses`：现有 PI_BASE_URL，GPT-5.6 三档与 gpt-6-luna 可用，gpt-6.1-sol 在这里 404；
 * - `/openai/responses`：gpt-6.1-sol 与 gpt-5.6-sol 都可用；
 * - `/anthropic/v1/messages`：Claude 5.5 三档（Anthropic 协议，x-api-key 鉴权），思考强度 output_config.effort 能透传。
 * Claude 不支持 Responses，所以 claude-* 默认走 Anthropic 协议，地址由 PI_BASE_URL 推出根地址再接 `/anthropic`
 * （Anthropic SDK 自己补 `/v1/messages`）；gpt-6.1-* 自动接根地址 + `/openai`。CONVERSATION_BASE_URL 可显式覆盖。
 * 会前预审、预研、会后提取、战场判断、雷达这些候选 Agent 也用这里的协议与地址推断（candidateAgentRuntime.ts）。
 */
import type { ConversationTier, TierThinkingLevel } from "./conversationRouting.js";

export type ConversationModelApi = "openai-responses" | "anthropic-messages";

const API_VALUES: readonly ConversationModelApi[] = ["openai-responses", "anthropic-messages"];
const THINKING_VALUES: readonly TierThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"];
const TIERS: readonly ConversationTier[] = ["quick", "grounded", "deep"];

/** 未显式指定协议时按模型 id 推断：claude-* 走 Anthropic 协议，其余走 Responses。 */
export function conversationModelApi(modelId: string, api?: string): ConversationModelApi {
  if (api) {
    if (!API_VALUES.includes(api as ConversationModelApi)) throw new Error(`CONVERSATION_API 只能是 ${API_VALUES.join(" / ")}`);
    return api as ConversationModelApi;
  }
  return /^claude-/i.test(modelId) ? "anthropic-messages" : "openai-responses";
}

/** 从任一协议的地址推出网关根地址（去掉末尾的 /responses、/openai、/anthropic、/v1/messages）。 */
export function gatewayRoot(baseUrl: string): string {
  let url = baseUrl.replace(/\/+$/, "");
  for (const suffix of [/\/responses$/, /\/v1\/messages$/, /\/messages$/, /\/v1$/, /\/openai$/, /\/anthropic$/]) url = url.replace(suffix, "");
  return url;
}

/** 只在 `/openai/responses` 上开通的模型（10/13 实测 gpt-6.1-sol 在现有 `/responses` 返回 404 model_not_found）。 */
const OPENAI_PATH_MODELS = /^gpt-6\.1/i;

/**
 * Responses 协议的地址：一般就是 PI_BASE_URL（去掉末尾 /responses）；只在 `/openai` 路径上开通的模型改接「根地址 + /openai」。
 * 已经写成 `/openai` 的地址原样用。
 */
export function responsesBaseUrl(modelId: string, baseUrl: string): string {
  const url = baseUrl.replace(/\/+$/, "").replace(/\/responses$/, "");
  return OPENAI_PATH_MODELS.test(modelId) && !/\/openai$/.test(url) ? `${gatewayRoot(url)}/openai` : url;
}

/**
 * 每档思考强度的覆盖，格式「quick=low,grounded=medium,deep=high」；没写的档位沿用 TIER_SETTINGS。
 * 写错的项直接报错，免得配置看起来生效、实际没生效。
 */
export function parseTierThinking(value: string | undefined): Partial<Record<ConversationTier, TierThinkingLevel>> {
  const result: Partial<Record<ConversationTier, TierThinkingLevel>> = {};
  if (!value?.trim()) return result;
  for (const part of value.split(/[,，;；\s]+/).filter(Boolean)) {
    const [tier, level] = part.split(/[=:：]/).map((item) => item.trim());
    if (!TIERS.includes(tier as ConversationTier) || !THINKING_VALUES.includes(level as TierThinkingLevel)) {
      throw new Error(`CONVERSATION_THINKING 写法是「quick=low,grounded=medium,deep=high」，档位 ${TIERS.join(" / ")}，强度 ${THINKING_VALUES.join(" / ")}；无法识别「${part}」`);
    }
    result[tier as ConversationTier] = level as TierThinkingLevel;
  }
  return result;
}

/**
 * 每档用哪个主答模型。CONVERSATION_MODEL 的三种写法：
 * - 不配：三档都用 HEAVY_MODEL（与分档之前一致，不额外调用其他模型）；
 * - 一个模型 id（如 gpt-5.6-sol）：三档都用它，与 10/13 之前一致；
 * - 按档位写（如 quick=gpt-5.6-sol,grounded=claude-sonnet-5-5,deep=claude-opus-5-5）：没写的档位用 HEAVY_MODEL。
 */
export function conversationTierModels(input: { defaultModel: string; conversationModel?: string }): Record<ConversationTier, string> {
  const value = input.conversationModel?.trim();
  if (value && !/[=:：]/.test(value)) return { quick: value, grounded: value, deep: value };
  const plan: Record<ConversationTier, string> = { quick: input.defaultModel, grounded: input.defaultModel, deep: input.defaultModel };
  if (!value) return plan;
  for (const part of value.split(/[,，;；\s]+/).filter(Boolean)) {
    const [tier, modelId] = part.split(/[=:：]/).map((item) => item.trim());
    if (!TIERS.includes(tier as ConversationTier) || !modelId) {
      throw new Error(`CONVERSATION_MODEL 按档位的写法是「quick=gpt-5.6-sol,grounded=claude-sonnet-5-5,deep=claude-opus-5-5」；无法识别「${part}」`);
    }
    plan[tier as ConversationTier] = modelId;
  }
  return plan;
}

export type ConversationModelDefinition = {
  id: string;
  name: string;
  api: ConversationModelApi;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat?: Record<string, unknown>;
};

/**
 * 主答模型在 pi 里的注册信息。
 * - Claude 5.5（Anthropic 协议）：自适应思考，只用 effort 控制深度。Sonnet / Opus 5.5 官方不接受关思考，
 *   所以「off」不注册（pi 会把 off 抬到 minimal，映射成 effort low）；不发 temperature；不开逐消息 effort 的 beta。
 *   max_tokens 含思考，放到 32k，免得 high 档思考把正文挤掉。
 * - gpt-6.x（Responses）：不支持 effort none（10/13 实测 400），off 映射成 low。
 * - 其余（gpt-5.6 等）：与原来一致。
 */
export function conversationModelDefinition(input: { modelId: string; api?: string; baseUrl: string; overrideBaseUrl?: string }): ConversationModelDefinition {
  const api = conversationModelApi(input.modelId, input.api);
  const base = { id: input.modelId, name: input.modelId, api, reasoning: true, input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000 };
  if (api === "anthropic-messages") {
    return {
      ...base,
      baseUrl: (input.overrideBaseUrl ?? `${gatewayRoot(input.baseUrl)}/anthropic`).replace(/\/+$/, "").replace(/\/v1\/messages$/, ""),
      maxTokens: 32_000,
      // 实际上限 100 万；声明 40 万。pi 的自动压缩已关掉（压缩只在后台做），历史太长的兜底按 HARD_HISTORY_TOKENS 判断（conversationCompaction.ts）。
      contextWindow: 400_000,
      thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh", max: "max" },
      compat: { forceAdaptiveThinking: true, supportsTemperature: false, supportsMidConvoEffort: false },
    };
  }
  return {
    ...base,
    baseUrl: input.overrideBaseUrl ? input.overrideBaseUrl.replace(/\/+$/, "").replace(/\/responses$/, "") : responsesBaseUrl(input.modelId, input.baseUrl),
    maxTokens: 16_384,
    ...(/^gpt-6/i.test(input.modelId) ? { thinkingLevelMap: { off: "low", minimal: "low" } } : {}),
  };
}
