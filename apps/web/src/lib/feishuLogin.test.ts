import { describe, expect, it, vi } from "vitest";
import { inFeishuClient, requestFeishuCode } from "./feishuLogin";

const ready = { ready: (callback: () => void) => callback() };

describe("飞书免登", () => {
  it("按 UA 识别飞书客户端", () => {
    expect(inFeishuClient("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Lark/7.30.5 LarkLocale/zh_CN ChannelName/Feishu")).toBe(true);
    expect(inFeishuClient("Mozilla/5.0 (iPhone) Mobile/15E148 Feishu/7.30")).toBe(true);
    expect(inFeishuClient("Mozilla/5.0 (Windows NT 10.0) Chrome/141.0 Safari/537.36")).toBe(false);
  });

  it("h5sdk.ready 后调 requestAccess 取 code", async () => {
    const requestAccess = vi.fn((options: { appID: string; success: (res: { code: string }) => void }) => options.success({ code: "access-code" }));
    await expect(requestFeishuCode({ h5sdk: ready, tt: { requestAccess } } as never, "cli_x")).resolves.toBe("access-code");
    expect(requestAccess.mock.calls[0][0]).toMatchObject({ appID: "cli_x", scopeList: [] });
  });

  it("requestAccess 的 scopeList 用服务端给的用户权限，去掉 offline_access", async () => {
    const requestAccess = vi.fn((options: { success: (res: { code: string }) => void }) => options.success({ code: "access-code" }));
    const scopes = ["offline_access", "minutes:minutes:readonly", "vc:meeting:readonly"];
    await requestFeishuCode({ h5sdk: ready, tt: { requestAccess } } as never, "cli_x", scopes);
    expect(requestAccess.mock.calls[0][0]).toMatchObject({ scopeList: ["minutes:minutes:readonly", "vc:meeting:readonly"] });
  });

  it("客户端太旧（errno 103）或没有 requestAccess 时退回 requestAuthCode", async () => {
    const requestAuthCode = vi.fn((options: { appId: string; success: (res: { code: string }) => void }) => options.success({ code: "legacy-code" }));
    const tooOld = vi.fn((options: { fail: (err: { errno: number }) => void }) => options.fail({ errno: 103 }));
    await expect(requestFeishuCode({ h5sdk: ready, tt: { requestAccess: tooOld, requestAuthCode } } as never, "cli_x")).resolves.toBe("legacy-code");
    await expect(requestFeishuCode({ h5sdk: ready, tt: { requestAuthCode } } as never, "cli_x")).resolves.toBe("legacy-code");
    expect(requestAuthCode.mock.calls[0][0]).toMatchObject({ appId: "cli_x" });
    const declined = vi.fn((options: { fail: (err: { errno: number }) => void }) => options.fail({ errno: 2 }));
    await expect(requestFeishuCode({ h5sdk: ready, tt: { requestAccess: declined, requestAuthCode } } as never, "cli_x")).rejects.toThrow("飞书授权没有完成");
  });
});
