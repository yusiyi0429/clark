import type { FeishuUserToken } from "./tokens.js";

const ACCOUNTS = "https://accounts.feishu.cn";
const OPEN_API = "https://open.feishu.cn/open-apis";
const TIMEOUT_MS = 10_000;

/** 飞书接口返回的业务错误（code 非 0）。code 为 0 表示是网络或格式问题。 */
export class FeishuApiError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "FeishuApiError";
  }
}

export type FeishuUserInfo = { openId: string; unionId?: string; name?: string };
export type FeishuReceiveIdType = "open_id" | "union_id" | "user_id" | "chat_id";

/** 用到的飞书开放接口；测试注入假实现。 */
export type FeishuClient = {
  /** 用户授权页跳到的 OAuth 地址（网页内 OAuth）。 */
  authorizeUrl(redirectUri: string, state: string, scope: string): string;
  /** code 换 user token（v3）；网页 OAuth 带 redirectUri，飞书内 requestAccess 的 code 不带。 */
  exchangeCode(code: string, redirectUri?: string): Promise<FeishuUserToken>;
  /** refresh token 只能用一次；成功后旧的立即失效。 */
  refreshUserToken(refreshToken: string): Promise<FeishuUserToken>;
  getUserInfo(userAccessToken: string): Promise<FeishuUserInfo>;
  /** 以机器人身份发消息（tenant_access_token）。content 是消息体对象，发送时序列化。 */
  sendMessage(receiveIdType: FeishuReceiveIdType, receiveId: string, msgType: "text" | "interactive", content: object): Promise<{ messageId: string }>;
};

type Fetch = typeof fetch;

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new FeishuApiError(0, `飞书接口返回了非 JSON 响应（HTTP ${response.status}）`);
  }
}

function userToken(body: Record<string, unknown>): FeishuUserToken {
  const code = Number(body.code ?? 0);
  if (code !== 0 || typeof body.access_token !== "string") {
    throw new FeishuApiError(code, String(body.error_description ?? body.error ?? body.msg ?? "飞书 token 接口失败"));
  }
  return {
    accessToken: body.access_token,
    expiresIn: Number(body.expires_in),
    ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token, refreshExpiresIn: Number(body.refresh_token_expires_in) } : {}),
    scope: typeof body.scope === "string" ? body.scope : "",
  };
}

function data(body: Record<string, unknown>, what: string): Record<string, unknown> {
  const code = Number(body.code ?? -1);
  if (code !== 0) throw new FeishuApiError(code, `${what}失败：${String(body.msg ?? "未知错误")}`);
  return (body.data ?? {}) as Record<string, unknown>;
}

export function createFeishuClient({ appId, appSecret, fetch: fetchImpl = fetch }: {
  appId: string;
  appSecret: string;
  fetch?: Fetch;
}): FeishuClient {
  let tenant: { token: string; expiresAt: number } | undefined;

  async function tokenRequest(fields: Record<string, string>): Promise<FeishuUserToken> {
    const response = await fetchImpl(`${ACCOUNTS}/oauth/v3/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: appId, client_secret: appSecret, ...fields }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return userToken(await readJson(response));
  }

  /** tenant_access_token 有效 2 小时，提前 5 分钟换新。 */
  async function tenantToken(): Promise<string> {
    if (tenant && tenant.expiresAt > Date.now()) return tenant.token;
    const response = await fetchImpl(`${OPEN_API}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await readJson(response);
    if (Number(body.code ?? -1) !== 0 || typeof body.tenant_access_token !== "string") {
      throw new FeishuApiError(Number(body.code ?? 0), `获取 tenant_access_token 失败：${String(body.msg ?? "未知错误")}`);
    }
    tenant = { token: body.tenant_access_token, expiresAt: Date.now() + (Number(body.expire ?? 7200) - 300) * 1000 };
    return tenant.token;
  }

  return {
    authorizeUrl(redirectUri, state, scope) {
      const query = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, response_type: "code", scope, state });
      return `${ACCOUNTS}/open-apis/authen/v1/authorize?${query.toString()}`;
    },
    exchangeCode(code, redirectUri) {
      return tokenRequest({ grant_type: "authorization_code", code, ...(redirectUri ? { redirect_uri: redirectUri } : {}) });
    },
    refreshUserToken(refreshToken) {
      return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
    },
    async getUserInfo(userAccessToken) {
      const response = await fetchImpl(`${OPEN_API}/authen/v1/user_info`, {
        headers: { authorization: `Bearer ${userAccessToken}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const info = data(await readJson(response), "读取飞书用户信息");
      if (typeof info.open_id !== "string") throw new FeishuApiError(0, "飞书用户信息里没有 open_id");
      return {
        openId: info.open_id,
        ...(typeof info.union_id === "string" ? { unionId: info.union_id } : {}),
        ...(typeof info.name === "string" ? { name: info.name } : {}),
      };
    },
    async sendMessage(receiveIdType, receiveId, msgType, content) {
      const response = await fetchImpl(`${OPEN_API}/im/v1/messages?receive_id_type=${receiveIdType}`, {
        method: "POST",
        headers: { authorization: `Bearer ${await tenantToken()}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ receive_id: receiveId, msg_type: msgType, content: JSON.stringify(content) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const sent = data(await readJson(response), "发送飞书消息");
      return { messageId: String(sent.message_id ?? "") };
    },
  };
}
