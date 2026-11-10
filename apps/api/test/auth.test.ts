import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setMemberAccess } from "../src/memberAccess.js";
import { createSessionToken, readSessionToken } from "../src/session.js";
import type { Query } from "../src/meetingStore.js";
import { TEST_CEO, TEST_MEMBER, createTestApp, type TestApp } from "./helpers.js";

const cookieOf = (setCookie: unknown) => String(setCookie).split(";")[0];
const queryOf = (t: TestApp): Query => (text, params) => t.sql(text, params).then((rows) => ({ rows, rowCount: rows.length }) as never);

describe("登录 ID + 4 位口令", () => {
  it("初始码登录不发会话，改口令后才登录；新口令不能与初始码相同", async () => {
    const t = await createTestApp();
    try {
      await setMemberAccess(queryOf(t), { personId: TEST_MEMBER.personId, loginId: TEST_MEMBER.loginId, passcode: "4826", mustChange: true });
      const headers = { origin: t.publicOrigin };

      const first = await t.app.inject({ method: "POST", url: "/api/auth/login", headers, payload: { loginId: TEST_MEMBER.loginId, passcode: "4826" } });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ authenticated: false, mustChangePasscode: true });
      expect(first.headers["set-cookie"]).toBeUndefined();

      const same = await t.app.inject({ method: "POST", url: "/api/auth/passcode", headers, payload: { loginId: TEST_MEMBER.loginId, passcode: "4826", newPasscode: "4826" } });
      expect(same.statusCode).toBe(400);
      expect(same.json()).toMatchObject({ code: "PASSCODE_UNCHANGED", message: "新口令不能和当前口令相同" });

      const changed = await t.app.inject({ method: "POST", url: "/api/auth/passcode", headers, payload: { loginId: TEST_MEMBER.loginId, passcode: "4826", newPasscode: "7391" } });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toEqual({ authenticated: true, mustChangePasscode: false, role: "member", onboarded: false });

      const session = await t.app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: cookieOf(changed.headers["set-cookie"]) } });
      expect(session.json()).toEqual({ authenticated: true, personId: TEST_MEMBER.personId, displayName: "测试乙", role: "member", canSwitchView: false, loginId: TEST_MEMBER.loginId, onboarded: false, buddy: null });
    } finally {
      await t.close();
    }
  });

  it("ID 不存在与口令错误同一句话；连错 5 次返回 423 与分钟数", async () => {
    const t = await createTestApp();
    try {
      const headers = { origin: t.publicOrigin };
      const unknown = await t.app.inject({ method: "POST", url: "/api/auth/login", headers, payload: { loginId: "nobody", passcode: "1357" } });
      expect(unknown.statusCode).toBe(401);
      expect(unknown.json()).toMatchObject({ code: "INVALID_CREDENTIALS", message: "ID 或口令不对" });
      for (let i = 0; i < 4; i++) {
        const wrong = await t.app.inject({ method: "POST", url: "/api/auth/login", headers, payload: { loginId: TEST_MEMBER.loginId, passcode: "0001" } });
        expect(wrong.statusCode).toBe(401);
      }
      const locked = await t.app.inject({ method: "POST", url: "/api/auth/login", headers, payload: { loginId: TEST_MEMBER.loginId, passcode: "0001" } });
      expect(locked.statusCode).toBe(423);
      expect(locked.headers["retry-after"]).toBe("900");
      expect(locked.json()).toMatchObject({ code: "ACCOUNT_LOCKED", message: "已连续输错 5 次，请 15 分钟后再试" });
    } finally {
      await t.close();
    }
  });

  it("成员会话调用 CEO 接口得到 403（不是 401），CEO 照常", async () => {
    const t = await createTestApp();
    try {
      const member = await t.memberCookie();
      const denied = await t.app.inject({ method: "GET", url: "/api/cards/home", headers: { cookie: member } });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ code: "FORBIDDEN" });
      const ceo = await t.loginCookie();
      expect((await t.app.inject({ method: "GET", url: "/api/cards/home", headers: { cookie: ceo } })).statusCode).toBe(200);
      // 只有负责人身份的人不能切；CEO 角色的人都能切到工作模式（17.2 第 45 条，见 ceoWorkMode.test.ts）。
      for (const [cookie, view, status] of [[ceo, "member", 200], [member, "ceo", 403]] as const)
        expect((await t.app.inject({ method: "POST", url: "/api/auth/view", headers: { cookie, origin: t.publicOrigin }, payload: { view } })).statusCode).toBe(status);
      const session = await t.app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: ceo } });
      expect(session.json()).toMatchObject({ authenticated: true, personId: TEST_CEO.personId, role: "ceo" });
    } finally {
      await t.close();
    }
  });

  it("管理员重置后旧会话立即失效", async () => {
    const t = await createTestApp();
    try {
      const member = await t.memberCookie();
      await setMemberAccess(queryOf(t), { personId: TEST_MEMBER.personId, loginId: TEST_MEMBER.loginId, passcode: "9173", mustChange: true });
      const session = await t.app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: member } });
      expect(session.json()).toEqual({ authenticated: false });
    } finally {
      await t.close();
    }
  });

  it("用着就续期（设计 19 节第 8 条）：会话签出来超过一小时，回应换一张有效期重新算满的；刚签的不重签；退出登录不被续回来；凭据版本变了的不续", async () => {
    const t = await createTestApp();
    const secret = "test-session-secret";
    const maxAge = 60 * 60 * 8;
    try {
      const fresh = await t.memberCookie();
      expect((await t.app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: fresh } })).headers["set-cookie"]).toBeUndefined();

      // 两小时前签的：还剩 maxAge - 2 小时。用一次就换一张满的，人、凭据版本、视角都不变。
      const claims = readSessionToken(secret, fresh.split("=")[1])!;
      const old = `warmap_session=${createSessionToken(secret, maxAge - 2 * 60 * 60, { pid: claims.pid, v: claims.v, ...(claims.view ? { view: claims.view } : {}) })}`;
      const used = await t.app.inject({ method: "GET", url: "/api/me/appearance", headers: { cookie: old } });
      expect(used.statusCode).toBe(200);
      const setCookie = String(used.headers["set-cookie"]);
      expect(setCookie).toContain(`Max-Age=${maxAge}`);
      const renewed = readSessionToken(secret, cookieOf(setCookie).split("=")[1])!;
      expect(renewed).toMatchObject({ pid: claims.pid, v: claims.v, view: claims.view });
      expect(renewed.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(maxAge - 60);
      expect((await t.app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: cookieOf(setCookie) } })).json()).toMatchObject({ authenticated: true });

      // 退出登录只清会话，不会被续回来。
      const out = await t.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: old, origin: t.publicOrigin } });
      expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");

      // 管理员重置（凭据版本加一）：旧会话失效，也不续。
      await setMemberAccess(queryOf(t), { personId: TEST_MEMBER.personId, loginId: TEST_MEMBER.loginId, passcode: "9173", mustChange: true });
      const dead = await t.app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: old } });
      expect(dead.json()).toEqual({ authenticated: false });
      expect(dead.headers["set-cookie"]).toBeUndefined();
    } finally {
      await t.close();
    }
  });

  it("双身份默认 CEO；切换重签同版本 cookie，两个视角各进自己的接口，旧 cookie 仍遵守版本失效规则", async () => {
    const dir = await mkdtemp(join(tmpdir(), "warmap-view-test-"));
    const seed = join(dir, "people.json");
    await writeFile(seed, JSON.stringify({ schemaVersion: "company-people.v1", people: [
      { personId: TEST_CEO.personId, displayName: "测试甲", roles: ["ceo", "dri"] },
      { personId: TEST_MEMBER.personId, displayName: "测试乙", roles: ["dri"] },
    ] }));
    let t: TestApp | undefined;
    try {
      t = await createTestApp({ companyPeopleSeed: seed });
      const ceoCookie = await t.loginCookie();
      const get = (cookie: string, url: string) => t!.app.inject({ method: "GET", url, headers: { cookie } });
      const switchTo = (cookie: string, view: "ceo" | "member") => t!.app.inject({ method: "POST", url: "/api/auth/view", headers: { cookie, origin: t!.publicOrigin }, payload: { view } });
      expect((await get(ceoCookie, "/api/auth/session")).json()).toMatchObject({ role: "ceo", canSwitchView: true });
      expect((await get(ceoCookie, "/api/cards/home")).statusCode).toBe(200);
      expect((await get(ceoCookie, "/api/me/home")).statusCode).toBe(403);
      const switched = await switchTo(ceoCookie, "member");
      expect(switched.statusCode).toBe(200);
      expect(switched.json()).toMatchObject({ role: "member", canSwitchView: true, personId: TEST_CEO.personId });
      const memberCookie = cookieOf(switched.headers["set-cookie"]);
      expect(readSessionToken("test-session-secret", memberCookie.split("=")[1])).toMatchObject({ pid: TEST_CEO.personId, view: "member", v: 1 });
      expect((await get(memberCookie, "/api/me/home")).statusCode).toBe(200);
      expect((await get(memberCookie, "/api/cards/home")).statusCode).toBe(403);
      expect((await get(memberCookie, "/api/auth/session")).json()).toMatchObject({ role: "member", canSwitchView: true });
      const colleague = await t.memberCookie();
      const task = await t.app.inject({ method: "POST", url: "/api/me/tasks", headers: { cookie: colleague, origin: t.publicOrigin },
        payload: { clientId: randomUUID(), title: "邀请双身份同事核对", missionId: null } });
      expect(task.statusCode).toBe(200);
      const taskUrl = `/api/me/tasks/${task.json().id}`;
      expect((await get(colleague, taskUrl)).json().collaboratorOptions.map((entry: { personId: string }) => entry.personId)).toContain(TEST_CEO.personId);
      expect((await t.app.inject({ method: "POST", url: `${taskUrl}/collaborators`, headers: { cookie: colleague, origin: t.publicOrigin },
        payload: { personIds: [TEST_CEO.personId] } })).statusCode).toBe(200);
      expect((await get(ceoCookie, taskUrl)).statusCode).toBe(403);
      expect((await get(memberCookie, taskUrl)).json().role).toBe("collaborator");
      const back = await switchTo(memberCookie, "ceo");
      expect(back.json()).toMatchObject({ role: "ceo", canSwitchView: true });
      expect((await get(cookieOf(back.headers["set-cookie"]), "/api/cards/home")).statusCode).toBe(200);
      expect((await get(ceoCookie, "/api/cards/home")).statusCode).toBe(200);
      await setMemberAccess(queryOf(t), { personId: TEST_CEO.personId, loginId: TEST_CEO.loginId, passcode: "9173", mustChange: true });
      for (const cookie of [ceoCookie, memberCookie, cookieOf(back.headers["set-cookie"])]) {
        expect((await get(cookie, "/api/auth/session")).json()).toEqual({ authenticated: false });
      }
      expect((await switchTo(ceoCookie, "member")).statusCode).toBe(401);
      expect((await switchTo(await t.memberCookie(), "ceo")).statusCode).toBe(403);
    } finally { await t?.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("本地可额外允许的来源（如 127.0.0.1）能登录和写入；未列出的来源仍 403", async () => {
    const t = await createTestApp({ extraOrigins: ["http://127.0.0.1:3100"] });
    try {
      const extra = { origin: "http://127.0.0.1:3100" };
      const login = await t.app.inject({ method: "POST", url: "/api/auth/login", headers: extra, payload: { loginId: TEST_MEMBER.loginId, passcode: TEST_MEMBER.passcode } });
      expect(login.statusCode).toBe(200);
      const out = await t.app.inject({ method: "POST", url: "/api/auth/logout", headers: { ...extra, cookie: cookieOf(login.headers["set-cookie"]) } });
      expect(out.statusCode).toBe(200);
      const evil = await t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: "https://evil.example" }, payload: { loginId: TEST_MEMBER.loginId, passcode: TEST_MEMBER.passcode } });
      expect(evil.statusCode).toBe(403);
      expect(evil.json()).toMatchObject({ code: "ORIGIN_MISMATCH" });
    } finally {
      await t.close();
    }
  });

  it("成员也能退出登录", async () => {
    const t = await createTestApp();
    try {
      const member = await t.memberCookie();
      const out = await t.app.inject({ method: "POST", url: "/api/auth/logout", headers: { origin: t.publicOrigin, cookie: member } });
      expect(out.statusCode).toBe(200);
      expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");
    } finally {
      await t.close();
    }
  });
});
