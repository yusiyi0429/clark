import type { FastifyReply, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import { FeishuAuthConfigResponse, FeishuCodeLoginRequest, FeishuConnectionResponse, LoginResponse } from "@warmap/contracts";
import { parseCookies, sessionSetCookie } from "../session.js";
import type { FeishuClient } from "../feishu/client.js";
import {
  FEISHU_OAUTH_SCOPE, FEISHU_STATE_COOKIE, clearOAuthStateCookie, completeFeishuLogin, createOAuthState, feishuConnected, safeNextPath, verifyOAuthState,
  type FeishuConnectIntent, type FeishuLoginOutcome,
} from "../feishu/oauth.js";
import { isAllowedOrigin, type AppInstance, type RouteContext } from "./shared.js";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** 回调落地页：会话 cookie 是 SameSite=Strict，从飞书跳回来的这一跳带不上，所以由本页再发起一次站内跳转。 */
function page(title: string, body: string, redirectTo?: string): string {
  const refresh = redirectTo ? `<meta http-equiv="refresh" content="0;url=${escapeHtml(redirectTo)}">` : "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>${escapeHtml(title)}</title>`
    + `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 16px;line-height:1.6;color:#1f2329}a{color:#3370ff}</style></head>`
    + `<body><h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${body}</p></body></html>`;
}

const failurePage = (message: string) => page("没能用飞书登录天枢", `${escapeHtml(message)}<br><a href="/access">用天枢 ID 和口令登录</a>`);
const connectFailurePage = (message: string, back: string) => page("没能连接飞书", `${escapeHtml(message)}<br><a href="${escapeHtml(back)}">回到天枢</a>`);

const OUTCOME_STATUS: Record<Exclude<FeishuLoginOutcome["kind"], "ok">, { status: number; code: string }> = {
  code_invalid: { status: 401, code: "FEISHU_CODE_INVALID" },
  unavailable: { status: 502, code: "FEISHU_UNAVAILABLE" },
  not_linked: { status: 403, code: "FEISHU_NOT_LINKED" },
  link_conflict: { status: 403, code: "FEISHU_LINK_CONFLICT" },
  no_access: { status: 403, code: "FEISHU_NO_ACCESS" },
};

/**
 * 飞书免登：浏览器走 /start → 飞书授权页 → /callback；飞书客户端里由前端 requestAccess 拿 code 后 POST /code。
 * 两条路都复用 sessionSetCookie 建会话。已登录的人「连接飞书」走 /start?connect=1，回调只关联账号、存授权，不换会话。
 * 未配置飞书应用时只有 /config 和 /api/me/feishu（enabled=false），其余 404。
 */
export function registerFeishuAuthRoutes(app: AppInstance, ctx: RouteContext, client: FeishuClient | undefined): void {
  const { env, q, fail, readSession, requirePerson, peopleDirectory, now } = ctx;
  const feishu = env.feishu;
  const perIp = { rateLimit: { max: 20, timeWindow: "1 minute" } };
  const redirectUri = `${env.publicOrigin}/api/auth/feishu/callback`;

  app.get("/api/auth/feishu/config", { schema: { response: { 200: FeishuAuthConfigResponse } } }, async () =>
    feishu && client ? { enabled: true, appId: feishu.appId, scopes: FEISHU_OAUTH_SCOPE.split(" ") } : { enabled: false });

  app.get("/api/me/feishu", { preHandler: requirePerson, schema: { response: { 200: FeishuConnectionResponse } } }, async (req) =>
    feishu && client ? { enabled: true, connected: await feishuConnected(q, feishu, req.person!.personId, now()) } : { enabled: false, connected: false });

  if (!feishu || !client) return;

  const sessionCookie = (outcome: Extract<FeishuLoginOutcome, { kind: "ok" }>) =>
    sessionSetCookie(env.sessionSecret, env.sessionMaxAgeSeconds, { pid: outcome.personId, v: outcome.sessionVersion, view: outcome.role });

  /**
   * 连接飞书的回调：发起时的会话还有效（口令没重置）才继续；飞书账号关联给发起的人、存授权，不换会话。
   * 之后这个人主持或建的会里，因为没有飞书授权退回手动的，接着自动拿妙记。
   */
  const connectFeishu = async (reply: FastifyReply, intent: FeishuConnectIntent, next: string, code: string | undefined, error: string | undefined) => {
    if (!code) return reply.status(400).send(connectFailurePage(error ? "你取消了飞书授权。" : "飞书没有返回授权码，请再试一次。", next));
    const access = (await q("SELECT session_version FROM member_access WHERE person_id = $1", [intent.personId])).rows[0] as { session_version: number } | undefined;
    if (access?.session_version !== intent.sessionVersion) return reply.status(401).send(connectFailurePage("登录已失效，请重新登录天枢后再连接飞书。", "/access"));
    const outcome = await completeFeishuLogin({
      q, env: feishu, client, peopleDirectory, code, redirectUri, sessionPersonId: intent.personId, connect: true, now: now(),
    });
    if (outcome.kind !== "ok") return reply.status(outcome.kind === "code_invalid" ? 400 : OUTCOME_STATUS[outcome.kind].status).send(connectFailurePage(outcome.message, next));
    await app.meetingFollowThrough.minutes.resumeFor(intent.personId);
    return reply.send(page("已连接飞书", `<a href="${escapeHtml(next)}">没有自动跳转请点这里</a>`, next));
  };

  app.get(
    "/api/auth/feishu/start",
    { config: perIp, schema: { querystring: Type.Object({ next: Type.Optional(Type.String()), connect: Type.Optional(Type.Literal("1")) }) } },
    async (req, reply) => {
      const next = safeNextPath(req.query.next);
      const session = await readSession(req);
      // 已登录就直接进去：飞书消息里的深链接不必每次都走一遍授权。连接飞书（connect=1）除外。
      if (session && !req.query.connect) return reply.redirect(next, 302);
      const connect = session ? { personId: session.personId, sessionVersion: session.sessionVersion } : undefined;
      const { state, setCookie } = createOAuthState(env.sessionSecret, next, now().getTime(), connect);
      reply.header("set-cookie", setCookie);
      return reply.redirect(client.authorizeUrl(redirectUri, state, FEISHU_OAUTH_SCOPE), 302);
    },
  );

  app.get(
    "/api/auth/feishu/callback",
    { config: perIp, schema: { querystring: Type.Object({ code: Type.Optional(Type.String()), state: Type.Optional(Type.String()), error: Type.Optional(Type.String()) }) } },
    async (req: FastifyRequest<{ Querystring: { code?: string; state?: string; error?: string } }>, reply) => {
      reply.type("text/html; charset=utf-8").header("cache-control", "no-store");
      const verified = verifyOAuthState(env.sessionSecret, parseCookies(req.headers.cookie)[FEISHU_STATE_COOKIE], req.query.state, now().getTime());
      reply.header("set-cookie", clearOAuthStateCookie());
      if (!verified) return reply.status(400).send(failurePage("登录链接已过期或不是从这个浏览器发起的，请重新打开天枢。"));
      if (verified.connect) return connectFeishu(reply, verified.connect, verified.next, req.query.code, req.query.error);
      if (!req.query.code) return reply.status(400).send(failurePage(req.query.error ? "你取消了飞书授权。" : "飞书没有返回授权码，请重新打开天枢。"));
      const session = await readSession(req);
      const outcome = await completeFeishuLogin({
        q, env: feishu, client, peopleDirectory, code: req.query.code, redirectUri, sessionPersonId: session?.personId, now: now(),
      });
      if (outcome.kind !== "ok") return reply.status(outcome.kind === "code_invalid" ? 400 : OUTCOME_STATUS[outcome.kind].status).send(failurePage(outcome.message));
      reply.header("set-cookie", [clearOAuthStateCookie(), sessionCookie(outcome)]);
      const target = outcome.onboarded ? verified.next : `/welcome?next=${encodeURIComponent(verified.next)}`;
      return reply.send(page("正在进入天枢…", `<a href="${escapeHtml(target)}">没有自动跳转请点这里</a>`, target));
    },
  );

  app.post(
    "/api/auth/feishu/code",
    { config: perIp, schema: { body: FeishuCodeLoginRequest, response: { 200: LoginResponse } } },
    async (req, reply) => {
      if (!isAllowedOrigin(env, req.headers.origin)) return fail(reply, 403, "ORIGIN_MISMATCH", "Origin 不符");
      const session = await readSession(req);
      const outcome = await completeFeishuLogin({ q, env: feishu, client, peopleDirectory, code: req.body.code, sessionPersonId: session?.personId, now: now() });
      if (outcome.kind !== "ok") return fail(reply, OUTCOME_STATUS[outcome.kind].status, OUTCOME_STATUS[outcome.kind].code, outcome.message);
      reply.header("set-cookie", sessionCookie(outcome));
      return { authenticated: true, mustChangePasscode: false, role: outcome.role, onboarded: outcome.onboarded };
    },
  );
}
