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

/** 按顶层逗号切选择器（:is(a, b) 里的逗号不切）。 */
function topLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === "(") depth += 1;
    else if (list[i] === ")") depth -= 1;
    else if (list[i] === "," && depth === 0) { parts.push(list.slice(start, i)); start = i + 1; }
  }
  return [...parts, list.slice(start)];
}

/** 叶子规则：去注释，按花括号切；@media / @container 里的规则照样收。 */
function rules(file: string): Rule[] {
  const css = readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: topLevel(match[1]).map((selector) => selector.trim().replace(/\s+/g, " ")),
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
    // 旧界面（/me/cards/:id、/me/topics/:id 经 CardSession 也用这个 InputBar）照旧：28 高、单行。新首页里放开。
    const all = rules("styles/home.module.css");
    const base = (selector: string) => all.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.body).join(";");
    const home = (selector: string) => all.filter((rule) => rule.selectors.includes(`${NEW_HOME} ${selector}`)).map((rule) => rule.body).join(";");
    expect(base(".barFoot")).toMatch(/(^|[;\s])height:\s*28px/);
    expect(base(".footText")).toMatch(/white-space:\s*nowrap/);
    expect(base(".ellipsis")).toMatch(/text-overflow:\s*ellipsis/);
    expect(home(".barFoot")).toMatch(/height:\s*auto/);
    expect(home(".barFoot")).toMatch(/min-height:\s*28px/);
    expect(home(".footText")).toMatch(/white-space:\s*normal/);
    expect(home(".ellipsis")).toMatch(/white-space:\s*normal/);
    // 左边占剩下的；右边按内容占，左边有字时最多一半，左边空着时可以占满。「发给」不被挤成一字一行，也不撑出自己那边。
    expect(home(".barFootSide:first-child")).toMatch(/flex:\s*1 1 0/);
    expect(home(".barFootSide:last-child")).toMatch(/flex:\s*0 1 auto/);
    expect(home(".barFootSide:last-child")).toMatch(/min-width:\s*0/);
    expect(home(".barFoot:has(> .barFootSide:first-child :is(.footText, .sendTo)) > .barFootSide:last-child")).toMatch(/max-width:\s*50%/);
    expect(home(".barFoot .sendTo")).not.toMatch(/flex:\s*none/);
    expect(home(".barFoot .sendTo")).toMatch(/max-width:\s*100%/);
  });

  // 手机上（新首页外壳的 data-phone）月份页那一行：Task 名占一整行，后面跟的胶囊（项目名或「挂到」）折到下面，和 Task 名的字对齐。
  const phoneLine = () => rules("styles/home-pages.module.css").filter((rule) => rule.selectors.some((selector) => selector.includes("[data-phone]") && selector.includes(".monthTaskLine")));
  const phoneBody = (part: string) => phoneLine().filter((rule) => rule.selectors.some((selector) => selector.endsWith(part))).map((rule) => rule.body).join(";");

  it("手机上月份页的项目胶囊单独占一行", () => {
    expect(phoneBody(".monthTaskLine")).toMatch(/flex-direction:\s*column/);
    expect(phoneBody(".monthTaskLine > button:first-child")).toMatch(/align-self:\s*stretch/);
    expect(phoneBody(".monthTaskLine > * + *")).toMatch(/margin-left:\s*calc\(16px \+ var\(--space-2\)\)/);
    // 电脑上没有用不上的最大宽度。
    expect(rules("styles/home.module.css").filter((rule) => rule.selectors.some((selector) => selector.includes(".statusChip:has(")) && /max-width:\s*20em/.test(rule.body))).toEqual([]);
  });

  it("手机上没挂项目时，挂到也单独占一行", () => {
    // 跟在 Task 名后面的不管是项目名胶囊还是「挂到」，规则一样：选择器不认 .ellipsis，认位置。
    expect(phoneLine().flatMap((rule) => rule.selectors).filter((selector) => selector.includes(".ellipsis"))).toEqual([]);
    expect(phoneBody(".monthTaskLine > * + *")).toMatch(/max-width:\s*calc\(100% - 16px - var\(--space-2\)\)/);
    expect(rules("styles/home.module.css").filter((rule) => rule.selectors.some((selector) => selector.includes("[data-phone]") && selector.includes(".statusChip"))).map((rule) => rule.selectors.join(", "))).toEqual([]);
  });

  it("手机上短项目名的胶囊按字宽，不拉满", () => {
    expect(phoneBody(".monthTaskLine")).toMatch(/align-items:\s*flex-start/);
    expect(phoneBody(".monthTaskLine > * + *")).toMatch(/flex:\s*none/);
    expect(phoneBody(".monthTaskLine > * + *")).not.toMatch(/flex(-basis)?:[^;]*100%/);
  });

  it("手机上页头标题长时换行，页头跟着长高、不压正文", () => {
    // 没有形象的页头（项目对话）：标题占到右边按钮前面，不再和右边平分；在场槽（只挂状态胶囊）不占列，绝对定位在正中。
    const presence = rules("styles/presence.module.css");
    const body = (selector: string) => presence.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.body).join(";");
    expect(body(".head[data-flush]:not(:has(> .presence[data-stage]))")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) auto;/);
    expect(body(".head[data-flush]:not(:has(> .presence[data-stage])) > .presence")).toMatch(/position:\s*absolute/);
    // 页头只有最小高度，标题折行时跟着长高。
    const home = rules("styles/home.module.css");
    const viewHead = home.filter((rule) => rule.selectors.some((selector) => /^\.viewHead(\[data-flush\])?$/.test(selector))).map((rule) => rule.body).join(";");
    expect(viewHead).toMatch(/min-height:/);
    expect(viewHead).not.toMatch(/(^|[;\s])height:/);
    // 页头叠在对话上时，对话上沿和渐隐跟着页头实际高度（--head-h，ChatColumn 量出来），不是写死的 48。
    const chat = rules("styles/v2-chat.module.css");
    const log = chat.filter((rule) => rule.selectors.some((selector) => selector.endsWith("> .log"))).map((rule) => rule.body).join(";");
    expect(log).toMatch(/padding-top:\s*calc\(var\(--head-h/);
    const fade = chat.filter((rule) => rule.selectors.some((selector) => selector.includes(":not([data-stage])") && selector.includes(".log[data-scrolled]"))).map((rule) => rule.body).join(";");
    expect(fade).toMatch(/transparent calc\(var\(--head-h/);
    expect(readFileSync(new URL("../components/rail/ChatPane.tsx", import.meta.url), "utf8")).toMatch(/--head-h/);
    // 子会话页头（不叠在对话上，本来就跟着长高）：标题折成多行时上下留出空，字不贴屏幕上沿。
    const session = rules("styles/v2-session.module.css");
    const embedHead = session.filter((rule) => rule.selectors.some((selector) => selector.includes('data-type-scale="one"') && selector.endsWith(".embedHead"))).map((rule) => rule.body).join(";");
    expect(embedHead).toMatch(/padding-block:/);
  });

  it("下沿左边是没绑文件夹的「此电脑」时也算有字，右边最多一半", () => {
    const all = rules("styles/home.module.css");
    const capped = all.filter((rule) => /max-width:\s*50%/.test(rule.body) && rule.selectors.some((selector) => selector.includes(".barFoot:has(")));
    expect(capped.flatMap((rule) => rule.selectors).join(" ")).toMatch(/:is\(\.footText, \.sendTo\)/);
  });
});
