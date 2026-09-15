import { createHmac, timingSafeEqual } from "node:crypto";

export type ActionScope = {
  actionType: string;
  objectType: string;
  objectId: string;
  objectVersion: number;
  itemId?: string;
};

function hmac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

/**
 * 确定性 actionId：相同 scope 得到相同 token，不使用随机 nonce。
 * Web 不解析；API 验签后还原 scope。
 */
export function signActionId(secret: string, scope: ActionScope): string {
  const payload = Buffer.from(
    JSON.stringify([scope.actionType, scope.objectType, scope.objectId, scope.objectVersion, scope.itemId ?? ""]),
  ).toString("base64url");
  return `${payload}.${hmac(secret, payload)}`;
}

export function verifyActionId(secret: string, token: string): ActionScope | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = hmac(secret, payload);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const [actionType, objectType, objectId, objectVersion, itemId] = JSON.parse(
      Buffer.from(payload, "base64url").toString(),
    ) as [string, string, string, number, string];
    if (!actionType || !objectType || !objectId || !Number.isInteger(objectVersion)) return null;
    return { actionType, objectType, objectId, objectVersion, itemId: itemId || undefined };
  } catch {
    return null;
  }
}

/** 稳定 JSON 序列化：键排序，fingerprint 输入规范化。 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([k1], [k2]) => (k1 < k2 ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** action fingerprint = HMAC(actionId + 规范化 input)；multipart 时文件以 SHA-256 参与 input。 */
export function actionFingerprint(secret: string, actionId: string, input: unknown): string {
  return hmac(secret, `${actionId}\n${canonicalJson(input ?? {})}`);
}
