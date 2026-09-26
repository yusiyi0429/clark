import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AccessScreen, landingPath, loginFailureCopy } from "./AccessScreen";
import { formatLockDate, formatLockTime } from "./lockscreenTime";

describe("锁屏时钟（clark lockscreen-time）", () => {
  const reference = new Date(Date.UTC(2026, 8, 12, 0, 8));

  it("按公司时区格式化时间", () => {
    expect(formatLockTime(reference)).toBe("08:08");
  });

  it("日期写成「9月12日 · 星期六」", () => {
    expect(formatLockDate(reference)).toBe("9月12日 · 星期六");
  });
});

describe("锁屏表单", () => {
  it("失败说明：ID 或口令不对；锁定与改口令用服务端原话；限流、来源不符、其他", () => {
    expect(loginFailureCopy(401)).toBe("ID 或口令不对");
    expect(loginFailureCopy(423, "已连续输错 5 次，请 15 分钟后再试")).toBe("已连续输错 5 次，请 15 分钟后再试");
    expect(loginFailureCopy(400, "新口令不能和当前口令相同")).toBe("新口令不能和当前口令相同");
    expect(loginFailureCopy(429)).toBe("尝试次数过多，请一分钟后再试");
    expect(loginFailureCopy(403)).toBe("请从正式访问地址打开天枢");
    expect(loginFailureCopy(500)).toBe("暂时无法验证");
  });

  it("登录后去哪：成员只去 /me 下的页面，CEO 从 /me 来的回首页", () => {
    expect(landingPath("member", "/")).toBe("/me");
    expect(landingPath("member", "/radar")).toBe("/me");
    expect(landingPath("member", "/me/tasks/1")).toBe("/me/tasks/1");
    expect(landingPath("ceo", "/")).toBe("/?_entry=unlock");
    expect(landingPath("ceo", "/me")).toBe("/?_entry=unlock");
    expect(landingPath("ceo", "/radar")).toBe("/radar");
  });

  it("一个 ID 输入框 + 4 格口令，没有身份滑块；时钟未挂载前占位不跳动", () => {
    const html = renderToStaticMarkup(<AccessScreen nextPath="/" />);
    expect(html).toContain('id="access-id"');
    expect(html).toContain("你的 ID");
    expect(html.match(/aria-label="口令第 \d 位"/g)).toHaveLength(4);
    expect(html).not.toContain('role="radiogroup"');
    expect(html).toContain("--:--");
    expect(html).toContain("tianshu-flow-lock-v3.webp");
  });
});
