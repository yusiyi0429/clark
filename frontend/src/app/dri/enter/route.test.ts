/**
 * DRI 进门链接的签名校验与 cookie 落地。
 *
 * 这是 DRI 进来的唯一入口，所以签名校验和 cookie 参数必须有测试覆盖。
 * 不 mock `@/lib/identity` —— 签名校验就是这个路由要验的东西。
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { GET } from "./route";
import { signPersonId, WHO_COOKIE_NAME, WHO_COOKIE_MAX_AGE } from "@/lib/identity";

const KEEP = process.env.TKOS_ACCESS_SECRET;

beforeEach(() => {
  process.env.TKOS_ACCESS_SECRET = "test-secret-for-dri-enter";
});

afterEach(() => {
  if (KEEP === undefined) delete process.env.TKOS_ACCESS_SECRET;
  else process.env.TKOS_ACCESS_SECRET = KEEP;
});

describe("GET /dri/enter", () => {
  it("有效 token → 落 cookie + 重定向到 /dri", async () => {
    const token = signPersonId("PSN-06")!;
    const req = new Request(`http://localhost/dri/enter?t=${token}`);
    const res = await GET(req);

    // 重定向到 /dri
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toBe("http://localhost/dri");

    // 检查 cookie 参数
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain(`${WHO_COOKIE_NAME}=${token}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain(`Max-Age=${WHO_COOKIE_MAX_AGE}`);
    // 本地 http 不带 x-forwarded-proto，secure 不应该出现
    expect(setCookie).not.toContain("Secure");
  });

  it("x-forwarded-proto: https 时 secure 为 true", async () => {
    const token = signPersonId("PSN-06")!;
    const req = new Request(`http://localhost/dri/enter?t=${token}`, {
      headers: { "x-forwarded-proto": "https" },
    });
    const res = await GET(req);

    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("Secure");
  });

  it("签名被篡改 → 401，且一个 cookie 都没落", async () => {
    const token = signPersonId("PSN-06")!;
    const tampered = token + "x"; // 篡改签名
    const req = new Request(`http://localhost/dri/enter?t=${tampered}`);
    const res = await GET(req);

    expect(res.status).toBe(401);
    expect(await res.text()).toContain("这条链接无效或已过期");

    // 重点：没有落任何 cookie
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeNull();
  });

  it("换 personId 保留签名 → 401，没落 cookie", async () => {
    const token = signPersonId("PSN-06")!;
    // 这是最想挡住的伪造方式：把自己的 MAC 贴到别人的 personId 上
    const forged = token.replace("PSN-06", "PSN-01");
    const req = new Request(`http://localhost/dri/enter?t=${forged}`);
    const res = await GET(req);

    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("不带 t 参数 → 401", async () => {
    const req = new Request("http://localhost/dri/enter");
    const res = await GET(req);

    expect(res.status).toBe(401);
    expect(await res.text()).toContain("这条链接无效或已过期");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("t 参数是空字符串 → 401", async () => {
    const req = new Request("http://localhost/dri/enter?t=");
    const res = await GET(req);

    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("已经带着有效 cookie 的人再点一次链接 → 仍然正常落 cookie", async () => {
    const token = signPersonId("PSN-06")!;
    // 模拟已经有 cookie 的情况（虽然 GET handler 不检查既有 cookie，但确认不会报错）
    const req = new Request(`http://localhost/dri/enter?t=${token}`, {
      headers: { cookie: `${WHO_COOKIE_NAME}=${token}` },
    });
    const res = await GET(req);

    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toBe("http://localhost/dri");

    // 仍然落 cookie（刷新有效期）
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain(`${WHO_COOKIE_NAME}=${token}`);
  });

  it("密钥轮换后旧链接失效", async () => {
    const token = signPersonId("PSN-06")!;

    // 轮换密钥
    process.env.TKOS_ACCESS_SECRET = "rotated-secret";

    const req = new Request(`http://localhost/dri/enter?t=${token}`);
    const res = await GET(req);

    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
