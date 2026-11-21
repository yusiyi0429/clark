import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ toString: () => "" }) }));
vi.mock("@/lib/api/server", () => ({ readSession: async () => ({ role: "member" }), requireMember: async () => undefined }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`redirect:${to}`); } }));

const land = async (params: Record<string, string>) => {
  const { default: Page } = await import("./page");
  return Page({ searchParams: Promise.resolve(params) }).catch((error: Error) => error.message);
};

describe("进门的那一下（19.4）：/me 转到新首页", () => {
  it("从登录页进来的 ?_entry=unlock 带到 /me/work，新首页据此淡入；平时直接打开不带", async () => {
    expect(await land({ _entry: "unlock" })).toBe("redirect:/me/work?_entry=unlock");
    expect(await land({})).toBe("redirect:/me/work");
  });
});
