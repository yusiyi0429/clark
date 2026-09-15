/**
 * 一人一条链接的签名。**这一层只回答「这个 personId 是我签过的吗」** ——
 * 「他是不是 DRI」要拿 personId 去对象库里解（store.ts 的 resolveDriActor），
 * 因为 proxy 那一层不该把整份种子拖进 bundle。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { personIdFromToken, signPersonId } from "./identity";

const KEEP = process.env.TKOS_ACCESS_SECRET;

beforeEach(() => {
  process.env.TKOS_ACCESS_SECRET = "s3cr3t-for-test";
});
afterEach(() => {
  if (KEEP === undefined) delete process.env.TKOS_ACCESS_SECRET;
  else process.env.TKOS_ACCESS_SECRET = KEEP;
});

describe("signPersonId / personIdFromToken", () => {
  it("签出来的能解回同一个 personId", () => {
    const token = signPersonId("PSN-06");
    expect(token).toBeTruthy();
    expect(token).toContain("PSN-06.");
    expect(personIdFromToken(token!)).toBe("PSN-06");
  });

  it("改一个字就解不出来", () => {
    const token = signPersonId("PSN-06")!;
    expect(personIdFromToken(`${token}x`)).toBeNull();
    // 换 personId 保签名 —— 这是最想挡住的那一种伪造。
    expect(personIdFromToken(token.replace("PSN-06", "PSN-01"))).toBeNull();
  });

  it("换了密钥，旧链接全部失效（这就是唯一的撤销手段）", () => {
    const token = signPersonId("PSN-06")!;
    process.env.TKOS_ACCESS_SECRET = "rotated";
    expect(personIdFromToken(token)).toBeNull();
  });

  it("没配密钥时签不出也解不出，不回落成放行", () => {
    delete process.env.TKOS_ACCESS_SECRET;
    expect(signPersonId("PSN-06")).toBeNull();
    expect(personIdFromToken("PSN-06.whatever")).toBeNull();
  });

  it("形状不对的一律 null，不抛", () => {
    expect(personIdFromToken(undefined)).toBeNull();
    expect(personIdFromToken("")).toBeNull();
    expect(personIdFromToken("没有点")).toBeNull();
    expect(personIdFromToken(".mac")).toBeNull();
    // personId 里放路径分隔符：签的时候就该拒。
    expect(signPersonId("../../etc")).toBeNull();
  });
});
