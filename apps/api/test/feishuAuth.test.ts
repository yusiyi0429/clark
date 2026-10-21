import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { FeishuApiError, type FeishuClient } from "../src/feishu/client.js";
import { createOAuthState, safeNextPath, verifyOAuthState } from "../src/feishu/oauth.js";
import { createTestApp, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";

const feishu = { appId: "cli_test", appSecret: "test-secret", tokenKey: randomBytes(32), tokenKeyVersion: 1 };

function fakeFeishu(openId = "ou_ceo", scope = "offline_access") {
  const exchanges: { code: string; redirectUri?: string }[] = [];
  const client: FeishuClient = {
    authorizeUrl: (redirectUri, state, scope) => `https://accounts.feishu.cn/open-apis/authen/v1/authorize?${new URLSearchParams({ redirect_uri: redirectUri, state, scope })}`,
    async exchangeCode(code, redirectUri) {
      exchanges.push({ code, redirectUri });
      if (code === "used") throw new FeishuApiError(20003, "code used");
      return { accessToken: `u-${code}`, expiresIn: 7200, refreshToken: `ur-${code}`, refreshExpiresIn: 604800, scope };
    },
    async refreshUserToken() { throw new Error("not used"); },
    async getUserInfo() { return { openId, unionId: "on_ceo", name: "测试一号位" }; },
  };
  return { client, exchanges };
}

const cookiesOf = (header: string | string[] | undefined) => (Array.isArray(header) ? header : header ? [header] : []);
const cookiePair = (header: string | string[] | undefined, name: string) => cookiesOf(header).find((c) => c.startsWith(`${name}=`))?.split(";")[0];

let t: TestApp | undefined;
afterEach(async () => { await t?.close(); t = undefined; });

async function startFlow(app: TestApp["app"], next = "/me/tasks") {
  const start = await app.inject({ method: "GET", url: `/api/auth/feishu/start?next=${encodeURIComponent(next)}` });
  expect(start.statusCode).toBe(302);
  const location = new URL(start.headers.location as string);
  return { state: location.searchParams.get("state")!, stateCookie: cookiePair(start.headers["set-cookie"], "feishu_oauth")!, location, start };
}

describe("飞书 OAuth state", () => {
  it("签名、有效期、state 都对上才通过；next 只接受站内路径", () => {
    const { state, setCookie } = createOAuthState("secret", "/issues/1", 1_000_000);
    const value = setCookie.split(";")[0].split("=")[1];
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(verifyOAuthState("secret", value, state, 1_000_000)).toEqual({ next: "/issues/1" });
    expect(verifyOAuthState("secret", value, `${state}x`, 1_000_000)).toBeNull();
    expect(verifyOAuthState("other", value, state, 1_000_000)).toBeNull();
    expect(verifyOAuthState("secret", value, state, 1_000_000 + 601_000)).toBeNull();
    expect(verifyOAuthState("secret", `${value.slice(0, -2)}AA`, state, 1_000_000)).toBeNull();
    expect(verifyOAuthState("secret", undefined, state, 1_000_000)).toBeNull();
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("https://evil.example")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
    expect(safeNextPath("/me?x=1")).toBe("/me?x=1");
  });
});

describe("飞书免登路由", () => {
  it("未配置飞书时只告诉前端不可用，其余接口不存在", async () => {
    t = await createTestApp();
    expect((await t.app.inject({ method: "GET", url: "/api/auth/feishu/config" })).json()).toEqual({ enabled: false });
    expect((await t.app.inject({ method: "GET", url: "/api/auth/feishu/start" })).statusCode).toBe(404);
    const cookie = await t.loginCookie();
    expect((await t.app.inject({ method: "GET", url: "/api/me/feishu", headers: { cookie } })).json()).toEqual({ enabled: false, connected: false });
  });

  it("浏览器：start 写 state cookie 跳授权页；回调校验 state 后按已关联的人建会话，令牌加密落库", async () => {
    const fake = fakeFeishu();
    t = await createTestApp({ feishu }, undefined, { feishuClient: fake.client });
    await t.sql("INSERT INTO feishu_identities (person_id, open_id) VALUES ($1, 'ou_ceo')", [TEST_CEO.personId]);
    expect((await t.app.inject({ method: "GET", url: "/api/auth/feishu/config" })).json()).toEqual({ enabled: true, appId: "cli_test" });

    const { state, stateCookie, location } = await startFlow(t.app);
    expect(location.origin + location.pathname).toBe("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
    expect(location.searchParams.get("redirect_uri")).toBe(`${t.publicOrigin}/api/auth/feishu/callback`);
    expect(location.searchParams.get("scope")).toBe("offline_access drive:drive.metadata:readonly minutes:minutes:readonly minutes:minutes.basic:read minutes:minutes.search:read minutes:minutes.artifacts:read minutes:minutes.transcript:export vc:meeting:readonly");

    // state 不符、没有 cookie：都拒绝，不去换 token
    const wrong = await t.app.inject({ method: "GET", url: `/api/auth/feishu/callback?code=c1&state=${state}x`, headers: { cookie: stateCookie } });
    expect(wrong.statusCode).toBe(400);
    const missing = await t.app.inject({ method: "GET", url: `/api/auth/feishu/callback?code=c1&state=${state}` });
    expect(missing.statusCode).toBe(400);
    expect(cookiePair(missing.headers["set-cookie"], "warmap_session")).toBeUndefined();
    expect(fake.exchanges).toEqual([]);

    const ok = await t.app.inject({ method: "GET", url: `/api/auth/feishu/callback?code=c1&state=${state}`, headers: { cookie: stateCookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toMatch(/text\/html/);
    expect(ok.body).toMatch(/http-equiv="refresh" content="0;url=[^"]*%2Fme%2Ftasks|url=\/me\/tasks/);
    expect(fake.exchanges).toEqual([{ code: "c1", redirectUri: `${t.publicOrigin}/api/auth/feishu/callback` }]);
    const session = cookiePair(ok.headers["set-cookie"], "warmap_session")!;
    const me = await t.app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: session } });
    expect(me.json()).toMatchObject({ authenticated: true, personId: TEST_CEO.personId });

    const [token] = await t.sql("SELECT status, key_version, ciphertext, authorized_at FROM feishu_user_tokens");
    expect(token).toMatchObject({ status: "active", key_version: 1 });
    expect(String(token.ciphertext)).not.toMatch(/u-c1|ur-c1/);
    expect(await t.sql("SELECT name, union_id FROM feishu_identities")).toEqual([{ name: "测试一号位", union_id: "on_ceo" }]);

    // 已登录时深链接直接进去，不再走授权
    const again = await t.app.inject({ method: "GET", url: "/api/auth/feishu/start?next=/issues/9", headers: { cookie: session } });
    expect(again.headers.location).toBe("/issues/9");
  });

  it("飞书账号没关联：没登录给说明页；已用口令登录时关联到当前的人", async () => {
    const fake = fakeFeishu("ou_new");
    t = await createTestApp({ feishu }, undefined, { feishuClient: fake.client });
    const first = await startFlow(t.app);
    const denied = await t.app.inject({ method: "GET", url: `/api/auth/feishu/callback?code=c2&state=${first.state}`, headers: { cookie: first.stateCookie } });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toContain("还没有关联天枢人员");
    expect(await t.sql("SELECT * FROM feishu_user_tokens")).toEqual([]);

    const login = await t.loginCookie();
    const second = await startFlow(t.app);
    const bound = await t.app.inject({ method: "GET", url: `/api/auth/feishu/callback?code=c3&state=${second.state}`, headers: { cookie: `${second.stateCookie}; ${login}` } });
    expect(bound.statusCode).toBe(200);
    expect(await t.sql("SELECT person_id, open_id FROM feishu_identities")).toEqual([{ person_id: TEST_CEO.personId, open_id: "ou_new" }]);
  });

  it("飞书客户端里：POST code 校验来源，已关联的人建会话；未关联与失效 code 给明确错误", async () => {
    const fake = fakeFeishu();
    t = await createTestApp({ feishu }, undefined, { feishuClient: fake.client });
    const post = (code: string, origin = t!.publicOrigin) =>
      t!.app.inject({ method: "POST", url: "/api/auth/feishu/code", headers: { origin }, payload: { code } });
    expect((await post("c1", "https://evil.example")).statusCode).toBe(403);
    expect((await post("c1")).json()).toMatchObject({ code: "FEISHU_NOT_LINKED" });

    await t.sql("INSERT INTO feishu_identities (person_id, open_id) VALUES ($1, 'ou_ceo')", [TEST_CEO.personId]);
    const ok = await post("c4");
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ authenticated: true, mustChangePasscode: false, role: "ceo" });
    expect(fake.exchanges.at(-1)).toEqual({ code: "c4", redirectUri: undefined });
    expect(cookiePair(ok.headers["set-cookie"], "warmap_session")).toBeDefined();

    const used = await post("used");
    expect(used.statusCode).toBe(401);
    expect(used.json()).toMatchObject({ code: "FEISHU_CODE_INVALID" });
  });
});

const MINUTES_SCOPE = "offline_access minutes:minutes:readonly minutes:minutes.search:read minutes:minutes.artifacts:read";

/** CEO 建一场测试成员主持的会，开完 10 分钟，因为主持人和建会的人都没有飞书授权退回了手动。 */
async function manualMeeting(app: TestApp): Promise<string> {
  const ceo = await app.loginCookie();
  const issueCard = await app.createIssue() as unknown as { objectRef: { id: string }; actions: { actionType: string; actionId: string }[] };
  const create = issueCard.actions.find((a) => a.actionType === "issue.create_meeting")!;
  const created = await app.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie: ceo, origin: app.publicOrigin }, payload: {
    actionId: create.actionId,
    input: { title: "周会", scheduledAt: new Date(Date.now() - 70 * 60_000).toISOString(), leadDriId: TEST_MEMBER.personId,
      ceoParticipantId: TEST_CEO.personId, participants: [TEST_MEMBER.personId], issueIds: [issueCard.objectRef.id] },
  } });
  expect(created.statusCode).toBe(200);
  const id = created.json().cards[0].objectRef.id as string;
  await app.sql("UPDATE meetings SET ended_at = now() - interval '10 minutes', minutes_status = 'manual', minutes_error = '主持人和建会的人都没有可用的飞书授权' WHERE id = $1", [id]);
  return id;
}

describe("已登录的人连接飞书", () => {
  it("口令登录后从 start?connect=1 授权：回调那一跳没有会话 cookie 也关联到发起的人、存授权，不换会话；没授权退回手动的会接着等妙记", async () => {
    const fake = fakeFeishu("ou_ceo_feishu", MINUTES_SCOPE);
    t = await createTestApp({ feishu }, undefined, { feishuClient: fake.client });
    const meetingId = await manualMeeting(t);
    const cookie = await t.loginCookie();
    const status = async () => (await t!.app.inject({ method: "GET", url: "/api/me/feishu", headers: { cookie } })).json();
    expect(await status()).toEqual({ enabled: true, connected: false });

    const start = await t.app.inject({ method: "GET", url: `/api/auth/feishu/start?connect=1&next=${encodeURIComponent(`/meetings/${meetingId}`)}`, headers: { cookie } });
    expect(start.statusCode).toBe(302);
    const location = new URL(start.headers.location as string);
    expect(location.origin).toBe("https://accounts.feishu.cn");
    const state = location.searchParams.get("state")!;
    const stateCookie = cookiePair(start.headers["set-cookie"], "feishu_oauth")!;

    // 从飞书跳回来的这一跳带不上 SameSite=Strict 的会话 cookie，只有 state cookie。
    const back = await t.app.inject({ method: "GET", url: `/api/auth/feishu/callback?code=c9&state=${state}`, headers: { cookie: stateCookie } });
    expect(back.statusCode).toBe(200);
    expect(back.body).toContain("已连接飞书");
    expect(back.body).toContain(`/meetings/${meetingId}`);
    expect(cookiePair(back.headers["set-cookie"], "warmap_session")).toBeUndefined();
    expect(await t.sql("SELECT person_id, open_id FROM feishu_identities")).toEqual([{ person_id: TEST_CEO.personId, open_id: "ou_ceo_feishu" }]);
    expect(await status()).toEqual({ enabled: true, connected: true });
    // 建会的人连上了：这场会回到等妙记，马上排一次轮询。
    expect((await t.sql("SELECT minutes_status, minutes_error FROM meetings WHERE id = $1", [meetingId]))[0]).toEqual({ minutes_status: "waiting", minutes_error: null });
    expect((await t.sql("SELECT count(*)::int AS n FROM jobs WHERE kind = 'meeting.minutes_poll'"))[0].n).toBe(1);

    // 授权里没有读妙记的权限：算没连好。
    await t.sql("UPDATE feishu_user_tokens SET scope = 'offline_access'");
    expect(await status()).toEqual({ enabled: true, connected: false });
  });

  it("飞书账号已经关联了别人、或者发起后口令重置了：拒绝，不存授权", async () => {
    const fake = fakeFeishu("ou_member", MINUTES_SCOPE);
    t = await createTestApp({ feishu }, undefined, { feishuClient: fake.client });
    await t.sql("INSERT INTO feishu_identities (person_id, open_id) VALUES ($1, 'ou_member')", [TEST_MEMBER.personId]);
    const cookie = await t.loginCookie();
    const begin = async () => {
      const start = await t!.app.inject({ method: "GET", url: "/api/auth/feishu/start?connect=1&next=/me", headers: { cookie } });
      return { state: new URL(start.headers.location as string).searchParams.get("state")!, stateCookie: cookiePair(start.headers["set-cookie"], "feishu_oauth")! };
    };
    const first = await begin();
    const taken = await t.app.inject({ method: "GET", url: `/api/auth/feishu/callback?code=c1&state=${first.state}`, headers: { cookie: first.stateCookie } });
    expect(taken.statusCode).toBe(403);
    expect(taken.body).toContain("已经关联了别的天枢账号");

    const second = await begin();
    await t.sql("UPDATE member_access SET session_version = session_version + 1 WHERE person_id = $1", [TEST_CEO.personId]);
    const stale = await t.app.inject({ method: "GET", url: `/api/auth/feishu/callback?code=c2&state=${second.state}`, headers: { cookie: second.stateCookie } });
    expect(stale.statusCode).toBe(401);
    expect(fake.exchanges.map((exchange) => exchange.code)).toEqual(["c1"]);
    expect(await t.sql("SELECT * FROM feishu_user_tokens")).toEqual([]);
  });
});
