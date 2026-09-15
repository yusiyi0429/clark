import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * DRI 的身份 cookie。和 `src/lib/access.ts` 那把共享口令是两件事：
 * 口令回答「你能不能进这个演示环境」，这个回答「你是谁」。
 *
 * 共用 `TKOS_ACCESS_SECRET` 是有意的 —— 不为六个内部人多加一个环境变量。
 * 代价写在 spec §4.1：撤销一条链接只能轮换这个密钥，而那会同时把一号位的
 * 访问 cookie 一起踢掉。等外部人（陪跑、灯塔）要进来必须换成带 kid 的签名
 * 加一份吊销名单，那时候要动的只有这个文件。
 */
export const WHO_COOKIE_NAME = "tkos_who";

/** 30 天。一个月一次的 OM 周期，比这短就等于每期都要重发链接。 */
export const WHO_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/** personId 会被拼进 URL 和 cookie，也会被拿去查对象库 —— 只放 id 里真实存在的字符。 */
const ID_SHAPE = /^[A-Za-z0-9_-]+$/;

function configuredSecret(): string | null {
  return process.env.TKOS_ACCESS_SECRET?.trim() || null;
}

function sameText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * 签一条。**token 自己带着 personId**（`PSN-06.<mac>`）—— 因为收件那一侧要从
 * cookie 里知道是谁，而不是拿一份名册去逐个试签名。
 */
export function signPersonId(personId: string): string | null {
  const secret = configuredSecret();
  if (!secret) return null;

  const id = personId.trim();
  if (!ID_SHAPE.test(id)) return null;

  const mac = createHmac("sha256", secret).update(`tkos-who-v1:${id}`).digest("base64url");
  return `${id}.${mac}`;
}

/** 验一条。解出 personId 或 null。**任何失败都是 null，不抛** —— 它跑在 proxy 里。 */
export function personIdFromToken(token: string | undefined): string | null {
  if (!token) return null;

  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const id = token.slice(0, dot);
  const expected = signPersonId(id);
  return expected && sameText(token, expected) ? id : null;
}
