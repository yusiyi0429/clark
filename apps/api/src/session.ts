import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "warmap_session";

/** 会话存人员、凭据版本和当前视角；视角每次按 seed 身份校验，版本变化后旧会话失效。 */
export type SessionClaims = { pid: string; v: number; view?: "ceo" | "member" };

function hmac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** 随机盐 scrypt 散列，格式 `scrypt:salt:hash`。 */
export function hashSecret(secret: string): string {
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${scryptSync(secret, salt, 32).toString("hex")}`;
}

/** 校验 `scrypt:salt:hash`，constant-time 比较。 */
export function verifySecret(stored: string, secret: string): boolean {
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  return safeEqual(scryptSync(secret, salt, 32).toString("hex"), hash);
}

export function createSessionToken(secret: string, maxAgeSeconds: number, claims: SessionClaims): string {
  const payload = Buffer.from(
    JSON.stringify({ pid: claims.pid, v: claims.v, view: claims.view, exp: Math.floor(Date.now() / 1000) + maxAgeSeconds }),
  ).toString("base64url");
  return `${payload}.${hmac(secret, payload)}`;
}

/** 签名、有效期与字段齐全才返回；旧格式（只有 exp）一律视为未登录。 */
export function readSessionToken(secret: string, token: string | undefined): SessionClaims | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !safeEqual(hmac(secret, payload), sig)) return null;
  try {
    const { pid, v, view, exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
    if (typeof pid !== "string" || !pid || !Number.isInteger(v) || typeof exp !== "number" || (view !== undefined && view !== "ceo" && view !== "member")) return null;
    return exp > Math.floor(Date.now() / 1000) ? { pid, v: v as number, ...(view ? { view } : {}) } : null;
  } catch {
    return null;
  }
}

export function sessionSetCookie(secret: string, maxAgeSeconds: number, claims: SessionClaims): string {
  // Secure：浏览器把 localhost/127.0.0.1 视为安全上下文，本地 http 调试也能写入；线上由 Nginx 终止 TLS。
  // Lax：从飞书消息等外部链接打开也带得上会话（Strict 会让每次外链打开都回锁屏）；跨站写请求仍不带。
  return `${SESSION_COOKIE}=${createSessionToken(secret, maxAgeSeconds, claims)}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function sessionClearCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const idx = part.indexOf("=");
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}
