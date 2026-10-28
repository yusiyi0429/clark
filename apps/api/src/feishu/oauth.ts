import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PeopleDirectory } from "../peopleDirectory.js";
import type { Query } from "../meetingStore.js";
import { roleOf, type SessionRole } from "../memberAccess.js";
import { hasCompletedOnboarding } from "../onboarding.js";
import type { FeishuEnv } from "./config.js";
import { FeishuApiError, type FeishuClient } from "./client.js";
import { saveAuthorizedToken } from "./tokens.js";

/** 在飞书约会最少要的权限：授权里缺任何一项，算建会的人还没连好飞书（等他重新连上再约）。 */
export const FEISHU_CALENDAR_SCOPES = [
  "calendar:calendar:readonly", "calendar:calendar.event:create", "calendar:calendar.event:update", "calendar:calendar.event:delete",
];
/**
 * offline_access 才会返回 refresh token；drive:drive.metadata:readonly 用来读本人工作依据里飞书文档的标题、修订时间和修订人（不读正文）。
 * 会后自动拿妙记（meetingMinutes.ts）先用主持人、拿不到再用建会的人本人的授权：minutes:minutes:readonly 读妙记信息，minutes:minutes.basic:read 收「妙记生成」事件，
 * minutes:minutes.search:read 轮询兜底，minutes:minutes.artifacts:read 读逐字稿全文，minutes:minutes.transcript:export 退回导出，vc:meeting 读实际参会人（vc:meeting:readonly 只有应用身份，用户身份只能开 vc:meeting，10/21）；
 * 读实际参会名单还要 vc:meeting.meetingevent:read（10/21 实测 /vc/v1/meetings/:id 报缺 vc:meeting:readonly 或它）。
 * 天枢约会时自动在飞书约上（meetingFeishuEvent.ts）用建会的人本人的授权：calendar:calendar:readonly 读主日历，calendar:calendar.event:create 建日程，
 * calendar:calendar.event:update 改时间、加参与人，calendar:calendar.event:delete 取消时删日程（读主日历用 calendar:calendar:readonly：更细的 calendar:calendar.calendar:readonly 在后台开不了，10/22 授权报 20027）。
 * 其余用户权限随后续功能加进来；在开发者后台开通的清单见 .scratch/tianshu-v1/飞书开发者后台配置清单.md。
 */
export const FEISHU_OAUTH_SCOPE = [
  "offline_access", "drive:drive.metadata:readonly",
  "minutes:minutes:readonly", "minutes:minutes.basic:read", "minutes:minutes.search:read",
  "minutes:minutes.artifacts:read", "minutes:minutes.transcript:export", "vc:meeting", "vc:meeting.meetingevent:read",
  ...FEISHU_CALENDAR_SCOPES,
].join(" ");
/** 会后自动拿妙记最少要的权限：读妙记信息、按所有者搜妙记、读逐字稿全文。授权里缺任何一项，都算没连好飞书。 */
export const FEISHU_MINUTES_READ_SCOPES = ["minutes:minutes:readonly", "minutes:minutes.search:read", "minutes:minutes.artifacts:read"];
export const FEISHU_STATE_COOKIE = "feishu_oauth";
const STATE_MAX_AGE_SECONDS = 600;
const STATE_COOKIE_PATH = "/api/auth/feishu";

const sign = (secret: string, payload: string) => createHmac("sha256", `feishu-oauth:${secret}`).update(payload).digest("base64url");

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** 只接受站内相对路径，挡住 //evil.com 这类开放跳转。 */
export function safeNextPath(next: unknown): string {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") && next.length <= 2000 ? next : "/";
}

/** 已登录的人连接飞书：发起时是谁、当时的会话版本。 */
export type FeishuConnectIntent = { personId: string; sessionVersion: number };

/**
 * 发起授权：随机 state 与 next 一起签名放进 cookie（SameSite=Lax，飞书授权页跳回来的顶层 GET 会带上），
 * 回调时比对 query 里的 state。连接飞书（connect）时把发起的人一起签进去：回调那一跳不一定带得上会话 cookie。
 */
export function createOAuthState(secret: string, next: string, nowMs = Date.now(), connect?: FeishuConnectIntent): { state: string; setCookie: string } {
  const state = randomBytes(24).toString("base64url");
  const claims = { s: state, n: safeNextPath(next), exp: Math.floor(nowMs / 1000) + STATE_MAX_AGE_SECONDS, ...(connect ? { p: connect.personId, v: connect.sessionVersion } : {}) };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return {
    state,
    setCookie: `${FEISHU_STATE_COOKIE}=${payload}.${sign(secret, payload)}; Max-Age=${STATE_MAX_AGE_SECONDS}; Path=${STATE_COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax`,
  };
}

export const clearOAuthStateCookie = () => `${FEISHU_STATE_COOKIE}=; Max-Age=0; Path=${STATE_COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax`;

/** 签名、有效期、state 三项都对上才返回 next（连接飞书时还有发起的人）；任何一项不对返回 null。 */
export function verifyOAuthState(secret: string, cookieValue: string | undefined, queryState: unknown, nowMs = Date.now()):
  { next: string; connect?: FeishuConnectIntent } | null {
  if (!cookieValue || typeof queryState !== "string" || !queryState) return null;
  const [payload, sig] = cookieValue.split(".");
  if (!payload || !sig || !safeEqual(sign(secret, payload), sig)) return null;
  try {
    const { s, n, exp, p, v } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { s?: unknown; n?: unknown; exp?: unknown; p?: unknown; v?: unknown };
    if (typeof s !== "string" || typeof exp !== "number" || exp <= Math.floor(nowMs / 1000) || !safeEqual(s, queryState)) return null;
    return { next: safeNextPath(n), ...(typeof p === "string" && typeof v === "number" ? { connect: { personId: p, sessionVersion: v } } : {}) };
  } catch {
    return null;
  }
}

/**
 * 本人的飞书连好了没有（账户菜单、会议页「连接飞书」看它）：关联了飞书账号，授权有效（没标重新授权、密钥版本对得上、
 * 续期凭据没过期），并且授权里有 scopes 这几项权限（默认会后拿妙记要的；约会议看日历的传 FEISHU_CALENDAR_SCOPES）。
 */
export async function feishuConnected(q: Query, env: Pick<FeishuEnv, "tokenKeyVersion">, personId: string, now: Date,
  scopes: readonly string[] = FEISHU_MINUTES_READ_SCOPES): Promise<boolean> {
  const row = (await q(
    `SELECT t.status, t.key_version, t.scope, t.access_expires_at, t.refresh_expires_at
       FROM feishu_user_tokens t JOIN feishu_identities i ON i.person_id = t.person_id WHERE t.person_id = $1`,
    [personId],
  )).rows[0] as { status: string; key_version: number; scope: string | null; access_expires_at: Date; refresh_expires_at: Date | null } | undefined;
  if (!row || row.status !== "active" || row.key_version !== env.tokenKeyVersion) return false;
  if ((row.refresh_expires_at ?? row.access_expires_at).getTime() <= now.getTime()) return false;
  const granted = new Set((row.scope ?? "").split(/\s+/));
  return scopes.every((scope) => granted.has(scope));
}

export type FeishuLoginOutcome =
  | { kind: "ok"; personId: string; sessionVersion: number; role: SessionRole; onboarded: boolean }
  | { kind: "code_invalid" | "unavailable" | "not_linked" | "link_conflict" | "no_access"; message: string };

/** code 失效或用过属于用户可重试的问题；其余飞书错误按服务不可用处理。 */
const CODE_ERRORS = new Set([20003, 20004, 20024, 20065, 20071]);

/**
 * 两条免登路径（网页 OAuth 回调、飞书内 requestAccess）共用：code 换 token → 读 open_id →
 * 按 feishu_identities 找人。找不到时，如果浏览器里已经用 ID + 口令登录了，就把这个飞书账号关联到当前的人；
 * 否则明确告诉用户还没关联。找到人后写入加密的 user token。
 */
export async function completeFeishuLogin({
  q, env, client, peopleDirectory, code, redirectUri, sessionPersonId, connect = false, now,
}: {
  q: Query;
  env: Pick<FeishuEnv, "tokenKey" | "tokenKeyVersion">;
  client: FeishuClient;
  peopleDirectory: PeopleDirectory;
  code: string;
  redirectUri?: string;
  /** 浏览器里已有的天枢会话（没有就是 undefined）；连接飞书时是发起连接的人。 */
  sessionPersonId?: string;
  /** 已登录的人连接飞书：飞书账号已经关联了别人时拒绝，不换成那个人。 */
  connect?: boolean;
  now: Date;
}): Promise<FeishuLoginOutcome> {
  let token;
  let info;
  try {
    token = await client.exchangeCode(code, redirectUri);
    info = await client.getUserInfo(token.accessToken);
  } catch (error) {
    if (error instanceof FeishuApiError && CODE_ERRORS.has(error.code)) return { kind: "code_invalid", message: "飞书授权码已失效，请重新打开天枢" };
    console.warn(`feishu login failed: ${error instanceof FeishuApiError ? `code ${error.code}` : (error as Error).name}`);
    return { kind: "unavailable", message: "暂时连不上飞书，请稍后再试" };
  }

  let personId = (await q("SELECT person_id FROM feishu_identities WHERE open_id = $1", [info.openId])).rows[0]?.person_id as string | undefined;
  if (connect && personId && personId !== sessionPersonId) {
    return { kind: "link_conflict", message: "这个飞书账号已经关联了别的天枢账号，请换成你自己的飞书账号，或联系管理员" };
  }
  if (!personId && sessionPersonId) {
    const bound = await q(
      `INSERT INTO feishu_identities (person_id, open_id, union_id, name) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING RETURNING person_id`,
      [sessionPersonId, info.openId, info.unionId ?? null, info.name ?? null],
    );
    if (!bound.rows[0]) return { kind: "link_conflict", message: "当前天枢账号已经关联了另一个飞书账号，请联系管理员处理" };
    personId = sessionPersonId;
  }
  if (!personId) {
    return { kind: "not_linked", message: "这个飞书账号还没有关联天枢人员。请先在浏览器里用天枢 ID 和口令登录，再从飞书消息里的链接打开一次完成关联；或联系管理员。" };
  }

  const person = peopleDirectory.searchPeople(undefined).find((p) => p.personId === personId);
  const access = (await q("SELECT session_version FROM member_access WHERE person_id = $1", [personId])).rows[0] as { session_version: number } | undefined;
  if (!person || !access) return { kind: "no_access", message: "关联的天枢账号还没有开通，请联系管理员" };

  await q("UPDATE feishu_identities SET union_id = COALESCE($2, union_id), name = COALESCE($3, name), updated_at = now() WHERE person_id = $1",
    [personId, info.unionId ?? null, info.name ?? null]);
  await saveAuthorizedToken(q, env, personId, token, now);
  return { kind: "ok", personId, sessionVersion: access.session_version, role: roleOf(person), onboarded: await hasCompletedOnboarding(q, personId) };
}
