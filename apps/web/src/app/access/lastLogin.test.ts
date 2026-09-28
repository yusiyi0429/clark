import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logout } from "@/lib/logout";
import { clearLastLogin, readLastLogin, rememberLastLogin, saveLastLogin } from "./lastLogin";

const key = "tianshu.lastLogin";
const account = { loginId: "linx", displayName: "林晓" };

describe("记住登录 ID", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: vi.fn((name: string) => values.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => { values.set(name, value); }),
    removeItem: vi.fn((name: string) => { values.delete(name); }),
  };
  const replace = vi.fn();

  beforeEach(() => {
    values.clear();
    vi.clearAllMocks();
    vi.stubGlobal("window", { localStorage: storage, location: { replace } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("只保存 ID 和显示名；切换账号清掉记住的 ID", () => {
    saveLastLogin(account);
    expect(values.get(key)).toBe(JSON.stringify(account));
    expect(readLastLogin()).toEqual(account);
    clearLastLogin();
    expect(readLastLogin()).toBeNull();
  });

  it("会话确认成功后才从 session 的显示名写入", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ authenticated: true, displayName: "林晓" }) });
    vi.stubGlobal("fetch", fetch);
    await rememberLastLogin("linx");
    expect(fetch).toHaveBeenCalledWith("/api/auth/session");
    expect(values.get(key)).toBe(JSON.stringify(account));
  });

  it("会话未认证、读取失败时不写入", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ authenticated: false, displayName: "林晓" }) })
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetch);
    await rememberLastLogin("wrong-id");
    await rememberLastLogin("wrong-id");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("存储不可用或内容损坏时回到完整表单所需的空状态", () => {
    values.set(key, "not json");
    expect(readLastLogin()).toBeNull();
    vi.stubGlobal("window", { localStorage: { getItem: () => { throw new Error("disabled"); }, setItem: () => { throw new Error("disabled"); }, removeItem: () => { throw new Error("disabled"); } } });
    expect(readLastLogin()).toBeNull();
    expect(() => saveLastLogin(account)).not.toThrow();
    expect(() => clearLastLogin()).not.toThrow();
  });

  it("退出登录保留本机记住的账号", async () => {
    values.set(key, JSON.stringify(account));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    await logout();
    expect(readLastLogin()).toEqual(account);
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith("/access");
  });
});
