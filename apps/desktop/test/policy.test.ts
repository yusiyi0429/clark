import { describe, expect, it } from "vitest";
import { allowInWindow, grantPermission, openExternally } from "../src/policy";

const p = { origin: "https://tk.tokenkingos.com" };

describe("壳的放行规则", () => {
  it("窗口里只停天枢和飞书登录授权页（11/08 实测的跳转链每一跳都放行）；飞书文档、别的网站、http 的飞书都不放", () => {
    for (const url of [
      "https://tk.tokenkingos.com/", "https://tk.tokenkingos.com/access?next=%2F", "https://tk.tokenkingos.com/api/auth/feishu/callback?code=x&state=y",
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=cli_x", "https://passport.feishu.cn/accounts/page/login?app_id=12",
      "https://login.feishu.cn/accounts/trap?app_id=12", "https://accounts.feishu.cn/accounts/page/login?app_id=12&no_trap=1",
      "https://open.feishu.cn/open-apis/authen/v1/authorize?client_id=cli_x",
    ]) expect(allowInWindow(p, url), url).toBe(true);
    for (const url of [
      "https://abc.feishu.cn/docx/AbCd", "https://example.com/", "http://accounts.feishu.cn/x", "http://tk.tokenkingos.com/",
      "https://tk.tokenkingos.com.evil.com/", "https://evil.com/?u=https://tk.tokenkingos.com", "file:///C:/x", "not a url",
    ]) expect(allowInWindow(p, url), url).toBe(false);
  });

  it("交给系统浏览器的只有 http、https、mailto", () => {
    expect(["https://abc.feishu.cn/docx/AbCd", "http://example.com", "mailto:a@b.com"].every(openExternally)).toBe(true);
    expect(["file:///C:/Windows/System32/calc.exe", "ms-settings:privacy", "javascript:alert(1)", "tianshu://x", "x"].some(openExternally)).toBe(false);
  });

  it("本地网络访问只给天枢页面（检查时 origin 带结尾斜杠也认）；别的权限、别的来源一律不给", () => {
    for (const perm of ["local-network-access", "loopback-network", "local-network"]) {
      expect(grantPermission(p, perm, "https://tk.tokenkingos.com/")).toBe(true);
      expect(grantPermission(p, perm, "https://tk.tokenkingos.com/projects/1")).toBe(true);
      expect(grantPermission(p, perm, "https://accounts.feishu.cn/")).toBe(false);
    }
    for (const perm of ["media", "geolocation", "notifications", "background-sync", "clipboard-read"]) expect(grantPermission(p, perm, "https://tk.tokenkingos.com/")).toBe(false);
  });
});
