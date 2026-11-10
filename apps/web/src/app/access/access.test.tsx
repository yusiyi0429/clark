import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AccessScreen, landingPath, loginFailureCopy } from "./AccessScreen";
import { loginDestination, validNextPath, onboardingDestination } from "@/lib/access-paths";

describe("登录页", () => {
  it("失败说明：ID 或口令不对；锁定与改口令用服务端原话；限流、来源不符、其他", () => {
    expect(loginFailureCopy(401)).toBe("ID 或口令不对");
    expect(loginFailureCopy(423, "已连续输错 5 次，请 15 分钟后再试")).toBe("已连续输错 5 次，请 15 分钟后再试");
    expect(loginFailureCopy(400, "新口令不能和当前口令相同")).toBe("新口令不能和当前口令相同");
    expect(loginFailureCopy(429)).toBe("尝试次数过多，请一分钟后再试");
    expect(loginFailureCopy(403)).toBe("请从正式访问地址打开天枢");
    expect(loginFailureCopy(500)).toBe("暂时无法验证");
  });

  it("登录后去哪：成员只去 /me 下的页面，CEO 从 /me 来的回首页", () => {
    expect(landingPath("member", "/")).toBe("/me?_entry=unlock");
    expect(landingPath("member", "/radar")).toBe("/me?_entry=unlock");
    expect(landingPath("member", "/me/tasks/1")).toBe("/me/tasks/1");
    // 锁屏、登录过期后回新首页也算进门（19.4 淡入）；新首页里别的页不算。
    expect(landingPath("member", "/me/work")).toBe("/me/work?_entry=unlock");
    expect(landingPath("member", "/me/work/settings/preferences")).toBe("/me/work/settings/preferences");
    expect(landingPath("ceo", "/")).toBe("/?_entry=unlock");
    expect(landingPath("ceo", "/me")).toBe("/?_entry=unlock");
    expect(landingPath("ceo", "/radar")).toBe("/radar");
  });

  it("存储读取前只有天枢标志，不先闪出完整表单；新首页的样子：没有晨光、锁和时钟，深色跟着外观走", () => {
    const html = renderToStaticMarkup(<AccessScreen nextPath="/" />);
    expect(html).not.toContain('id="access-id"');
    expect(html).not.toContain("你的 ID");
    expect(html).not.toContain('aria-label="口令第 1 位"');
    expect(html).toContain("data-tianshu-mark");
    expect(html).not.toContain("data-morning-canvas");
    expect(html).not.toContain("--:--");
    expect(html).toContain('data-scheme="auto"');
  });

  it("没看过引导时恢复有效深链；老 API 未返回标记时直接进入", () => {
    expect(loginDestination("ceo", "/plans/2026-10", false)).toBe("/welcome?next=%2Fplans%2F2026-10");
    expect(loginDestination("member", undefined, false)).toBe("/welcome");
    expect(loginDestination("ceo", "/radar")).toBe("/radar");
    expect(onboardingDestination("ceo", undefined, "/plans/2026-10")).toBe("/plans/2026-10");
    expect(onboardingDestination("ceo", "/radar?tab=all", "/plans/2026-10")).toBe("/radar?tab=all");
    expect(onboardingDestination("member", "/plans/2026-10", "/me")).toBe("/me?_entry=unlock");
  });

  it("只恢复该角色的站内工作路径，不允许外链或引导循环", () => {
    for (const path of ["https://evil.example", "//evil.example", "/\\evil.example", "/%5cevil.example", "/access", "/welcome?next=/", "/api/auth/logout", "/me"]) {
      expect(validNextPath("ceo", path)).toBeNull();
    }
    expect(validNextPath("member", "/me?tab=items")).toBe("/me?tab=items");
  });
});
