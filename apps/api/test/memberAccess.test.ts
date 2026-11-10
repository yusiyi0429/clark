import { describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.js";
import {
  LOCK_AFTER_FAILURES,
  canEnterMemberView,
  canSwitchView,
  canUseMemberView,
  changePasscode,
  currentSessionVersion,
  ensureLocalDevLogin,
  loginIdFor,
  randomInitialPasscode,
  setMemberAccess,
  verifyCredentials,
} from "../src/memberAccess.js";
import { createSessionToken, readSessionToken } from "../src/session.js";
import { isAllowedOrigin } from "../src/routes/shared.js";
import type { AppEnv } from "../src/app.js";
import { createTestDb } from "./helpers.js";

const people = [
  { personId: "sun-mingze", displayName: "孙铭泽", roles: ["dri", "participant"] },
  { personId: "liu-minghua", displayName: "刘明华", roles: ["ceo", "dri"] },
];
const findPerson = (id: string) => people.find((p) => p.personId === id);
const at = (iso: string) => new Date(iso);

describe("登录 ID 与初始码", () => {
  it("每个 CEO 角色的人都能切换（不要求是负责人），只有负责人身份的不能；能进成员视角的是成员或 CEO；被邀请资格只看成员身份", () => {
    for (const roles of [["ceo"], ["dri"], ["ceo", "dri"], ["ceo", "participant"], ["participant"]]) {
      const person = { personId: "p", displayName: "测试", roles };
      expect(canSwitchView(person)).toBe(roles.includes("ceo"));
      expect(canEnterMemberView(person)).toBe(true);
      expect(canUseMemberView(person)).toBe(roles.some((role) => role === "dri" || role === "participant"));
    }
    expect(canEnterMemberView({ personId: "p", displayName: "测试", roles: [] })).toBe(false);
  });
  it("姓全拼 + 名首字母；不是「姓-名」格式时交给管理员指定", () => {
    expect(loginIdFor("sun-mingze")).toBe("sunm");
    expect(loginIdFor("chen-xinan")).toBe("chenx");
    expect(loginIdFor("yu-siyi")).toBe("yus");
    expect(loginIdFor("person-fixture-001")).toBeNull();
  });

  it("初始码是 4 位数字，不出现弱码", () => {
    for (let i = 0; i < 200; i++) {
      const code = randomInitialPasscode();
      expect(code).toMatch(/^[0-9]{4}$/);
      expect(["0000", "1111", "1234", "4321"]).not.toContain(code);
    }
  });
});

describe("会话令牌", () => {
  it("只带 pid 与凭据版本；过期、篡改、旧格式都读不出来", () => {
    const token = createSessionToken("s", 60, { pid: "sun-mingze", v: 3 });
    // 另带到期时间（秒），续期按它算。
    expect(readSessionToken("s", token)).toEqual({ pid: "sun-mingze", v: 3, exp: expect.any(Number) });
    expect(readSessionToken("s", token)!.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60);
    expect(readSessionToken("s", createSessionToken("s", -1, { pid: "sun-mingze", v: 3 }))).toBeNull();
    expect(readSessionToken("s", `${token.slice(0, -2)}xx`)).toBeNull();
    expect(readSessionToken("other", token)).toBeNull();
    const legacy = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
    expect(readSessionToken("s", `${legacy}.bad`)).toBeNull();
  });
});

describe("凭据校验与锁定", () => {
  it("正确口令通过；ID 不存在与口令错误一样是 invalid；ID 不分大小写", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const q = db.query.bind(db);
      await setMemberAccess(q, { personId: "sun-mingze", loginId: "sunm", passcode: "2580", mustChange: true });
      const ok = await verifyCredentials(q, findPerson, " SunM ", "2580", at("2026-09-24T02:00:00Z"));
      expect(ok).toMatchObject({ kind: "verified", row: { must_change: true, login_id: "sunm" }, person: { personId: "sun-mingze" } });
      expect(await verifyCredentials(q, findPerson, "nobody", "2580", at("2026-09-24T02:00:00Z"))).toEqual({ kind: "invalid" });
      expect(await verifyCredentials(q, findPerson, "sunm", "1111", at("2026-09-24T02:00:00Z"))).toEqual({ kind: "invalid" });
    });
  });

  it("连续输错 5 次锁 15 分钟，锁定期间正确口令也不放行，到期后可以再登录", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const q = db.query.bind(db);
      await setMemberAccess(q, { personId: "sun-mingze", loginId: "sunm", passcode: "2580", mustChange: false });
      const t0 = at("2026-09-24T02:00:00Z");
      for (let i = 1; i < LOCK_AFTER_FAILURES; i++) {
        expect(await verifyCredentials(q, findPerson, "sunm", "0001", t0)).toEqual({ kind: "invalid" });
      }
      expect(await verifyCredentials(q, findPerson, "sunm", "0001", t0)).toEqual({ kind: "locked", retryAfterSeconds: 900 });
      expect(await verifyCredentials(q, findPerson, "sunm", "2580", at("2026-09-24T02:10:00Z"))).toEqual({ kind: "locked", retryAfterSeconds: 300 });
      expect(await verifyCredentials(q, findPerson, "sunm", "2580", at("2026-09-24T02:15:01Z"))).toMatchObject({ kind: "verified" });
    });
  });

  it("seed 里已删除的人即使有凭据也进不来", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const q = db.query.bind(db);
      await setMemberAccess(q, { personId: "gone-person", loginId: "goneo", passcode: "2580", mustChange: false });
      expect(await verifyCredentials(q, findPerson, "goneo", "2580", at("2026-09-24T02:00:00Z"))).toEqual({ kind: "invalid" });
    });
  });

  it("改口令与重置都让凭据版本加一（旧会话失效）", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const q = db.query.bind(db);
      await setMemberAccess(q, { personId: "sun-mingze", loginId: "sunm", passcode: "2580", mustChange: true });
      expect(await currentSessionVersion(q, "sun-mingze")).toBe(1);
      const verified = await verifyCredentials(q, findPerson, "sunm", "2580", at("2026-09-24T02:00:00Z"));
      if (verified.kind !== "verified") throw new Error("expected verified");
      expect(await changePasscode(q, verified.row, "7391")).toBe(2);
      expect(await verifyCredentials(q, findPerson, "sunm", "7391", at("2026-09-24T02:00:00Z"))).toMatchObject({ kind: "verified", row: { must_change: false } });
      await setMemberAccess(q, { personId: "sun-mingze", loginId: "sunm", passcode: "4826", mustChange: true });
      expect(await currentSessionVersion(q, "sun-mingze")).toBe(3);
      expect(await currentSessionVersion(q, "nobody")).toBeNull();
    });
  });
});

describe("本地开发固定登录", () => {
  it("正式地址是本机 http 时任意本机端口都放行；https 正式地址不放行未列出的本机端口", () => {
    const local = { publicOrigin: "http://localhost:3300" } as AppEnv;
    expect(isAllowedOrigin(local, "http://localhost:3400")).toBe(true);
    expect(isAllowedOrigin(local, "http://127.0.0.1:3200")).toBe(true);
    expect(isAllowedOrigin(local, "https://evil.example")).toBe(false);
    expect(isAllowedOrigin(local, undefined)).toBe(false);
    expect(isAllowedOrigin({ publicOrigin: "https://tianshu.example" } as AppEnv, "http://localhost:3400")).toBe(false);
  });

  it("sunm 口令不是 8989、被锁或要求改口令时重置；已经可用就不动会话版本", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const q = db.query.bind(db);
      const now = at("2026-10-21T02:00:00Z");
      await ensureLocalDevLogin(q, now);
      expect(await verifyCredentials(q, findPerson, "sunm", "8989", now)).toMatchObject({ kind: "verified", row: { must_change: false } });
      const version = await currentSessionVersion(q, "sun-mingze");
      await ensureLocalDevLogin(q, now);
      expect(await currentSessionVersion(q, "sun-mingze")).toBe(version);
      await setMemberAccess(q, { personId: "sun-mingze", loginId: "sunm", passcode: "2580", mustChange: true });
      await ensureLocalDevLogin(q, now);
      expect(await verifyCredentials(q, findPerson, "sunm", "8989", now)).toMatchObject({ kind: "verified", row: { must_change: false } });
      for (let i = 0; i < LOCK_AFTER_FAILURES; i++) await verifyCredentials(q, findPerson, "sunm", "0001", now);
      await ensureLocalDevLogin(q, now);
      expect(await verifyCredentials(q, findPerson, "sunm", "8989", now)).toMatchObject({ kind: "verified" });
    });
  });
});
