import { describe, expect, it } from "vitest";
import { maskSecrets, secretLines } from "../src/secretPatterns.js";

const KEY_BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nq1w2e3r4t5y6u7i8o9p0asdfghjklzxcvbnm1234567890QWERTY";

describe("出去之前遮密钥（maskSecrets）", () => {
  it("私钥整段遮掉：BEGIN 到 END 之间的正文和 END 行都不留", () => {
    const text = `部署前放好钥匙\n-----BEGIN RSA PRIVATE KEY-----\n${KEY_BODY}\n-----END RSA PRIVATE KEY-----\n然后重启`;
    const masked = maskSecrets(text);
    expect(masked).not.toContain("MIIEvQ");
    expect(masked).not.toContain("QWERTY");
    expect(masked).not.toContain("END RSA PRIVATE KEY");
    expect(masked.startsWith("部署前放好钥匙\n")).toBe(true);
    expect(masked.endsWith("\n然后重启")).toBe(true);
  });
  it("私钥没有 END 行：遮到文末", () => {
    const masked = maskSecrets(`钥匙：\n-----BEGIN OPENSSH PRIVATE KEY-----\n${KEY_BODY}`);
    expect(masked.startsWith("钥匙：\n")).toBe(true);
    expect(masked).not.toContain("MIIEvQ");
    expect(masked).not.toContain("QWERTY");
  });
  it("两段私钥各自遮掉，中间的话留着", () => {
    const block = (name: string) => `-----BEGIN PRIVATE KEY-----\n${name}SECRETBODY\n-----END PRIVATE KEY-----`;
    const masked = maskSecrets(`${block("A")}\n中间的话\n${block("B")}`);
    expect(masked).toContain("中间的话");
    expect(masked).not.toContain("SECRETBODY");
  });
  it("连接串里的密码遮掉，用户名、主机照留", () => {
    const masked = maskSecrets("库在 postgres://deploy:Hunter2pass@db.internal:5432/tianshu 上");
    expect(masked).not.toContain("Hunter2pass");
    expect(masked).toContain("postgres://deploy:");
    expect(masked).toContain("@db.internal:5432/tianshu 上");
  });
  it("键名以 SECRET、TOKEN、PASSWORD、KEY 结尾的赋值：值遮掉", () => {
    const masked = maskSecrets("FEISHU_APP_SECRET=abc123def456\nINTERNAL_CHAT_TOKEN=tok-998877\nDB_PASSWORD='p@ss w0rd'\nPI_API_KEY=xyz789qwe");
    for (const value of ["abc123def456", "tok-998877", "p@ss", "xyz789qwe"]) expect(masked, value).not.toContain(value);
    for (const key of ["FEISHU_APP_SECRET=", "INTERNAL_CHAT_TOKEN=", "DB_PASSWORD=", "PI_API_KEY="]) expect(masked).toContain(key);
  });
  it("Bearer eyJ… 的令牌遮掉", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZXBsb3kifQ.c2lnbmF0dXJlX3BhcnQ";
    const masked = maskSecrets(`curl -H "Authorization: Bearer ${jwt}" https://api`);
    expect(masked).not.toContain("eyJzdWIiOiJkZXBsb3kifQ");
    expect(masked).not.toContain("c2lnbmF0dXJlX3BhcnQ");
    expect(masked).toContain("Authorization: Bearer ");
    expect(masked).toContain("\" https://api");
  });
  it("普通文字不误遮", () => {
    const plain = ["部署前看 https://example.com:8080/docs 和 https://site.com/@team", "KEYBOARD=1、MONKEY=2、token 用完了", "Bearer 令牌在设置页领",
      "SECRET 不要写进文档；PASSWORD= 留空", "邮件发 dev@example.com"].join("\n");
    expect(maskSecrets(plain)).toBe(plain);
  });
  it("存之前的凭据检查照旧：只认原来那几样，私钥只报 BEGIN 那一行", () => {
    const text = `-----BEGIN RSA PRIVATE KEY-----\n${KEY_BODY}\n-----END RSA PRIVATE KEY-----\npostgres://u:pw@h/db\nAPP_SECRET=abc123\nBearer eyJabc.def`;
    expect(secretLines(text)).toEqual([{ line: 1, sample: "-----B••••" }]);
  });
});
