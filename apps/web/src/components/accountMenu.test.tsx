import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountMenu, FeishuConnectItem, PasscodeForm, avatarInitial } from "./AccountMenu";

describe("个人菜单（左下角自己的名字）", () => {
  it("头像写名里的第一个字，两个字的名字写头一个", () => {
    expect(avatarInitial("刘明华")).toBe("明");
    expect(avatarInitial("白田")).toBe("白");
    expect(avatarInitial("sean")).toBe("S");
  });

  it("通知栏上是头像加名字的一颗；窄条上只剩头像", () => {
    const chip = renderToStaticMarkup(<AccountMenu account={{ displayName: "孙铭泽", loginId: "sunm", role: "member" }} />);
    expect(chip).toContain('aria-label="孙铭泽，打开个人菜单"');
    expect(chip).toContain(">孙铭泽<");
    const compact = renderToStaticMarkup(<AccountMenu account={{ displayName: "孙铭泽", role: "member" }} compact />);
    expect(compact).not.toContain(">孙铭泽<");
    expect(compact).toContain(">铭<");
  });

  it("接了飞书：没连好是「连接飞书」，连好了只显示「飞书已连接」、点不了", () => {
    const pending = renderToStaticMarkup(<FeishuConnectItem connected={false} />);
    expect(pending).toContain("连接飞书");
    expect(pending).not.toContain("disabled");
    const done = renderToStaticMarkup(<FeishuConnectItem connected />);
    expect(done).toContain("飞书已连接");
    expect(done).toContain("disabled");
  });

  it("修改口令：三个 4 位数字框，没填完不能提交", () => {
    const html = renderToStaticMarkup(<PasscodeForm loginId="sunm" onDone={() => undefined} />);
    expect(html.match(/type="password"/g)).toHaveLength(3);
    expect(html).toContain("当前口令");
    expect(html).toContain("再输一次新口令");
    const submit = html.slice(html.lastIndexOf("<button", html.indexOf("修改口令</button>")), html.indexOf("修改口令</button>"));
    expect(submit).toContain("disabled");
  });
});

describe("一号位视角（巡检 P1-12）", () => {
  it("「一号位」头像写「一」，不写「号」", async () => {
    expect(avatarInitial("一号位")).toBe("一");
  });

  it("演示环境菜单不露登录 ID（democeo）；正式环境照旧", async () => {
    const { accountSubtitle } = await import("./AccountMenu");
    const account = { displayName: "一号位", loginId: "democeo", role: "ceo" as const };
    expect(accountSubtitle(account, true)).toBe("");
    expect(accountSubtitle(account, false)).toBe("democeo · CEO");
  });
});
