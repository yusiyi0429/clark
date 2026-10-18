import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.js";
import { resolveFeishuEnv } from "../src/feishu/config.js";
import { decryptTokenSecret, encryptTokenSecret } from "../src/feishu/crypto.js";
import { loadUserToken, saveAuthorizedToken } from "../src/feishu/tokens.js";
import { createTestDb } from "./helpers.js";

const key = randomBytes(32);

describe("飞书令牌加密", () => {
  it("加解密往返；每次密文不同；换人或换钥匙解不开", () => {
    const secret = { accessToken: "u-access", refreshToken: "ur-refresh" };
    const a = encryptTokenSecret(key, "person-a", secret);
    const b = encryptTokenSecret(key, "person-a", secret);
    expect(a).not.toBe(b);
    expect(a).not.toContain("u-access");
    expect(decryptTokenSecret(key, "person-a", a)).toEqual(secret);
    expect(() => decryptTokenSecret(key, "person-b", a)).toThrow();
    expect(() => decryptTokenSecret(randomBytes(32), "person-a", a)).toThrow();
  });

  it("配置：全不配为关闭，配一半启动失败，密钥必须 32 字节", () => {
    expect(resolveFeishuEnv({})).toBeUndefined();
    expect(() => resolveFeishuEnv({ FEISHU_APP_ID: "cli_x" })).toThrow(/不完整/);
    expect(() => resolveFeishuEnv({ FEISHU_APP_ID: "cli_x", FEISHU_APP_SECRET: "s", FEISHU_TOKEN_KEY: "c2hvcnQ=" })).toThrow(/32 字节/);
    expect(resolveFeishuEnv({ FEISHU_APP_ID: "cli_x", FEISHU_APP_SECRET: "s", FEISHU_TOKEN_KEY: key.toString("base64") }))
      .toMatchObject({ appId: "cli_x", tokenKeyVersion: 1 });
  });

  it("落库只有密文，读出还原；密钥版本不符时报错", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const q = pool.query.bind(pool);
      await q("INSERT INTO feishu_identities (person_id, open_id) VALUES ('person-a', 'ou_a')");
      const now = new Date("2026-10-18T02:00:00Z");
      await saveAuthorizedToken(q, { tokenKey: key, tokenKeyVersion: 1 }, "person-a",
        { accessToken: "u-access", refreshToken: "ur-refresh", expiresIn: 7200, refreshExpiresIn: 604800, scope: "offline_access" }, now);
      const row = (await db.query("SELECT * FROM feishu_user_tokens")).rows[0];
      expect(JSON.stringify(row)).not.toMatch(/u-access|ur-refresh/);
      expect(row).toMatchObject({ key_version: 1, status: "active", access_expires_at: new Date("2026-10-18T04:00:00Z"), refresh_expires_at: new Date("2026-10-25T02:00:00Z") });
      expect(await loadUserToken(q, { tokenKey: key, tokenKeyVersion: 1 }, "person-a")).toMatchObject({ accessToken: "u-access", refreshToken: "ur-refresh" });
      await expect(loadUserToken(q, { tokenKey: key, tokenKeyVersion: 2 }, "person-a")).rejects.toThrow(/密钥版本不符/);
    });
  });
});
