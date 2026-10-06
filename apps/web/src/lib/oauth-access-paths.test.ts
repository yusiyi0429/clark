import { describe, expect, it } from "vitest";
import { loginDestination, validNextPath } from "./access-paths";

describe("OAuth 登录返回", () => {
  const path = "/oauth/consent?request=12345678-1234-1234-1234-123456789abc";
  it("两种身份及未完成引导的用户登录后都回到授权页", () => {
    for (const role of ["ceo", "member"] as const) {
      expect(validNextPath(role, path)).toBe(path);
      expect(loginDestination(role, path, false)).toBe(path);
      expect(loginDestination(role, path, true)).toBe(path);
    }
  });
  it("拒绝外部跳转、重复参数、任意授权子路径和无效请求", () => {
    for (const candidate of ["//evil.example/oauth/consent", "/oauth/consent?request=invalid", `${path}&next=https://evil.example`,
      `${path}&request=12345678-1234-1234-1234-123456789abc`, `${path}#fragment`, "/oauth/consent/extra", "/oauth/consent"])
      expect(validNextPath("member", candidate)).toBeNull();
  });
});
