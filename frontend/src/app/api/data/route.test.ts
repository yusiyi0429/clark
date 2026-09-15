/**
 * RPC 入口的身份验证与授权。
 *
 * 测三条路径：
 *   1. 一号位的共享口令 → CEO_ACTOR → 放行
 *   2. DRI 的签名 cookie → resolveDriActor → 按表查权限
 *   3. 没身份 / 解不出 DRI / 方法不在权限内 → 拒
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";

import { POST } from "./route";

// Mock dependencies
vi.mock("next/headers");
vi.mock("@/lib/access");
vi.mock("@/lib/identity");
vi.mock("@/lib/data/store");

const mockCookies = vi.mocked(cookies);

// cookies() 的返回类型包装：只需要用到的 get 方法
type CookieStore = Awaited<ReturnType<typeof cookies>>;

describe("/api/data POST", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("身份解析", () => {
    it("两个 cookie 都没有 → 401", async () => {
      mockCookies.mockResolvedValue({
        get: vi.fn().mockReturnValue(undefined),
      } as unknown as CookieStore);

      const { isAccessCookieValid } = await import("@/lib/access");
      vi.mocked(isAccessCookieValid).mockReturnValue(false);

      const req = new Request("http://localhost/api/data", {
        method: "POST",
        body: JSON.stringify({ method: "getViewer", args: [] }),
      });

      const res = await POST(req);
      expect(res.status).toBe(401);
      const payload = await res.json();
      expect(payload).toEqual({ ok: false, error: "没有身份。" });
    });

    it("tkos_who 签名被篡改 → 401", async () => {
      mockCookies.mockResolvedValue({
        get: vi.fn((name) => {
          if (name === "tkos_demo_access") return undefined;
          if (name === "tkos_who") return { value: "PSN-06.tampered" };
          return undefined;
        }),
      } as unknown as CookieStore);

      const { isAccessCookieValid } = await import("@/lib/access");
      vi.mocked(isAccessCookieValid).mockReturnValue(false);

      const { personIdFromToken } = await import("@/lib/identity");
      vi.mocked(personIdFromToken).mockReturnValue(null); // 签名验证失败

      const req = new Request("http://localhost/api/data", {
        method: "POST",
        body: JSON.stringify({ method: "getViewer", args: [] }),
      });

      const res = await POST(req);
      expect(res.status).toBe(401);
    });

    it("personId 有效但不在名册里 → 401", async () => {
      mockCookies.mockResolvedValue({
        get: vi.fn((name) => {
          if (name === "tkos_demo_access") return undefined;
          if (name === "tkos_who") return { value: "PSN-UNKNOWN.validmac" };
          return undefined;
        }),
      } as unknown as CookieStore);

      const { isAccessCookieValid } = await import("@/lib/access");
      vi.mocked(isAccessCookieValid).mockReturnValue(false);

      const { personIdFromToken } = await import("@/lib/identity");
      vi.mocked(personIdFromToken).mockReturnValue("PSN-UNKNOWN");

      const { resolveDriActor } = await import("@/lib/data/store");
      vi.mocked(resolveDriActor).mockReturnValue(null); // 名册里找不到

      const req = new Request("http://localhost/api/data", {
        method: "POST",
        body: JSON.stringify({ method: "getViewer", args: [] }),
      });

      const res = await POST(req);
      expect(res.status).toBe(401);
    });
  });

  describe("权限检查", () => {
    it("DRI 调用 ceo 方法 → 403", async () => {
      mockCookies.mockResolvedValue({
        get: vi.fn((name) => {
          if (name === "tkos_demo_access") return undefined;
          if (name === "tkos_who") return { value: "PSN-06.validmac" };
          return undefined;
        }),
      } as unknown as CookieStore);

      const { isAccessCookieValid } = await import("@/lib/access");
      vi.mocked(isAccessCookieValid).mockReturnValue(false);

      const { personIdFromToken } = await import("@/lib/identity");
      vi.mocked(personIdFromToken).mockReturnValue("PSN-06");

      const { resolveDriActor } = await import("@/lib/data/store");
      vi.mocked(resolveDriActor).mockReturnValue({ personId: "PSN-06", role: "dri" });

      const req = new Request("http://localhost/api/data", {
        method: "POST",
        body: JSON.stringify({ method: "resetDemo", args: [] }), // ceo-only method
      });

      const res = await POST(req);
      expect(res.status).toBe(403);
      const payload = await res.json();
      expect(payload).toEqual({
        ok: false,
        error: "这个动作不在你这一侧。",
        kind: "forbidden",
      });
    });

    it("一号位调用任何方法 → 放行", async () => {
      mockCookies.mockResolvedValue({
        get: vi.fn((name) => {
          if (name === "tkos_demo_access") return { value: "valid_ceo_cookie" };
          return undefined;
        }),
      } as unknown as CookieStore);

      const { isAccessCookieValid } = await import("@/lib/access");
      vi.mocked(isAccessCookieValid).mockReturnValue(true);

      const { api, persistSoon } = await import("@/lib/data/store");
      const actorModule = await import("@/lib/data/actor");

      const mockGetViewer = vi.fn<typeof api.getViewer>().mockResolvedValue({ id: "PSN-01", name: "刘明华", role: "ceo", title: "一号位" });
      vi.mocked(api).getViewer = mockGetViewer;
      vi.mocked(persistSoon).mockReturnValue(undefined);
      vi.spyOn(actorModule, "runAsActor").mockImplementation(async (actor, fn) => fn());

      const req = new Request("http://localhost/api/data", {
        method: "POST",
        body: JSON.stringify({ method: "getViewer", args: [] }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.ok).toBe(true);
      expect(mockGetViewer).toHaveBeenCalled();
    });

    it("DRI 调用 both 方法 → 放行", async () => {
      mockCookies.mockResolvedValue({
        get: vi.fn((name) => {
          if (name === "tkos_demo_access") return undefined;
          if (name === "tkos_who") return { value: "PSN-06.validmac" };
          return undefined;
        }),
      } as unknown as CookieStore);

      const { isAccessCookieValid } = await import("@/lib/access");
      vi.mocked(isAccessCookieValid).mockReturnValue(false);

      const { personIdFromToken } = await import("@/lib/identity");
      vi.mocked(personIdFromToken).mockReturnValue("PSN-06");

      const { resolveDriActor, api, persistSoon } = await import("@/lib/data/store");
      vi.mocked(resolveDriActor).mockReturnValue({ personId: "PSN-06", role: "dri" });

      const actorModule = await import("@/lib/data/actor");

      const mockGetViewer = vi.fn<typeof api.getViewer>().mockResolvedValue({ id: "PSN-06", name: "某 DRI", role: "dri", title: "DRI" });
      vi.mocked(api).getViewer = mockGetViewer;
      vi.mocked(persistSoon).mockReturnValue(undefined);
      vi.spyOn(actorModule, "runAsActor").mockImplementation(async (actor, fn) => fn());

      const req = new Request("http://localhost/api/data", {
        method: "POST",
        body: JSON.stringify({ method: "getViewer", args: [] }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.ok).toBe(true);
    });
  });

  describe("边界情况", () => {
    it("方法名不在白名单里 → 400", async () => {
      const req = new Request("http://localhost/api/data", {
        method: "POST",
        body: JSON.stringify({ method: "notExists", args: [] }),
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.error).toContain("未知方法");
    });

    it("方法名是 today（常量）→ 400", async () => {
      const req = new Request("http://localhost/api/data", {
        method: "POST",
        body: JSON.stringify({ method: "today", args: [] }),
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("方法名是原型链键 __proto__ → 400", async () => {
      const req = new Request("http://localhost/api/data", {
        method: "POST",
        body: JSON.stringify({ method: "__proto__", args: [] }),
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("args 不是数组 → 400", async () => {
      const req = new Request("http://localhost/api/data", {
        method: "POST",
        body: JSON.stringify({ method: "getViewer", args: "not-array" }),
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.error).toBe("args 必须是数组。");
    });
  });

  describe("服务端意外出错时的错误处理", () => {
    it("方法抛出普通 Error → HTTP 500 且响应里的 error 是固定中文，不含原始错误信息", async () => {
      mockCookies.mockResolvedValue({
        get: vi.fn((name) => {
          if (name === "tkos_demo_access") return { value: "valid_ceo_cookie" };
          return undefined;
        }),
      } as unknown as CookieStore);

      const { isAccessCookieValid } = await import("@/lib/access");
      vi.mocked(isAccessCookieValid).mockReturnValue(true);

      const { api, persistSoon } = await import("@/lib/data/store");
      const actorModule = await import("@/lib/data/actor");

      const originalErrorMessage = "Cannot read properties of undefined (reading 'trim')";
      const mockGetViewer = vi.fn<typeof api.getViewer>().mockRejectedValue(new Error(originalErrorMessage));
      vi.mocked(api).getViewer = mockGetViewer;
      vi.mocked(persistSoon).mockReturnValue(undefined);
      vi.spyOn(actorModule, "runAsActor").mockImplementation(async (actor, fn) => fn());

      // spy console.error：断言原因留在服务端日志里
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const req = new Request("http://localhost/api/data", {
        method: "POST",
        body: JSON.stringify({ method: "getViewer", args: [] }),
      });

      const res = await POST(req);
      expect(res.status).toBe(500);
      const payload = await res.json();
      expect(payload.ok).toBe(false);
      expect(payload.error).toBe("这一步在服务端出错了。原因已经写进服务端日志，不在这句话里。");
      // 断言响应里不含原始英文错误信息
      const responseText = JSON.stringify(payload);
      expect(responseText).not.toContain(originalErrorMessage);
      // 断言 console.error 仍在被调用（原因必须留在服务端日志里）
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });
  });
});
