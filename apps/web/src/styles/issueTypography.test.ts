import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 议题页排印（docs/superpowers/specs/2026-10-12-issue-page-typography.md）：
 * 桌面字号只有两级 16 / 13 + 标签 12（不再用 20），字重 400 / 600，墨色以主 / 次为主 + 一种强调色；页面用 data-type-scale="doc" 选用。
 */
/** 去掉注释：注释里会写到 data-type-scale=doc，不能被当成选择器。 */
const css = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const globals = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const issue = css("./issue-workspace.module.css");

/** 带 data-type-scale=doc 前缀的规则体（含选择器），也包括包在 @media 里的。 */
const docRules = (text: string) =>
  [...text.matchAll(/((?:\[data-type-scale=doc\]|:global\(\[data-type-scale='doc'\]\))[^{]*)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1], body: match[2] }));

describe("议题页排印", () => {
  it("议题页样式文件里不再出现 12px 以下的字号（12px 只给标签）", () => {
    const sizes = [...issue.matchAll(/font-size:\s*([\d.]+)px/g)].map((match) => Number(match[1]));
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(12);
  });

  it("全局 token：三个字号 20 / 16 / 12 + 标签 12（新首页 14.1：小字从 13 并到 12），两种字重，三级墨色 + 强调色，行长 600", () => {
    const token = (name: string) => globals.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();
    expect([token("doc-type-title"), token("doc-type-section"), token("doc-type-body"), token("doc-type-meta"), token("doc-type-tag")])
      .toEqual(["20px", "16px", "16px", "12px", "12px"]);
    expect([token("doc-weight-regular"), token("doc-weight-strong")]).toEqual(["400", "600"]);
    // 三级墨色 + 强调色接到底层墨色变量上，深色时跟着换（新首页设计 5.2）。
    expect(["doc-ink-1", "doc-ink-2", "doc-ink-3", "doc-ink-accent"].map(token)).toEqual(["var(--ink)", "var(--ink-muted)", "var(--ink-faint)", "var(--tianshu-blue-secondary, #3c66bf)"]);
    expect(token("doc-measure")).toBe("600px");
    // 外壳 .shell 有一套随视口变的 --type-*：材料排印不能和它重名。
    expect(globals).not.toMatch(/^\s*--type-(title|body|meta)\s*:/m);
  });

  it("议题页独有的块（当前判断、备选方向、待澄清事项、已移出…）的字号、字重全部取 --doc-*", () => {
    const issueOnly = ["note", "judgment", "discussion", "options", "receipt", "sourceQuote", "unknown", "history", "option", "error", "dismissed", "formNote"];
    // 手持（≤959）那几段是用户定的字号下限，单独保留；这里只看桌面的规则。
    const desktop = issue.slice(0, issue.indexOf(".close .backIcon"));
    for (const name of issueOnly) {
      const bodies = [...desktop.matchAll(new RegExp(`(?:^|[}\\s,])\\.${name}(?![\\w-])[^{}]*\\{([^{}]*)\\}`, "g"))].map((match) => match[1]);
      expect(bodies.length, name).toBeGreaterThan(0);
      for (const body of bodies) {
        for (const size of body.matchAll(/font-size:([^;}]+)/g)) expect(size[1], name).toMatch(/^var\(--doc-type-(section|body|meta|tag)\)$/);
        for (const weight of body.matchAll(/font-weight:([^;}]+)/g)) expect(weight[1], name).toMatch(/^var\(--doc-weight-(regular|strong)\)$/);
      }
    }
    // 「当前判断」和正文同为 16，不再放大成 20；桌面规则里不再出现 title 级。
    expect(issue).toMatch(/\.judgment>p\{[^}]*font-size:var\(--doc-type-body\)/);
    expect(desktop).not.toContain("--doc-type-title");
    expect(issue).not.toMatch(/clamp\(44px/);
    // 正文行长：600 + 两侧内边距。
    expect(issue).toContain("[data-type-scale=doc] .reading{width:100%;max-width:calc(var(--doc-measure) + 56px);margin-inline:auto");
  });

  it("页头、切换、邀请成员、材料下拉钮、三层历史与依据抽屉：doc 段只用 --doc-* 的字号、字重、墨色", () => {
    const files = ["./issue-workspace.module.css", "./header-capsule.module.css", "./segmented-switch.module.css", "./thread-members.module.css",
      "./material-tabs.module.css", "./decision-workspace.module.css"];
    for (const file of files) {
      const rules = docRules(css(file));
      expect(rules.length, file).toBeGreaterThan(0);
      for (const { selector, body } of rules) {
        for (const size of body.matchAll(/font-size:\s*([^;}]+)/g)) expect(size[1].trim(), `${file} ${selector}`).toMatch(/^var\(--doc-type-(section|body|meta|tag)\)$/);
        for (const weight of body.matchAll(/font-weight:\s*([^;}]+)/g)) expect(weight[1].trim(), `${file} ${selector}`).toMatch(/^(var\(--doc-weight-(regular|strong)\)|400|600)$/);
        for (const color of body.matchAll(/(?:^|;)\s*color:\s*([^;}]+)/g)) expect(color[1].trim(), `${file} ${selector}`).toMatch(/^var\(--doc-ink-(1|2|3|accent)\)$/);
      }
    }
  });

  it("标签（12px）只出现在标签类的规则上", () => {
    const tagRules = [...docRules(css("./decision-workspace.module.css")), ...docRules(issue)].filter(({ body }) => body.includes("var(--doc-type-tag)"));
    for (const { selector } of tagRules) expect(selector).toMatch(/badge|changeKind|avatar/);
    // 议题页里的标签：右上角状态、来自雷达的「雷达」。
    expect(issue).toMatch(/\.discussion>header>span\{[^}]*font-size:var\(--doc-type-tag\)/);
  });

  it("字号白名单：议题页桌面规则与各共享 doc 段的字号只有 16 / 12（14.1）", () => {
    const desktop = issue.slice(0, issue.indexOf(".close .backIcon"));
    const tokens = new Set([...desktop.matchAll(/font-size:\s*var\(--doc-type-([a-z]+)\)/g)].map((match) => match[1]));
    for (const file of ["./decision-workspace.module.css", "./header-capsule.module.css", "./segmented-switch.module.css", "./thread-members.module.css"])
      for (const { body } of docRules(css(file))) for (const match of body.matchAll(/font-size:\s*var\(--doc-type-([a-z]+)\)/g)) tokens.add(match[1]);
    expect([...tokens].sort()).toEqual(["body", "meta", "section", "tag"]);
    const px = (name: string) => globals.match(new RegExp(`--doc-type-${name}:\s*([^;]+);`))?.[1].trim();
    expect([...new Set([...tokens].map(px))].sort()).toEqual(["12px", "16px"]);
  });

  it("历史分层不靠颜色：doc 段去掉小圆点、条目的底色与描边，改成发丝线列表；琥珀提示换成浅灰", () => {
    const decision = css("./decision-workspace.module.css");
    expect(decision).toContain(":global([data-type-scale='doc']) .layer>h4::before{content:none}");
    expect(decision).toMatch(/:global\(\[data-type-scale='doc'\]\) \.entry\.entry\{[^}]*border:0;[^}]*background:none/);
    expect(decision).toMatch(/:global\(\[data-type-scale='doc'\]\) \.entry\.entry\+\.entry\{border-top:1px solid var\(--doc-rule\)\}/);
    expect(decision).toMatch(/:global\(\[data-type-scale='doc'\]\) \.notice\{background:var\(--doc-tag-wash\)/);
    // 已形成的决定不再是绿框绿底。
    expect(issue).not.toMatch(/\.receipt\{[^}]*background:#/);
  });
});
