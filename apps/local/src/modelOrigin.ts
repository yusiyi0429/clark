import type { TLocalModelOrigin } from "@warmap/contracts";

/**
 * 模型配置真正的来源（契约 LocalModelOrigin）：按地址和模型名认，不联网。
 * - 订阅：本人的 Claude 订阅；Codex 的是本人的 Codex 订阅。
 * - 本机 magpie（127.0.0.1:3425，github.com/yetone/magpie）：模型名写「来源/模型」，按前缀认（codex/… 是 Codex 订阅）。
 * - 别的地址按域名对上预设名单（TokenHub、DeepSeek、Kimi、GLM、Qwen、火山方舟等），对不上写主机名。
 */
export const MAGPIE_PORT = "3425";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function urlOf(baseUrl: string | null): URL | null {
  try { return baseUrl ? new URL(baseUrl) : null; } catch { return null; }
}
export const isLoopback = (baseUrl: string | null) => LOOPBACK.has(urlOf(baseUrl)?.hostname ?? "");
export const isMagpie = (baseUrl: string | null) => isLoopback(baseUrl) && urlOf(baseUrl)?.port === MAGPIE_PORT;

/** 按域名认的厂商（主机名是它或它的子域名）。 */
const VENDORS: { hosts: RegExp; provider: string; label: string }[] = [
  { hosts: /(^|\.)(tokenhub|tokavi)([.-]|$)/, provider: "tokenhub", label: "TokenHub" },
  { hosts: /(^|\.)deepseek\.com$/, provider: "deepseek", label: "DeepSeek API" },
  { hosts: /(^|\.)moonshot\.(cn|ai)$/, provider: "kimi", label: "Kimi API" },
  { hosts: /(^|\.)(bigmodel\.cn|z\.ai)$/, provider: "glm", label: "GLM API" },
  { hosts: /(^|\.)dashscope(-intl)?\.aliyuncs\.com$/, provider: "qwen", label: "Qwen API" },
  { hosts: /(^|\.)volces\.com$/, provider: "volcengine", label: "火山方舟 API" },
  { hosts: /(^|\.)minimaxi?\.(com|io|chat)$/, provider: "minimax", label: "MiniMax API" },
  { hosts: /(^|\.)anthropic\.com$/, provider: "anthropic", label: "Anthropic API" },
  { hosts: /(^|\.)openrouter\.ai$/, provider: "openrouter", label: "OpenRouter" },
];
const VENDOR_IDS = new Set(VENDORS.map((v) => v.provider));

/** magpie 模型名的前缀（小写）→ 来源。订阅类的写「X 订阅」，API 类的同上面的厂商名。 */
const MAGPIE_PREFIX: Record<string, { provider: string; label: string }> = {
  claude: { provider: "claude", label: "Claude 订阅" },
  codex: { provider: "codex", label: "Codex 订阅" },
  chatgpt: { provider: "codex", label: "ChatGPT 订阅" },
  copilot: { provider: "copilot", label: "Copilot 订阅" },
  gemini: { provider: "gemini", label: "Gemini" },
  deepseek: { provider: "deepseek", label: "DeepSeek API" },
  kimi: { provider: "kimi", label: "Kimi API" },
  moonshot: { provider: "kimi", label: "Kimi API" },
  glm: { provider: "glm", label: "GLM API" },
  zhipu: { provider: "glm", label: "GLM API" },
  qwen: { provider: "qwen", label: "Qwen API" },
  dashscope: { provider: "qwen", label: "Qwen API" },
  volcengine: { provider: "volcengine", label: "火山方舟 API" },
  ark: { provider: "volcengine", label: "火山方舟 API" },
  doubao: { provider: "volcengine", label: "火山方舟 API" },
  minimax: { provider: "minimax", label: "MiniMax API" },
  openrouter: { provider: "openrouter", label: "OpenRouter" },
};

export function modelOrigin(p: { source: "subscription" | "gateway"; baseUrl: string | null; model: string | null; agent?: string }): TLocalModelOrigin {
  if (p.source === "subscription" && p.agent === "codex") return { provider: "codex", label: "Codex 订阅", via: null };
  if (p.source === "subscription") return { provider: "claude-subscription", label: "Claude 订阅", via: null };
  const url = urlOf(p.baseUrl);
  if (isMagpie(p.baseUrl)) {
    const slash = (p.model ?? "").indexOf("/");
    const prefix = slash > 0 ? p.model!.slice(0, slash).toLowerCase().slice(0, 60) : "";
    if (!prefix) return { provider: "magpie", label: "magpie", via: "magpie" };
    const known = MAGPIE_PREFIX[prefix];
    return { provider: known?.provider ?? prefix, label: `${known?.label ?? prefix} · 经 magpie`, via: "magpie" };
  }
  const host = url?.host.toLowerCase() ?? "";
  const vendor = VENDORS.find((v) => v.hosts.test(url?.hostname.toLowerCase() ?? ""));
  if (vendor) return { provider: vendor.provider, label: vendor.label, via: null };
  return { provider: (host || "gateway").slice(0, 100), label: (host || "自定义地址").slice(0, 120), via: null };
}

/** 读 TokenHub 当天花费的只有 TokenHub（和认不出的地址，照旧当成 TokenHub 试一下）：经 magpie 的、认得出的厂商不去读。 */
export function readsTokenHubSpend(o: TLocalModelOrigin): boolean {
  return o.via === null && o.provider !== "claude-subscription" && (o.provider === "tokenhub" || !VENDOR_IDS.has(o.provider));
}
