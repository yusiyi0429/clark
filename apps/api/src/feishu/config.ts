/** 飞书企业自建应用的配置；应用 ID、密钥、令牌密钥都不配时飞书接入关闭（路由返回 404，不起长连接）。 */
export type FeishuEnv = {
  appId: string;
  appSecret: string;
  /** 用户令牌加密密钥（AES-256-GCM，32 字节）。 */
  tokenKey: Buffer;
  /** 当前密钥版本，写进每行密文旁边；换密钥时递增。 */
  tokenKeyVersion: number;
};

/**
 * FEISHU_APP_ID、FEISHU_APP_SECRET、FEISHU_TOKEN_KEY（base64 的 32 字节）、FEISHU_TOKEN_KEY_VERSION（缺省 1）。
 * 只配了一部分时启动失败，不静默关闭。
 */
export function resolveFeishuEnv(source: Record<string, string | undefined>): FeishuEnv | undefined {
  const appId = source.FEISHU_APP_ID?.trim();
  const appSecret = source.FEISHU_APP_SECRET?.trim();
  const rawKey = source.FEISHU_TOKEN_KEY?.trim();
  if (!appId && !appSecret && !rawKey) return undefined;
  if (!appId || !appSecret || !rawKey) throw new Error("飞书配置不完整：FEISHU_APP_ID、FEISHU_APP_SECRET、FEISHU_TOKEN_KEY 必须同时配置");
  const tokenKey = Buffer.from(rawKey, "base64");
  if (tokenKey.length !== 32) throw new Error("FEISHU_TOKEN_KEY 必须是 base64 编码的 32 字节");
  const tokenKeyVersion = Number(source.FEISHU_TOKEN_KEY_VERSION ?? "1");
  if (!Number.isInteger(tokenKeyVersion) || tokenKeyVersion < 1) throw new Error("FEISHU_TOKEN_KEY_VERSION 必须是正整数");
  return { appId, appSecret, tokenKey, tokenKeyVersion };
}
