import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DetailFrame } from "./DetailFrame";

/** 本人 11/18：会议页（以及挂在新首页展示区里的其它 DetailFrame 页）的返回压在左上角的「收起左栏」上。 */
describe("新首页里的二级页框", () => {
  const css = readFileSync(fileURLToPath(new URL("../../styles/home.module.css", import.meta.url)), "utf8");

  it("新首页里 DetailFrame 的页头给收起按钮让位，返回只有箭头", () => {
    // 让位规则认的结构：页头是 header.ts-detail-header，返回带 data-close-view，读屏名称照旧「返回总览」。
    const html = renderToStaticMarkup(<DetailFrame title="验收开会" onBack={() => undefined} />);
    expect(html).toMatch(/<header class="ts-detail-header">[^]*<button[^>]*data-close-view[^>]*>[^]*返回总览[^]*<\/button>/);
    // 电脑上整条页头往右让出收起按钮（同 viewHead 那条：两个间距加一颗 32）；手机没有收起按钮，不让。
    expect(css).toMatch(/\.app:not\(\[data-phone\]\) \.display :global\(\.ts-detail-header\) \{ padding-left: calc\(var\(--space-2\) \* 2 \+ var\(--row-32\)\); \}/);
    // 返回在新首页只露箭头：字号走一种字号的变量压成 0（home-type.css 的 !important 盖掉了 header-capsule 的 font-size: 0）。
    expect(css).toMatch(/\.display :global\(\.ts-detail-header \[data-close-view\]\) \{ --type-size: 0px; \}/);
    // 会议页的工作区自带 z-index: 70（老界面要盖住总览）：新首页里关在自己的层里，收起按钮（z-index: 6）才露得出来、点得到。
    const meeting = readFileSync(fileURLToPath(new URL("../../styles/meeting-view.module.css", import.meta.url)), "utf8");
    expect(meeting).toMatch(/^\.root \{ isolation: isolate; /m);
  });
});
