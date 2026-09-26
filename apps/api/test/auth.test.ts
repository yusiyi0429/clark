import { describe, expect, it } from "vitest";
import { setMemberAccess } from "../src/memberAccess.js";
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
      expect(session.json()).toEqual({ authenticated: true, personId: TEST_MEMBER.personId, displayName: "测试乙", role: "member", loginId: TEST_MEMBER.loginId, onboarded: false });
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
