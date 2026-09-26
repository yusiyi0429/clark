import { beforeEach, describe, expect, it, vi } from "vitest";

const { get, cookie } = vi.hoisted(() => ({ get: vi.fn(), cookie: vi.fn(() => "warmap_session=test") }));
vi.mock("./client", () => ({ serverApi: { GET: get } }));
vi.mock("next/headers", () => ({ cookies: async () => ({ toString: cookie }) }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); }, notFound: vi.fn() }));
import { readSession, requireCeo, requireMember } from "./server";

function session(role: "ceo" | "member", onboarded?: boolean) {
  get.mockResolvedValue({ response: { ok: true }, data: { authenticated: true, personId: "person", displayName: "测试", role, onboarded } });
}
beforeEach(() => { get.mockReset(); cookie.mockReturnValue("warmap_session=test"); });

describe("引导会话守卫", () => {
  it("没有登录不读 API，携带目标路径回锁屏", async () => {
    cookie.mockReturnValue("");
    expect(await readSession("")).toBeNull();
    await expect(requireCeo("/radar")).rejects.toThrow("redirect:/access?next=%2Fradar");
    expect(get).not.toHaveBeenCalled();
  });
  it("旧 API 缺少 onboarded 时默认已经看过", async () => {
    session("ceo");
    expect(await readSession("warmap_session=test")).toMatchObject({ onboarded: true });
    expect(await requireCeo("/radar")).toBe("warmap_session=test");
  });
  it("两个角色未完成都在读业务对象前重定向，保留深链", async () => {
    session("ceo", false);
    await expect(requireCeo("/plans/2026-10")).rejects.toThrow("redirect:/welcome?next=%2Fplans%2F2026-10");
    session("member", false);
    await expect(requireMember("/me/settings?tab=voice")).rejects.toThrow("redirect:/welcome?next=%2Fme%2Fsettings%3Ftab%3Dvoice");
  });
  it("已完成不再进入，错误角色仍回自己的工作台", async () => {
    session("member", true);
    expect(await requireMember("/me")).toMatchObject({ session: { onboarded: true } });
    await expect(requireCeo("/radar")).rejects.toThrow("redirect:/me");
    session("ceo", false);
    await expect(requireMember("/me")).rejects.toThrow("redirect:/");
  });
});
