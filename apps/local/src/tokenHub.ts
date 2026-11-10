import { LOCAL_TOKENHUB_PROFILE_PREFIX } from "@warmap/contracts";
import type { ModelProfiles } from "./models.js";

/**
 * 连接页连 TokenHub（设计 17.2 第 51 条，契约 POST/DELETE /v1/tokenhub）：拿本人填的 Key 列这把 Key 能用的模型，
 * 认了就存 Key、每个模型建一条 th- 开头的网关模型配置。Key 不进日志、不回传、不出现在错误里。
 */
export const DEFAULT_TOKENHUB_URL = "https://tokenhub.corp.tokenkingos.com/api/anthropic";
/**
 * 经 TokenHub 的 Anthropic 入口实测能给 Claude Code 用的（11/06 实测 Opus、DeepSeek；Sonnet 是 M2 一直在用的）。只建这几个里这把 Key 的账户列得出来的：
 * 选模型时不能有点了就失败的（11/10 定）。要用更多模型另走「添加来源」。
 */
export const TOKENHUB_MODELS = ["wangsu/claude-opus-5-5", "wangsu/claude-sonnet-5-5", "wangsu/deepseek-v4.1-flash"];
/** Claude Code 没登录（订阅用不了）时连上 TokenHub，设成默认的那个。 */
const FALLBACK_DEFAULT = "wangsu/claude-opus-5-5";

export const tokenHubProfileId = (model: string) => `${LOCAL_TOKENHUB_PROFILE_PREFIX}${model.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 80);
export const isTokenHubProfileId = (id: string) => id.startsWith(LOCAL_TOKENHUB_PROFILE_PREFIX);

export class TokenHubError extends Error {
  constructor(readonly code: "tokenhub_key_rejected" | "tokenhub_unreachable" | "tokenhub_no_models", message: string) { super(message); }
}

const unreachable = () => new TokenHubError("tokenhub_unreachable", "连不上 TokenHub");

/** 这把 Key 能用的模型（TokenHub 的 GET /api/openai/v1/models，tokavi-tokenhub main 的 list_models）。 */
export async function listTokenHubModels(baseUrl: string, apiKey: string, fetchImpl: typeof fetch): Promise<string[]> {
  let res: Response;
  try {
    res = await fetchImpl(new URL("/api/openai/v1/models", new URL(baseUrl).origin), { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
  } catch { throw unreachable(); }
  if (res.status === 401 || res.status === 403) throw new TokenHubError("tokenhub_key_rejected", "Key 不对");
  if (!res.ok) throw unreachable();
  const body = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
  if (!Array.isArray(body?.data)) throw unreachable();
  const ids = body.data.map((m) => m?.id).filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 120);
  return [...new Set(ids)];
}

export class TokenHub {
  constructor(
    private readonly models: ModelProfiles, private readonly baseUrl: string, private readonly fetchImpl: typeof fetch,
    /** 这台电脑的 Claude 订阅能不能用（Claude Code 装了、登录着）。 */
    private readonly subscriptionUsable: () => Promise<boolean>,
  ) {}

  async connect(apiKey: string): Promise<void> {
    const listed = new Set(await listTokenHubModels(this.baseUrl, apiKey, this.fetchImpl));
    const usable = TOKENHUB_MODELS.filter((model) => listed.has(model));
    if (!usable.length) throw new TokenHubError("tokenhub_no_models", "这个 Key 没有能用的模型");
    // 订阅用不了时默认档一跑就失败：本人没另设默认的话，把 TokenHub 的 Opus 设成默认（没有 Opus 就用第一个）
    const fallback = (await this.subscriptionUsable().catch(() => false)) ? null : usable.includes(FALLBACK_DEFAULT) ? FALLBACK_DEFAULT : usable[0]!;
    await this.models.setTokenHub(this.baseUrl, apiKey, usable, fallback);
  }

  disconnect(): Promise<void> { return this.models.removeTokenHub(); }
}
