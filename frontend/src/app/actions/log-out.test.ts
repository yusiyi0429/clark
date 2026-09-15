import { beforeEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ACCESS_COOKIE_NAME } from "@/lib/access";
import { WHO_COOKIE_NAME } from "@/lib/identity";
import { logOut } from "./log-out";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

describe("logOut", () => {
  beforeEach(() => vi.clearAllMocks());

  it("清掉两种身份凭据并回到登录页", async () => {
    const remove = vi.fn();
    vi.mocked(cookies).mockResolvedValue({ delete: remove } as never);

    await logOut();

    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenNthCalledWith(1, ACCESS_COOKIE_NAME);
    expect(remove).toHaveBeenNthCalledWith(2, WHO_COOKIE_NAME);
    expect(redirect).toHaveBeenCalledWith("/access");
  });
});
