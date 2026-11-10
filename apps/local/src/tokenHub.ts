import { LOCAL_TOKENHUB_PROFILE_PREFIX } from "@warmap/contracts";
import type { ModelProfiles } from "./models.js";

/**
 * 连接页连 TokenHub（设计 17.2 第 51 条，契约 POST/DELETE /v1/tokenhub）：拿本人填的 Key 列这把 Key 能用的模型，
 * 认了就存 Key、每个模型建一条 th- 开头的网关模型配置。Key 不进日志、不回传、不出现在错误里。
 */
export const DEFAULT_TOKENHUB_URL = "https://tokenhub.corp.tokenkingos.com/api/anthropic";
/** TokenHub 列出来是空的时建的（11/06 经它的 Anthropic 入口实测过 Opus、DeepSeek；Sonnet 是 M2 在用的）。 */
export const DEFAULT_TOKENHUB_MODELS = ["wangsu/claude-opus-5-5", "wangsu/claude-sonnet-5-5", "wangsu/deepseek-v4.1-flash"];

export const tokenHubProfileId = (model: string) => `${LOCAL_TOKENHUB_PROFILE_PREFIX}${model.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 80);
export const isTokenHubProfileId = (id: string) => id.startsWith(LOCAL_TOKENHUB_PROFILE_PREFIX);

export class TokenHubError extends Error {
  constructor(readonly code: "tokenhub_key_rejected" | "tokenhub_unreachable", message: string) { super(message); }
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
  constructor(private readonly models: ModelProfiles, private readonly baseUrl: string, private readonly fetchImpl: typeof fetch) {}

  async connect(apiKey: string): Promise<void> {
    const listed = await listTokenHubModels(this.baseUrl, apiKey, this.fetchImpl);
    await this.models.setTokenHub(this.baseUrl, apiKey, listed.length ? listed : DEFAULT_TOKENHUB_MODELS);
  }

  disconnect(): Promise<void> { return this.models.removeTokenHub(); }
}
