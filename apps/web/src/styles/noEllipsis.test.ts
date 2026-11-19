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
 *   （radar-feed、v2-month 只被引了函数或类型；composer-pill、conversation-dock、conversation-attachments、
 *   conversation-column 是旧对话栏的输入框和页头，新首页用自己的 InputBar）。
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
  "styles/header-capsule.module.css",
  // 手机上「我」（连接页 PluginsPage）页头的账号名。
  "styles/account-menu.module.css",
  // 会议页的材料区：页头的材料下拉钮、链接预览、批注和垃圾篓。
  "styles/material-tabs.module.css",
  "components/materials/materials.module.css",
  "components/materials/material-annotations.module.css",
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

  // 手机上（新首页外壳的 data-phone）月份页（11/19 DRI 根据地）：项目名收进了展开；行尾挪到名字下一行、和 Task 名的字对齐；展开里那几样一样一行。
  const phoneBody = (part: string) => rules("styles/home-pages.module.css")
    .filter((rule) => rule.selectors.some((selector) => selector.includes("[data-phone]") && selector.endsWith(part))).map((rule) => rule.body).join(";");

  it("手机上月份页的行尾挪到名字下一行，和名字对齐", () => {
    expect(phoneBody(".monthTaskLine")).toMatch(/flex-wrap:\s*wrap/);
    expect(phoneBody(".monthTrail")).toMatch(/flex-basis:\s*100%/);
    expect(phoneBody(".monthTrail")).toMatch(/padding-left:\s*calc\(16px \+ var\(--space-2\)\)/);
  });

  it("手机上月份页展开里的验收时间点、去向、项目名一样一行，长项目名换行不截断", () => {
    expect(phoneBody(".monthFacts")).toMatch(/flex-direction:\s*column/);
    const link = rules("styles/home-pages.module.css").filter((rule) => rule.selectors.includes(".monthLink")).map((rule) => rule.body).join(";");
    expect(link).toMatch(/overflow-wrap:\s*anywhere/);
    expect(link).not.toMatch(/text-overflow|nowrap/);
    expect(rules("styles/home.module.css").filter((rule) => rule.selectors.some((selector) => selector.includes(".statusChip:has(")) && /max-width:\s*20em/.test(rule.body))).toEqual([]);
    expect(rules("styles/home.module.css").filter((rule) => rule.selectors.some((selector) => selector.includes("[data-phone]") && selector.includes(".statusChip"))).map((rule) => rule.selectors.join(", "))).toEqual([]);
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
    // 子会话页头（不叠在对话上，本来就跟着长高）：标题折成多行时上下留出空，字不贴屏幕上沿；
    // 空留在标题上，不加在页头上（手机返回键 44 高，页头加上下内边距就成了 52），单行时页头仍 48。
    const session = rules("styles/v2-session.module.css");
    const inNewHome = (name: string) => session.filter((rule) => rule.selectors.some((selector) => selector.includes('data-type-scale="one"') && selector.endsWith(name))).map((rule) => rule.body).join(";");
    expect(inNewHome(".embedHead")).not.toMatch(/padding/);
    expect(inNewHome(".embedTitle")).toMatch(/padding-block:/);
  });

  it("项目对话页长标题折行时，状态胶囊不压标题", () => {
    // 在场槽跟着页头底部走：页头 48 高时离顶 4（位置照旧）；页头长高时槽落到最后 44 里，挂在槽下面的胶囊在标题下面。
    const presence = rules("styles/presence.module.css");
    const slot = presence.filter((rule) => rule.selectors.includes(".head[data-flush]:not(:has(> .presence[data-stage])) > .presence")).map((rule) => rule.body).join(";");
    expect(slot).toMatch(/top:\s*calc\(100% - 44px\)/);
    expect(slot).not.toMatch(/top:\s*4px/);
    // 主线（有形象）的胶囊位置不动：在场槽不绝对定位，胶囊照旧压住形象下沿 6。
    const stage = presence.filter((rule) => rule.selectors.some((selector) => selector.includes("[data-stage]") && !selector.includes(":not("))).map((rule) => rule.body).join(";");
    expect(stage).not.toMatch(/position:\s*absolute;\s*top:\s*calc\(100% - 44px\)/);
    expect(presence.find((rule) => rule.selectors.includes(".presence[data-stage] > .hang"))?.body).toMatch(/top:\s*calc\(100% - 6px\)/);
  });

  it("会议页手机上长标题换行，不出省略号", () => {
    // 会议页（DetailFrame 的 .ts-detail-header > h1）：旧界面照旧（≤1250 计划时段和标题两行、标题一行省略；≤1000 最多两行），
    // 新首页里盖掉：标题整段换行，页头只有最小高度、跟着长高，不压正文。
    const all = rules("styles/header-capsule.module.css");
    const base = (selector: string) => all.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.body).join(";");
    const home = (selector: string) => all.filter((rule) => rule.selectors.includes(`${NEW_HOME} ${selector}`)).map((rule) => rule.body).join(";");
    const lead = ".scope :global(.ts-detail-header:has(> .ts-row > [data-header-lead]) > h1)";
    expect(base(lead)).toMatch(/text-overflow:\s*ellipsis/);
    expect(base(".scope :global(.ts-detail-header)")).toMatch(/(^|[;\s])height:\s*var\(--detail-header-height\)/);
    for (const selector of [".scope :global(.ts-detail-header > h1)", lead]) {
      expect(home(selector)).toMatch(/white-space:\s*normal/);
      expect(home(selector)).toMatch(/text-overflow:\s*clip/);
      expect(home(selector)).toMatch(/-webkit-line-clamp:\s*none/);
    }
    expect(home(".scope :global(.ts-detail-header)")).toMatch(/(^|[;\s])height:\s*auto/);
    expect(home(".scope :global(.ts-detail-header)")).toMatch(/min-height:\s*var\(--detail-header-height\)/);
    // 标题折行时上下留空（同子会话 .embedTitle）：空留在标题上，不加在页头上，单行时页头仍 48。
    expect(home(".scope :global(.ts-detail-header > h1)")).toMatch(/padding-block:\s*var\(--space-1\)/);
    expect(home(".scope :global(.ts-detail-header)")).not.toMatch(/padding/);
  });

  it("会议页时段和标题叠两行时，页头上下留白，时段不贴顶", () => {
    // ≤1250 宽（手机也在内）带计划时段的页头是时段在上、标题在下两行，本来就超过 48：留白加在页头上，标题不再加。
    // 单行页头（没有时段，或宽屏上时段和标题同一行）照旧留白在标题上，单行时仍 48。
    const css = readFileSync(new URL("./header-capsule.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const stacked = [...css.matchAll(/@media \(max-width: 1250px\) \{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)].map((match) => match[1]).join("\n");
    const lead = ".scope :global(.ts-detail-header:has(> .ts-row > [data-header-lead]))";
    const inStacked = (selector: string) => [...stacked.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((match) => match[1].split(/,(?![^(]*\))/).some((part) => part.trim().replace(/\s+/g, " ") === `${NEW_HOME} ${selector}`)).map((match) => match[2]).join(";");
    expect(inStacked(lead)).toMatch(/padding-block:\s*var\(--space-1\)/);
    expect(inStacked(`${lead.slice(0, -1)} > h1)`)).toMatch(/padding-block:\s*0/);
    // 单行的页头本身仍不加留白，标题照旧加。
    const all = rules("styles/header-capsule.module.css");
    const home = (selector: string) => all.filter((rule) => rule.selectors.includes(`${NEW_HOME} ${selector}`)).map((rule) => rule.body).join(";");
    expect(home(".scope :global(.ts-detail-header)")).not.toMatch(/padding/);
    expect(home(".scope :global(.ts-detail-header > h1)")).toMatch(/padding-block:\s*var\(--space-1\)/);
  });

  it("会议页页头长高时，键盘定位让开实际页头高度", () => {
    // 旧界面照旧按固定 48 算；新首页里读 DetailFrame 量出来的页头高度（--detail-head-h，同项目对话的 --head-h）。
    const all = rules("styles/header-capsule.module.css");
    const home = all.filter((rule) => rule.selectors.includes(`${NEW_HOME} .scope :global(.ts-detail)`)).map((rule) => rule.body).join(";");
    expect(home).toMatch(/scroll-padding-top:\s*calc\(var\(--detail-head-h, var\(--detail-header-height\)\) \+ 10px\)/);
    expect(readFileSync(new URL("../components/shell/DetailFrame.tsx", import.meta.url), "utf8")).toMatch(/setProperty\("--detail-head-h"/);
  });

  it("会议材料的名字换行，批注原文和垃圾篓只在溢出时渐隐", () => {
    const fade = /mask-image:\s*linear-gradient\(to bottom/;
    const annotations = rules("components/materials/material-annotations.module.css");
    const home = (selector: string) => annotations.filter((rule) => rule.selectors.includes(`${NEW_HOME} ${selector}`)).map((rule) => rule.body).join(";");
    expect(home(".quote")).toMatch(/max-height:\s*2lh/);
    expect(home(".removedText")).toMatch(/max-height:\s*3lh/);
    expect(home(".quote[data-over]")).toMatch(fade);
    expect(home(".removedText[data-over]")).toMatch(fade);
    // 渐隐只挂在新首页前缀加 [data-over] 上。
    expect(annotations.filter((rule) => fade.test(rule.body)).flatMap((rule) => rule.selectors).filter((selector) => !selector.startsWith(NEW_HOME) || !selector.includes("[data-over]"))).toEqual([]);
    // 量高：批注原文和垃圾篓用 FadeText。
    const source = readFileSync(new URL("../components/materials/MaterialAnnotations.tsx", import.meta.url), "utf8");
    expect(source.match(/<FadeText as="p" className=\{s\.quote\}>/g)).toHaveLength(2);
    expect(source).toMatch(/<FadeText as="p" className=\{s\.removedText\}>/);
    // 名字放不下时控件跟着长高：材料下拉钮、链接预览的域名条。
    const tabs = rules("styles/material-tabs.module.css").filter((rule) => rule.selectors.includes(`${NEW_HOME} .trigger.trigger`)).map((rule) => rule.body).join(";");
    expect(tabs).toMatch(/(^|[;\s])height:\s*auto/);
    expect(tabs).toMatch(/white-space:\s*normal/);
    const bar = rules("components/materials/materials.module.css").filter((rule) => rule.selectors.includes(`${NEW_HOME} .linkBar`)).map((rule) => rule.body).join(";");
    expect(bar).toMatch(/(^|[;\s])height:\s*auto/);
  });

  it("账号胶囊里名字折行时胶囊跟着长高", () => {
    // 旧界面的胶囊照旧 40 / 44 高；新首页里只留最小高度。
    const all = rules("styles/account-menu.module.css");
    const home = all.filter((rule) => rule.selectors.includes(`${NEW_HOME} .chip.chip`)).map((rule) => rule.body).join(";");
    expect(home).toMatch(/(^|[;\s])height:\s*auto/);
    expect(all.filter((rule) => rule.selectors.includes(".chip.chip")).map((rule) => rule.body).join(";")).toMatch(/(^|[;\s])height:\s*44px/);
  });

  it("下沿左边是没绑文件夹的「此电脑」时也算有字，右边最多一半", () => {
    const all = rules("styles/home.module.css");
    const capped = all.filter((rule) => /max-width:\s*50%/.test(rule.body) && rule.selectors.some((selector) => selector.includes(".barFoot:has(")));
    expect(capped.flatMap((rule) => rule.selectors).join(" ")).toMatch(/:is\(\.footText, \.sendTo\)/);
  });
});
