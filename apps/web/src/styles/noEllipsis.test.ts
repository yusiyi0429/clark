import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 新首页任何地方不出省略号（本人 11/18）：单行放不下就换行，多行预览限高加底部渐隐。
 * 这里守新首页用到的 CSS 模块，防止以后有人再加回 `text-overflow: ellipsis` 或 `-webkit-line-clamp`。
 *
 * - OWN：新首页自己的样式（下面的名单，加上 components/home 下所有样式模块），不许有；只有没有新首页外壳的独立页
 *   （/me/cards/:id、/me/topics/:id）也用的那几条（.sendTo、.attName 等）原样留着，新首页里同 SHARED 一样盖掉。
 * - SHARED：新旧界面共用、新首页里看得到。旧界面不动，原规则留着；新首页在文件末尾用
 *   `:global(:root:has([data-type-scale="one"]))` 盖掉。这里查每条会出省略号的规则都被盖到了。
 * - 不在名单里的：只在旧界面出现（CEO 管理模式、对象页、V2 旧骨架、老工作台），或在新首页里不渲染
 *   （account-menu、radar-feed、v2-month 只被引了函数或类型；composer-pill、conversation-dock、conversation-attachments、
 *   conversation-column 是旧对话栏的输入框和页头，新首页用自己的 InputBar）；
 *   header-capsule（DetailFrame 页头）、material-tabs、materials、material-annotations（会议材料预览）另一个人在改，交主会话处理。
 */
const OWN = [
  "styles/home.module.css",
  "styles/home-pages.module.css",
  "styles/conversation-bubbles.module.css",
  "styles/presence.module.css",
  "styles/task-feed.module.css",
  "styles/meeting-view.module.css",
  "components/home/partner-meetings.module.css",
  "components/home/partnerTeam.module.css",
];

const SHARED = [
  "styles/v2-session.module.css",
  "styles/v2-chat.module.css",
  "styles/v2-local.module.css",
  "styles/conversation-transcript.module.css",
  "styles/conversation-quotes.module.css",
  "styles/decision-box.module.css",
  "styles/entry-cards.module.css",
  "styles/scope-chip.module.css",
  "styles/rich-blocks.module.css",
  "styles/issue-suggest.module.css",
  "styles/card-references.module.css",
  "styles/task-deliverable.module.css",
  "styles/meeting-workspace.module.css",
  "components/steps/step-list.module.css",
  "components/requests/requests.module.css",
  "components/requests/impact.module.css",
  "components/collections/collections.module.css",
  "components/ui/picker.module.css",
  "components/memory/memory.module.css",
  "components/meeting/meeting-card.module.css",
  "components/meeting/meeting-decisions.module.css",
  "components/meeting/transcriptReader.module.css",
];

/** 另一个人在改的规则（左栏门牌），先放过。 */
const OTHERS: Record<string, string[]> = { "styles/home.module.css": [".buddyName"] };

const NEW_HOME = ':global(:root:has([data-type-scale="one"]))';
const CUTS = /text-overflow\s*:\s*ellipsis|line-clamp\s*:\s*[1-9]/;

type Rule = { selectors: string[]; body: string };

/** 叶子规则：去注释，按花括号切；@media / @container 里的规则照样收。 */
function rules(file: string): Rule[] {
  const css = readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1].split(",").map((selector) => selector.trim().replace(/\s+/g, " ")),
    body: match[2],
  }));
}

/** components/home 下的样式模块默认都是新首页自己的：新建的也自动受管。 */
function homeModules(dir = "components/home"): string[] {
  return readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? homeModules(`${dir}/${entry.name}`) : entry.name.endsWith(".module.css") ? [`${dir}/${entry.name}`] : []);
}
const MANAGED_OWN = [...new Set([...OWN, ...homeModules()])];

/** 会出省略号、又没被新首页覆盖到的选择器。覆盖要真的放开：省略号的要 clip 且能换行，clamp 的要 none。 */
function uncovered(file: string): string[] {
  const all = rules(file);
  const allowed = OTHERS[file] ?? [];
  const overrides = all.filter((rule) => rule.selectors.every((selector) => selector.startsWith(NEW_HOME)));
  const covered = (selector: string, clamp: boolean) => overrides.some((rule) => rule.selectors.includes(`${NEW_HOME} ${selector}`)
    && (clamp ? /-webkit-line-clamp\s*:\s*none/.test(rule.body) : /text-overflow\s*:\s*clip/.test(rule.body) && /white-space\s*:\s*(normal|pre-wrap)|overflow-wrap/.test(rule.body)));
  return all.filter((rule) => CUTS.test(rule.body) && !overrides.includes(rule))
    .flatMap((rule) => rule.selectors.filter((selector) => !allowed.includes(selector) && !covered(selector, /line-clamp/.test(rule.body))));
}

describe("新首页不出省略号（本人 11/18）", () => {
  it.each(MANAGED_OWN)("%s：没有省略号；旧界面也用的那几条，新首页里盖掉了", (file) => {
    expect(uncovered(file)).toEqual([]);
  });

  it.each(SHARED)("%s：还有省略号的规则，新首页里都盖掉了", (file) => {
    expect(uncovered(file)).toEqual([]);
  });

  it("components/home 下新建的样式模块也在名单里", () => {
    expect(MANAGED_OWN).toEqual(expect.arrayContaining(["components/home/partner-meetings.module.css", "components/home/partnerTeam.module.css"]));
  });

  it("独立的卡片页、专题页里，发给和附件名照旧", () => {
    // /me/cards/:id、/me/topics/:id 没有新首页外壳，也用这几条：原规则照旧单行，新首页里带前缀盖掉。
    const all = rules("styles/home.module.css");
    const base = (selector: string) => all.find((rule) => rule.selectors.includes(selector))!.body;
    expect(base(".sendTo b")).toMatch(/text-overflow:\s*ellipsis/);
    expect(base(".attName b")).toMatch(/text-overflow:\s*ellipsis/);
    expect(base(".sendTo")).toMatch(/(^|[;\s])height:\s*var\(--row-32\)/);
    expect(base(".att")).toMatch(/(^|[;\s])height:\s*56px/);
    const override = (selector: string) => all.filter((rule) => rule.selectors.includes(`${NEW_HOME} ${selector}`)).map((rule) => rule.body).join(";");
    expect(override(".sendTo b")).toMatch(/white-space:\s*normal/);
    expect(override(".attName b")).toMatch(/white-space:\s*normal/);
    expect(override(".sendTo")).toMatch(/height:\s*auto/);
    expect(override(".att")).toMatch(/height:\s*auto/);
  });

  it("输入框下沿那一行名字长时换行，不溢出", () => {
    const all = rules("styles/home.module.css");
    const body = (selector: string) => all.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.body).join(";");
    expect(body(".barFoot")).not.toMatch(/(^|[;\s])height\s*:/);
    expect(body(".barFoot")).toMatch(/min-height:\s*28px/);
    expect(body(".footText")).not.toMatch(/white-space:\s*nowrap|overflow:\s*hidden/);
    expect(body(".footText")).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
