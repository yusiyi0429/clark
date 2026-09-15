import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GraphKnowledgeClient, gkSettings } from "./client";
import { GraphKnowledgeUnavailable } from "./errors";

const KEYS = [
  "TKOS_GRAPHKNOWLEDGE_BASE_URL",
  "TKOS_GRAPHKNOWLEDGE_AUTH",
  "TKOS_GRAPHKNOWLEDGE_VERIFY_TLS",
  "TKOS_GRAPHKNOWLEDGE_MOCK",
  "TKOS_GRAPHKNOWLEDGE_VIEWER",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("gkSettings", () => {
  it("什么都没配时给出空地址与默认 viewer，且不抛异常", () => {
    const s = gkSettings();
    expect(s.baseUrl).toBe("");
    expect(s.auth).toBeNull();
    expect(s.verifyTls).toBe(true);
    expect(s.viewer).toBe("PSN-01");
  });

  it("地址末尾的斜杠去掉 —— 否则拼出来是 //api/v1/...", () => {
    process.env.TKOS_GRAPHKNOWLEDGE_BASE_URL = "https://example.test/graph//";
    expect(gkSettings().baseUrl).toBe("https://example.test/graph");
  });

  it("AUTH 不是 user:password 形式时按未配置处理，并留下告警", () => {
    process.env.TKOS_GRAPHKNOWLEDGE_AUTH = "只有用户名";
    const s = gkSettings();
    expect(s.auth).toBeNull();
    expect(s.warnings.join()).toContain("user:password");
  });

  it("拆 AUTH 只按第一个冒号切 —— 密码里可以有冒号", () => {
    process.env.TKOS_GRAPHKNOWLEDGE_AUTH = "reader:a:b:c";
    expect(gkSettings().auth).toEqual({ user: "reader", password: "a:b:c" });
  });

  it("关掉 TLS 校验必须留告警 —— 不能变成一个没人记得的开关", () => {
    process.env.TKOS_GRAPHKNOWLEDGE_VERIFY_TLS = "0";
    const s = gkSettings();
    expect(s.verifyTls).toBe(false);
    expect(s.warnings.join()).toContain("不防中间人");
  });

  it("MOCK=1 本轮没实现，要说出来而不是假装图谱是假的", () => {
    process.env.TKOS_GRAPHKNOWLEDGE_MOCK = "1";
    expect(gkSettings().warnings.join()).toContain("本轮未实现");
  });
});

describe("GraphKnowledgeClient", () => {
  it("没配地址时说「地址是空的」，而不是报一个像服务掉了的底层错", async () => {
    const client = new GraphKnowledgeClient(gkSettings());
    await expect(client.entity("ISS-D6")).rejects.toThrow(GraphKnowledgeUnavailable);
    await expect(client.entity("ISS-D6")).rejects.toThrow(/地址是空的/);
  });
});
