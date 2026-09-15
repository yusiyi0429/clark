/**
 * 两个区的访问控制。
 *
 * 测试重点：
 *   1. 公开路径不要求任何 cookie（包括 /dri/enter —— 它自己的门是 URL 里的签名）
 *   2. 一号位那把口令开全站，照旧
 *   3. 签名身份只开 DRI 区（/dri/*、/api/data、/api/health）
 *   4. 两个 cookie 都有时，一号位说了算
 *   5. 带 DRI cookie 却敲了一号位的地址 → 302 到 /dri，不是 /access
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

import { proxy } from "./proxy";
import * as access from "@/lib/access";
import * as identity from "@/lib/identity";

const KEEP_SECRET = process.env.TKOS_ACCESS_SECRET;

beforeEach(() => {
  process.env.TKOS_ACCESS_SECRET = "test-secret-for-proxy";
  vi.clearAllMocks();
});

afterEach(() => {
  if (KEEP_SECRET === undefined) delete process.env.TKOS_ACCESS_SECRET;
  else process.env.TKOS_ACCESS_SECRET = KEEP_SECRET;
});

describe("proxy: 公开路径", () => {
  it("没有 cookie 能访问 /access", () => {
    const req = new NextRequest(new URL("http://localhost/access"));
    const res = proxy(req);
    // NextResponse.next() 设置这个内部标记表示放行
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("没有 cookie 能访问 /api/health", () => {
    const req = new NextRequest(new URL("http://localhost/api/health"));
    const res = proxy(req);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("没有 cookie 能访问 /api/signals/inbox（抓取作业的收件口）", () => {
    const req = new NextRequest(new URL("http://localhost/api/signals/inbox"));
    const res = proxy(req);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("没有 cookie 能访问 /api/om/intake（灌纲领）", () => {
    const req = new NextRequest(new URL("http://localhost/api/om/intake"));
    const res = proxy(req);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("没有 cookie 能访问 /dri/enter（进门的唯一入口）", () => {
    const req = new NextRequest(new URL("http://localhost/dri/enter?t=xxx"));
    const res = proxy(req);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("proxy: 一号位那把口令开全站", () => {
  it("一号位 cookie 能访问根路径", () => {
    vi.spyOn(access, "isAccessCookieValid").mockReturnValue(true);
    const req = new NextRequest(new URL("http://localhost/"));
    req.cookies.set("tkos_demo_access", "valid");
    const res = proxy(req);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("一号位 cookie 能访问 /api/data", () => {
    vi.spyOn(access, "isAccessCookieValid").mockReturnValue(true);
    const req = new NextRequest(new URL("http://localhost/api/data"));
    req.cookies.set("tkos_demo_access", "valid");
    const res = proxy(req);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("一号位 cookie 能访问 /dri/*", () => {
    vi.spyOn(access, "isAccessCookieValid").mockReturnValue(true);
    const req = new NextRequest(new URL("http://localhost/dri"));
    req.cookies.set("tkos_demo_access", "valid");
    const res = proxy(req);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("proxy: DRI 签名只开 DRI 区", () => {
  it("DRI cookie 能访问 /dri", () => {
    vi.spyOn(access, "isAccessCookieValid").mockReturnValue(false);
    vi.spyOn(identity, "personIdFromToken").mockReturnValue("PSN-06");

    const req = new NextRequest(new URL("http://localhost/dri"));
    req.cookies.set("tkos_who", "PSN-06.validmac");
    const res = proxy(req);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("DRI cookie 能访问 /api/data", () => {
    vi.spyOn(access, "isAccessCookieValid").mockReturnValue(false);
    vi.spyOn(identity, "personIdFromToken").mockReturnValue("PSN-06");

    const req = new NextRequest(new URL("http://localhost/api/data"));
    req.cookies.set("tkos_who", "PSN-06.validmac");
    const res = proxy(req);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("DRI cookie 能访问 /api/health", () => {
    vi.spyOn(access, "isAccessCookieValid").mockReturnValue(false);
    vi.spyOn(identity, "personIdFromToken").mockReturnValue("PSN-06");

    const req = new NextRequest(new URL("http://localhost/api/health"));
    req.cookies.set("tkos_who", "PSN-06.validmac");
    const res = proxy(req);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("DRI cookie 访问根路径 → 重定向到 /dri", () => {
    vi.spyOn(access, "isAccessCookieValid").mockReturnValue(false);
    vi.spyOn(identity, "personIdFromToken").mockReturnValue("PSN-06");

    const req = new NextRequest(new URL("http://localhost/"));
    req.cookies.set("tkos_who", "PSN-06.validmac");
    const res = proxy(req);
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toBe("http://localhost/dri");
  });

  it("DRI cookie 访问一号位侧的页面 → 重定向到 /dri（不是 /access）", () => {
    vi.spyOn(access, "isAccessCookieValid").mockReturnValue(false);
    vi.spyOn(identity, "personIdFromToken").mockReturnValue("PSN-06");

    const req = new NextRequest(new URL("http://localhost/tkos/judgement/J-001"));
    req.cookies.set("tkos_who", "PSN-06.validmac");
    const res = proxy(req);
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toBe("http://localhost/dri");
  });

  it("DRI cookie 访问 API（不在 DRI 区）→ 401（API 不重定向）", () => {
    vi.spyOn(access, "isAccessCookieValid").mockReturnValue(false);
    vi.spyOn(identity, "personIdFromToken").mockReturnValue("PSN-06");

    const req = new NextRequest(new URL("http://localhost/api/other"));
    req.cookies.set("tkos_who", "PSN-06.validmac");
    const res = proxy(req);
    // API 路径需要明确的错误状态码，不重定向
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("proxy: 两个 cookie 都有时一号位说了算", () => {
  it("同时带两个 cookie，访问任何地方都放行", () => {
    vi.spyOn(access, "isAccessCookieValid").mockReturnValue(true);
    vi.spyOn(identity, "personIdFromToken").mockReturnValue("PSN-06");

    const req = new NextRequest(new URL("http://localhost/"));
    req.cookies.set("tkos_demo_access", "valid");
    req.cookies.set("tkos_who", "PSN-06.validmac");
    const res = proxy(req);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("proxy: 没有任何 cookie", () => {
  it("访问保护区域 → 重定向到 /access", () => {
    vi.spyOn(access, "isAccessCookieValid").mockReturnValue(false);
    vi.spyOn(identity, "personIdFromToken").mockReturnValue(null);

    const req = new NextRequest(new URL("http://localhost/"));
    const res = proxy(req);
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    const location = res.headers.get("location");
    expect(location).toContain("/access");
    expect(location).toContain("next=");
  });

  it("访问 API（不在公开路径）→ 401 JSON", () => {
    vi.spyOn(access, "isAccessCookieValid").mockReturnValue(false);
    vi.spyOn(identity, "personIdFromToken").mockReturnValue(null);

    const req = new NextRequest(new URL("http://localhost/api/other"));
    const res = proxy(req);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("proxy: 签名被篡改", () => {
  it("签名验证失败 → 当作没有身份", () => {
    vi.spyOn(access, "isAccessCookieValid").mockReturnValue(false);
    vi.spyOn(identity, "personIdFromToken").mockReturnValue(null); // 签名无效

    const req = new NextRequest(new URL("http://localhost/dri"));
    req.cookies.set("tkos_who", "PSN-06.tampered");
    const res = proxy(req);
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toContain("/access");
  });
});
