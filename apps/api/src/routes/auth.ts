import type { FastifyReply, FastifyRequest } from "fastify";
import { ChangePasscodeRequest, LoginRequest, LoginResponse, SessionResponse, SetViewRequest, type TLoginResponse, type TSessionRole } from "@warmap/contracts";
import { LOCK_AFTER_FAILURES, changePasscode, roleOf, verifyCredentials, type Rejected } from "../memberAccess.js";
import { sessionClearCookie, sessionSetCookie } from "../session.js";
import { hasCompletedOnboarding } from "../onboarding.js";
import { isAllowedOrigin, type AppInstance, type RouteContext } from "./shared.js";

export function registerAuthRoutes(app: AppInstance, ctx: RouteContext): void {
  const { env, q, fail, requirePerson, readSession, now, companyMemory } = ctx;
  const findPerson = (personId: string) => companyMemory.searchPeople(undefined).find((p) => p.personId === personId);
  // 按 IP 的频率上限只挡刷接口；防猜口令靠按 ID 锁定（办公室共用出口 IP 时不互相误伤）。
  const perIp = { rateLimit: { max: 20, timeWindow: "1 minute" } };

  function sameOrigin(req: FastifyRequest, reply: FastifyReply, done: () => void) {
    if (!isAllowedOrigin(env, req.headers.origin)) {
      fail(reply, 403, "ORIGIN_MISMATCH", "Origin 不符");
      return;
    }
    done();
  }

  function rejected(reply: FastifyReply, outcome: Rejected) {
    if (outcome.kind === "locked") {
      reply.header("retry-after", String(outcome.retryAfterSeconds));
      return fail(reply, 423, "ACCOUNT_LOCKED", `已连续输错 ${LOCK_AFTER_FAILURES} 次，请 ${Math.ceil(outcome.retryAfterSeconds / 60)} 分钟后再试`);
    }
    return fail(reply, 401, "INVALID_CREDENTIALS", "ID 或口令不对");
  }

  async function signIn(reply: FastifyReply, personId: string, version: number, role: TSessionRole): Promise<TLoginResponse> {
    const onboarded = await hasCompletedOnboarding(q, personId);
    reply.header("set-cookie", sessionSetCookie(env.sessionSecret, env.sessionMaxAgeSeconds, { pid: personId, v: version, view: role }));
    return { authenticated: true, mustChangePasscode: false, role, onboarded };
  }

  app.post(
    "/api/auth/login",
    { preHandler: sameOrigin, config: perIp, schema: { body: LoginRequest, response: { 200: LoginResponse } } },
    async (req, reply) => {
      const outcome = await verifyCredentials(q, findPerson, req.body.loginId, req.body.passcode, now());
      if (outcome.kind !== "verified") return rejected(reply, outcome);
      if (outcome.row.must_change) return { authenticated: false, mustChangePasscode: true };
      return signIn(reply, outcome.person.personId, outcome.row.session_version, roleOf(outcome.person));
    },
  );

  app.post(
    "/api/auth/passcode",
    { preHandler: sameOrigin, config: perIp, schema: { body: ChangePasscodeRequest, response: { 200: LoginResponse } } },
    async (req, reply) => {
      const outcome = await verifyCredentials(q, findPerson, req.body.loginId, req.body.passcode, now());
      if (outcome.kind !== "verified") return rejected(reply, outcome);
      if (req.body.newPasscode === req.body.passcode) return fail(reply, 400, "PASSCODE_UNCHANGED", "新口令不能和当前口令相同");
      const version = await changePasscode(q, outcome.row, req.body.newPasscode);
      return signIn(reply, outcome.person.personId, version, roleOf(outcome.person));
    },
  );

  app.post("/api/auth/logout", { preHandler: requirePerson }, async (_req, reply) => {
    reply.header("set-cookie", sessionClearCookie());
    return { authenticated: false };
  });

  async function sessionResponse(person: NonNullable<Awaited<ReturnType<typeof readSession>>>) {
    const access = await q("SELECT login_id FROM member_access WHERE person_id = $1", [person.personId]);
    const loginId = access.rows[0]?.login_id as string | undefined;
    return {
      authenticated: true,
      personId: person.personId,
      displayName: findPerson(person.personId)?.displayName ?? person.personId,
      role: person.role,
      canSwitchView: person.canSwitchView,
      onboarded: await hasCompletedOnboarding(q, person.personId),
      ...(loginId ? { loginId } : {}),
    };
  }

  app.get("/api/auth/session", { schema: { response: { 200: SessionResponse } } }, async (req) => {
    const person = await readSession(req);
    return person ? sessionResponse(person) : { authenticated: false };
  });

  app.post("/api/auth/view", { preHandler: requirePerson, schema: { body: SetViewRequest, response: { 200: SessionResponse } } }, async (req, reply) => {
    const person = req.person!;
    if (!person.canSwitchView) return fail(reply, 403, "FORBIDDEN", "这个账号不能切换工作台");
    reply.header("set-cookie", sessionSetCookie(env.sessionSecret, env.sessionMaxAgeSeconds,
      { pid: person.personId, v: person.sessionVersion, view: req.body.view }));
    return sessionResponse({ ...person, role: req.body.view });
  });
}
