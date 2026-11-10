import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

describe("responsive workspace CSS", () => {
  it("bounds the connection dialog and wraps commands at 390px", () => {
    const menu = css("./account-menu.module.css");
    const connection = css("./connection-dialog.module.css");
    expect(menu).toContain(".dialog.wide { box-sizing: border-box; width: min(560px, calc(100vw - 32px))");
    expect(menu).toContain("@media (max-width: 759px) { .dialog.wide { width: calc(100vw - 20px)");
    expect(connection).toContain(".command code{flex:1;min-width:0;overflow-wrap:anywhere;white-space:pre-wrap");
    expect(connection).toContain(".segmented{display:inline-flex;justify-self:start;max-width:100%;");
    expect(connection).toContain("overflow-x:auto}");
  });
  it("keeps the handheld home (≤959) as one centred scroll for CEO and members: notices, then the glance or member work, then the account", () => {
    const source = css("./app-shell.module.css");
    expect(source).toContain(".shell[data-detail-open=false]{display:flex;flex-direction:column");
    // 双屏上内容列最宽 600、居中，不拉成满屏宽。
    expect(source).toContain("padding:calc(14px + env(safe-area-inset-top)) max(12px,calc((100% - 600px) / 2))");
    expect(source).toMatch(/\.shell\[data-detail-open=false\] \.mainArea\{display:block/);
    expect(source).toContain(".shell[data-detail-open=false] .notificationArea{order:-1");
    expect(css("./member-home.module.css")).toContain('height: auto; overflow: visible;');
    // 手持不放完整看板（翻转卡、进展示意、能力卡），换成精简的公司全局。
    expect(css("./home-board.module.css")).toContain("@media(max-width:959px){.board{display:none}.phoneAccount{display:block");
    expect(css("./ceo-glance.module.css")).toContain("@media(max-width:959px){.glance{display:flex");
    // 顶上是锁屏式的日期 + 大号时间，跟着页面滚走：不能 fixed —— 通知区入场有滤镜、返回有转场名，fixed 的子元素会跟着错位（真机反馈的头部跳动）。
    expect(css("./notifications.module.css")).toContain(" .rail>.railClock{position:relative");
    // 手持是深色沉稳的画布，浅色通知卡才显得出来。
    expect(source).toContain("@media(max-width:959px){.shell{background-color:#141c30");
  });
  it("follows the form-factor contract: handheld ≤959 (phone, tri-fold dual screen), workstation ≥960", () => {
    const source = css("./app-shell.module.css");
    // 全局输入条在各宽度都可达（clark / ts-design v0.4：手机首页、平板总览与桌面均显示 ConversationDock）。
    expect(source).not.toContain(':global([data-testid="global-controls"]){display:none}');
    // 首页主区在任何宽度都不整块隐藏（clark 的空白折叠态即此处缺陷）：手持换成精简的公司全局，工作台是完整看板。
    expect(source).not.toMatch(/max-width:1000px\)\{[^}]*\.homeSurface\{display:none\}/);
    expect(source).not.toContain(".foldMaterialSurface");
    // 手持（≤959：单屏、三折叠双屏 683–731、三屏竖放）：打开详情铺满屏幕，不留窄条；返回在页头左上角。
    expect(source).toMatch(/@media\(max-width:959px\)\{\s*\.shell\{[^}]*display:block/);
    expect(source).toContain(".shell[data-detail-open=true]{--main-start:8px;--shell-edge:8px;--strip-width:0px;--notice-width:0px}");
    expect(css("./notice-strip.module.css")).toContain("@media(max-width:959px){.strip{display:none}}");
    expect(source).not.toContain("max-width:690px");
    // 三折叠双屏（600–959）：左边选、右边看 —— 两列网格，打开详情时通知仍在左页，详情只占右页（--main-start 是右页左缘）。
    expect(source).toContain("@media(min-width:600px) and (max-width:959px){");
    expect(source).toContain("--main-start:calc(16px + var(--dual-left))");
    expect(source).toMatch(/\.shell\[data-detail-open=true\] \.notificationArea\{display:block;grid-column:1/);
    // 对话在 ≤959 是底部输入条 + 浮层（手机、三折叠双屏），≥960 才是右列。
    expect(css("./conversation-column.module.css")).toContain("@media (max-width: 959px)");
    expect(css("./conversation-column.module.css")).not.toContain("759px");
    // 任何详情打开时，通知栏在所有宽度折成窄条。
    expect(source).toContain(".shell[data-detail-open=true]{--notice-width:var(--strip-width)}");
  });

  it("renders the settings page as a 2448-wide 2×2 grid of 44-high inputs", () => {
    const source = css("./config.module.css");
    expect(source).toContain("max-width:2448px");
    expect(source).toContain(".grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;max-width:2448px;align-items:start}");
    // 输入框的边、圆角、底色、聚焦走 globals.css 的统一输入框样式（--field-*），页面里只留 44 高与左右内边距。
    expect(source).toContain(".field input,.field select{width:100%;height:44px;padding:0 16px}");
    expect(source).toContain(".grid{grid-template-columns:minmax(0,1fr)}.tall,.ltco{height:auto}");
    // 卡片随内容长高时，页脚和上传区回到文档流，不再压到输入框上。
    expect(source).toContain(".cardFooter,.upload{position:static}");
    expect(source).toContain(".back,.secondary,.primary{flex:none;white-space:nowrap}");
  });

  it("stacks the battlefield management columns below 1100px", () => {
    const source = css("./battlefield-management.module.css");
    expect(source).toContain("@media(max-width:1100px){.body{flex-direction:column}.left{width:100%}.listCard,.relatedCard,.pickCard{height:auto}.confirm{right:24px;left:auto}}");
  });

  it("lays the home battlefield grid as clark's 2/1 columns with 公司能力 as the last cell", () => {
    const source = css("./home-board.module.css");
    expect(source).toContain(".battlefields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr))");
    expect(source).toContain(".battlefields { grid-template-columns:minmax(0,1fr); }");
    // 公司能力与战场卡同宽：永远只占一格，同一行按最高的那张拉齐（不再在偶数战场时独占一行）。
    expect(source).not.toContain("grid-column:1/-1");
    expect(source).toContain("align-items:stretch");
  });

  it("lets a lone meeting-level judgment group span the two-column pair row", () => {
    const source = css("./meeting-workspace.module.css");
    expect(source).toContain(".pairRow{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))");
    expect(source).toContain(".pairRow>:only-child{grid-column:1/-1}");
  });

  it("keeps both scheduled-meeting side panels reachable below 1000px", () => {
    const source = css("./meeting-workspace.module.css");
    expect(source).not.toContain('.advisorShell>:global([data-testid="meeting-chat-sidebar"]){display:none}');
    expect(source).not.toContain(".priorityContent{display:none}");
    // 会前结论栏不可折叠（pen 无折叠态）；会议页已不再内嵌对话栏，对话由工作面右列提供。
    expect(source.match(/width:var\(--rail-stub\);min-width:var\(--rail-stub\)/g)).toBeNull();
  });

  it("keeps the meeting outline sticky inside the single .ts-detail scroller and never turns a reading container into a nested scroll box", () => {
    const source = css("./meeting-workspace.module.css");
    // 宽屏（面板够宽、屏幕不矮）：目录在左列吸顶，跟着阅读页 .ts-detail 滚动，让出页头。
    expect(source).toContain("@container pane (min-width: 940px)");
    expect(source).toContain("@media (min-height: 600px)");
    expect(source).toMatch(/\.readingGrid\[data-toc=true\]>\.tocAside\{position:sticky;top:calc\(var\(--detail-header-height,48px\) \+ 14px\)/);
    expect(source).toContain(".reading>.pane[data-toc=true]{max-width:calc(var(--material-column,656px) + 236px)}");
    // 窄屏 / 矮屏 / 放大：零高度的吸顶条里一颗「目录」钮，不占正文高度；点开的目录浮在正文上面。
    expect(source).toMatch(/\.tocBar\{position:sticky;[^}]*height:0\}/);
    expect(source).toMatch(/\.tocPanel\{position:absolute;/);
    // 阅读容器一律不设 overflow / overscroll（0b063c5：无溢出的内层滚动框会截住滚轮）。
    const rulesOf = (text: string, name: string) => [...text.matchAll(new RegExp(`\\.${name}(?![\\w-])[^{]*\\{([^}]*)\\}`, "g"))].map((match) => match[1]);
    const noNestedScroll = (text: string, names: string[]) => {
      for (const name of names) {
        const rules = rulesOf(text, name);
        expect(rules.length, name).toBeGreaterThan(0);
        for (const rule of rules) {
          expect(rule, name).not.toMatch(/overflow(-y)?\s*:\s*(auto|scroll|hidden)/);
          expect(rule, name).not.toMatch(/overscroll-behavior/);
        }
      }
    };
    noNestedScroll(source, ["reading", "pane", "readingGrid", "readingMain", "material", "decisionWorkspace", "overview", "issueList", "issueBlock", "issueSection", "meetingLevel", "tocAside", "tocBar"]);
    const shared = css("./decision-workspace.module.css");
    noNestedScroll(shared, ["layers", "layer", "entry", "inactive", "sourceRow"]);
    // 只有浮在上面的「依据」抽屉自己滚动。
    expect(shared).toMatch(/\.drawer\{position:absolute;/);
    expect(shared).toMatch(/\.drawerBody\{[^}]*overflow-y:auto;overscroll-behavior:contain/);
    noNestedScroll(css("./issue-workspace.module.css"), ["history"]);
  });

  it("renders the issue workspace inside the shell panel with clark's header and reading column", () => {
    const source = css("./issue-workspace.module.css");
    expect(source).toContain(".workspace{display:flex;flex-direction:column;flex:1;height:100%;min-height:0;overflow:hidden;border-radius:inherit;background:#f8f8fa");
    expect(source).toContain("min-height:96px;box-sizing:border-box;padding:25px 27px;background:linear-gradient(145deg,#ffffffa6,#eef1f6a3)");
    // 正文随 DetailFrame 的 .ts-detail 一起滚动：阅读列不能再是没有溢出的内层滚动框，否则会截住滚轮（0b063c5 修复）。
    expect(source).toContain(".reading{position:relative;padding:24px 28px 48px;min-height:0;line-height:1.8;font-size:16px}");
    expect(source).not.toMatch(/\.reading\{[^}]*overflow:auto/);
    expect(source).not.toMatch(/\.reading\{[^}]*overscroll-behavior/);
    expect(source).not.toContain("position:fixed");
  });

  it("clears the global dock on the phone notices-home (clark --notice-bottom-inset)", () => {
    // 通知列表底部留白 64：滚到底最后一条不被左下角的个人胶囊盖住。
    expect(css("./notifications.module.css")).toContain("padding:78px 16px var(--notice-bottom-inset,64px)");
    expect(css("./app-shell.module.css")).toContain("--notice-bottom-inset:calc(112px + env(safe-area-inset-bottom))");
  });

  it("drops the scroll padding for the signal reader (clark data-radar-reader-layout)", () => {
    const source = css("./app-shell.module.css");
    expect(source).toContain(".expandedScroll[data-radar-reader-layout=true]{margin:0;padding:0;overflow:hidden;display:flex;min-width:0}");
    expect(source).toContain(".shell[data-topic-rail=true] .expandedScroll[data-radar-reader-layout=true]{padding:0}");
  });

  it("lets the DetailFrame reader own the signal page's scroll so wheel and trackpad are not swallowed", () => {
    const source = css("./app-shell.module.css");
    expect(source).toContain(":global(.ts-detail)>.expandedScroll[data-radar-reader-layout=true],:global(.ts-detail)>.expandedScroll[data-radar-reader-layout=true]>[data-radar-reader]{overflow:visible;overscroll-behavior:auto;flex:none;height:auto}");
  });

  it("keeps the radar list and reader on clark's single 772px reading column", () => {
    const source = css("./radar-feed.module.css");
    expect(source).toContain(".feed{max-width:772px;padding-bottom:120px}");
    expect(source).toContain(".reader .article{max-width:772px;padding:22px 26px 40px}");
  });

  it("gives the read-only 监测范围 dialog clark's modal surface and a bounded scroll region", () => {
    const source = css("./anchor-editor.module.css");
    expect(source).toContain(".dialog{position:relative;margin:auto;width:min(780px,calc(100vw - 48px))");
    expect(source).toContain(".scroll{padding:24px 32px 30px;overflow-y:auto;overscroll-behavior:contain;min-height:0;");
  });

  it("登录页用新首页的实心底和统一焦点（设计稿 19 节），手机上一列靠上；通知栏粗指针下的按钮尺寸照旧", () => {
    const access = css("./access.module.css");
    expect(access).toContain("background: var(--surface)");
    expect(access).toContain("box-shadow: 0 0 0 3px var(--accent-soft)");
    expect(access).not.toContain("--morning-start");
    expect(access).not.toContain("backdrop-filter");
    expect(access).toMatch(/@media \(max-width: 759px\) \{\s*\.shell \{ justify-content: flex-start;/);
    expect(css("./notifications.module.css")).toContain("@media(pointer:coarse){.railLock button{width:42px;height:42px;margin:0}}");
  });

  it("stacks the Mission pages: 390 筛选/列表、1217 编辑器与 650 侧栏", () => {
    const overview = css("./mission-overview.module.css");
    expect(overview).toContain(".filters{flex:none;display:flex;flex-direction:column;gap:16px;box-sizing:border-box;width:390px;height:1106px");
    // 按面板（pane 容器）宽度而不是屏幕宽度排：三折叠三屏的面板要扣掉对话列。
    expect(css("./app-shell.module.css")).toContain("container:pane/inline-size");
    expect(overview).toMatch(/@container pane \(max-width:859px\)\{\s*\.body\{flex-direction:column;align-items:stretch\}\.filters\{width:100%;height:auto\}\.listCard\{height:auto\}/);

    const detail = css("./mission-detail.module.css");
    expect(detail).toContain(".sidebar{display:flex;flex:none;flex-direction:column;gap:16px;width:650px;max-width:100%}");
    expect(detail).toContain("@container pane (max-width:899px){.body{flex-direction:column}.sidebar{width:100%}}");

    const management = css("./mission-management.module.css");
    expect(management).toContain("width:690px;height:1217px");
    expect(management).toContain("@media(max-width:1400px){.body{flex-direction:column}.listCard,.editor{width:100%;height:auto}");
    expect(management).toContain(".fieldRow[data-columns=two]{grid-template-columns:repeat(2,minmax(0,1fr))}");
  });
});
