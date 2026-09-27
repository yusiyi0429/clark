import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), notFound: vi.fn(() => { throw new Error("NEXT_404"); }), redirect: vi.fn((href: string) => { throw new Error(`NEXT_REDIRECT:${href}`); }) }));
vi.mock("@/lib/api/client", () => ({ serverApi: { GET: api.get } }));
vi.mock("next/navigation", () => ({ notFound: api.notFound, redirect: api.redirect }));
import { loadMemberBattlefield } from "./loadMemberBattlefield";

beforeEach(() => vi.clearAllMocks());

describe("成员战场详情服务端读取", () => {
  it("携带成员 cookie 读取详情，不借用 CEO 战场接口", async () => {
    const data = { battlefield: { id: "01", name: "灯塔战场" } };
    api.get.mockResolvedValue({ response: { ok: true, status: 200 }, data });
    expect(await loadMemberBattlefield("session=test", "01")).toEqual(data);
    expect(api.get).toHaveBeenCalledWith("/api/me/battlefields/{id}", { params: { path: { id: "01" } }, headers: { cookie: "session=test" } });
  });

  it.each([404, 403])("不可见战场 %s 进入 404，不显示权限或存在性细节", async (status) => {
    api.get.mockResolvedValue({ response: { ok: false, status } });
    await expect(loadMemberBattlefield("session=test", "hidden")).rejects.toThrow("NEXT_404");
  });

  it("登录失效返回锁屏并保留真实深链", async () => {
    api.get.mockResolvedValue({ response: { ok: false, status: 401 } });
    await expect(loadMemberBattlefield("session=test", "01")).rejects.toThrow("NEXT_REDIRECT:/access?next=%2Fme%2Fbattlefields%2F01");
  });

  it("服务失败不能伪装成没有登记", async () => {
    api.get.mockResolvedValue({ response: { ok: false, status: 503 } });
    await expect(loadMemberBattlefield("session=test", "01")).rejects.toThrow("503");
    expect(api.notFound).not.toHaveBeenCalled();
  });
});
