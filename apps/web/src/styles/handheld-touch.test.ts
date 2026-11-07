import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** 手机与折叠屏（docs/superpowers/specs/2026-10-12-mobile-foldable.md）：点触下限、手机宽面板的页头、首页确认卡。 */
// 工作区开着 autocrlf：读进来先把 CRLF 统一成 LF，断言里的换行才对得上。
const css = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const TOUCH = "@media (max-width: 959px), (pointer: coarse)";
const TOUCH_MIN = "@media(max-width:959px),(pointer:coarse)";

describe("点触下限：手持与触屏 44，鼠标的电脑不变", () => {
  it("globals 只在手持 / 触屏时定义 --touch-hit: 44px，组件写 var(--touch-hit, 原值)", () => {
    const globals = css("../app/globals.css");
    expect(globals).toContain(`${TOUCH} {\n  :root { --touch-hit: 44px; }\n}`);
    // 不在 :root 默认块里给值：电脑取各组件原尺寸。
    expect(globals.match(/--touch-hit:/g)).toHaveLength(1);
  });

  it("二级页页头的返回、材料钮按 --touch-hit 放大，电脑仍是 32", () => {
    const header = css("./header-capsule.module.css");
    expect(header).toContain("width: var(--touch-hit, 32px);");
    expect(header).toContain("height: var(--touch-hit, 32px);");
    expect(header).toContain(".scope :global(.ts-detail-header > .ts-row > [data-header-tools] > .button) { min-height: var(--touch-hit, 32px); }");
  });

  it("分段切换在手持上不再缩到 28：段高 36、透明热区补到 44", () => {
    const segmented = css("./segmented-switch.module.css");
    expect(segmented).not.toContain("height: 28px");
    expect(segmented).toContain(`${TOUCH} {\n  .segment { position: relative; height: 36px; }\n  .segment::after { content: ''; position: absolute; inset: -4px 0; }\n}`);
    // 战场页「决策 / 战况」也是这颗分段切换，不另设尺寸。
    expect(css("./battlefield-detail.module.css")).not.toContain(".viewSwitch");
  });

  it("个人胶囊是 44 高", () => {
    expect(css("./account-menu.module.css")).toContain(".chip.chip { height: 44px; min-height: 44px; border-radius: 22px;");
  });

  it("对话：输入条的麦克风 / 发送 / 附件 44、频道钮 40 + 热区；全屏对话层的收起钮 44", () => {
    const pill = css("./composer-pill.module.css");
    expect(pill).toContain(`${TOUCH} {\n  .actionButton.actionButton { width: 44px; min-width: 44px; height: 44px; min-height: 44px; }\n  .tool { width: 44px; min-width: 44px; height: 44px; }`);
    expect(pill).toContain(".segment.segment::after { content: ''; position: absolute; inset: -2px 0; }");
    expect(css("./conversation-column.module.css")).toContain(".close.close { top: 6px; right: 6px; width: 44px; min-width: 44px; height: 44px; }");
  });

  it("战场 / 雷达 / 已处理页头的返回（手持左上角）44×44：用标准页头的返回，不再有旧的大页头", () => {
    expect(css("./header-capsule.module.css")).toContain("width: var(--touch-hit, 32px);");
    expect(css("./app-shell.module.css")).not.toContain(".expandedHeader");
  });
});

describe("手机宽的面板：页头不按电脑一行排", () => {
  it("面板 <600（单屏、双屏右页）：返回 · 标题 · 材料 · 动作一行，计划时段在标题上一行，类型切换单独一行", () => {
    const header = css("./header-capsule.module.css");
    const block = header.slice(header.indexOf("@container pane (max-width: 599px) {"));
    expect(block).toContain("grid-template-columns: auto minmax(0, 1fr) auto auto auto;");
    expect(block).toContain("grid-template-areas: 'back lead tools actions end' 'back title tools actions end' 'switch switch switch switch switch';");
    // 标题最多三行、16/21，不再被挤成两行截断的细柱。
    expect(block).toMatch(/-webkit-line-clamp: 3;[\s\S]*font-size: 16px;\s*line-height: 21px;/);
    // 材料钮只留图标（读屏名在 aria-label 里），切换两段等宽。
    expect(block).toContain(".scope :global(.ts-detail-header [data-material-menu] > span:not([aria-hidden])),");
    expect(block).toContain(".scope :global(.ts-detail-header > .ts-row > [data-header-switch] > *) { flex: 1 1 0; justify-content: center; }");
  });

  it("「邀请成员」在手机宽的面板里只留图标、44×44", () => {
    const members = css("./thread-members.module.css");
    expect(members).toContain(".inviteIcon{display:none;flex:none}");
    expect(members).toContain("@container pane (max-width:599px){.invite.invite{justify-content:center;width:44px;min-width:44px;height:44px;");
    expect(members).toContain(".invite .inviteLabel{display:none}");
  });
});

describe("手持字号与首屏", () => {
  it("来源小标签（雷达）在手持上 13（电脑 12）", () => {
    const tag = css("./origin-tag.module.css");
    expect(tag).toContain("font-size:12px;line-height:17px");
    expect(tag).toContain("@media(max-width:959px){.tag{font-size:13px;line-height:18px}}");
  });

  it("矮屏手机（≤740 高）首页时间从 68 缩到 52", () => {
    const notices = css("./notifications.module.css");
    expect(notices).toContain(".railClock time{margin:0;font-size:68px");
    expect(notices).toContain("@media(max-width:599px) and (max-height:740px){.railClock time{font-size:52px}");
  });
});

describe("实测补漏：对话层、会后页、三屏触屏", () => {
  it("手机对话正文 16（原来缩到 14）、小字 14（14.1 三档）", () => {
    expect(css("./conversation-transcript.module.css")).toContain("@media(max-width:959px){.assistant,.user{font-size:16px;line-height:1.75}.meta,.pageTag{font-size:14px}");
  });

  it("会后页「确认 / 忽略」44 高、14 字；角标 13", () => {
    const meeting = css("./meeting-workspace.module.css");
    expect(meeting).toContain(".itemActions button { min-height: var(--touch-hit, 44px); padding: 0 14px; border-radius: 10px; font-size: 14px; }");
    expect(meeting).toContain(".kindBadge, .reviewSection header span { font-size: 13px; }");
  });

  it("触屏的工作台（pointer:coarse）：窄条圆钮、页头关闭键、个人胶囊、议题行补到 44；鼠标的电脑不进这些查询", () => {
    expect(css("./notice-strip.module.css")).toContain("@media(pointer:coarse){.strip button{width:44px;height:44px}}");
    expect(css("./header-capsule.module.css")).toContain("min-height: var(--touch-hit, 32px);");
    expect(css("./app-shell.module.css")).not.toContain(".closeRound");
    expect(css("./account-menu.module.css")).toMatch(/@media \(pointer: coarse\) \{\s*\.chip\.chip \{ height: 44px; min-height: 44px;/);
    expect(css("./battlefield-detail.module.css")).toContain("@media(pointer:coarse){.box div[data-urgency]>button:not([data-reference-id]){height:auto;min-height:44px}}");
  });
});
