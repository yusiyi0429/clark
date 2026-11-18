import { readFileSync } from "node:fs";
import type { HTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * 共用模块里的预览（批注胶囊、伙伴记忆、会议目录……）：和新首页自己的预览一样量高，只在放不下时挂 data-over 渐隐。
 * 没有 jsdom：FadeText 换成同样调 markOverflow 的桩，量到的高度由 box 给（scrollHeight、clientHeight），挂没挂 data-over 照实写进标记。
 */
const box = vi.hoisted(() => ({ scroll: 46, client: 46 }));
vi.mock("@/lib/home/overflowFade", async (original) => {
  const real = await original<typeof import("@/lib/home/overflowFade")>();
  return {
    ...real,
    FadeText: ({ as: Tag = "span", children, ...rest }: { as?: "span" | "div" | "p" } & HTMLAttributes<HTMLElement>) => {
      const marks = new Set<string>();
      real.markOverflow({ scrollHeight: box.scroll, clientHeight: box.client, toggleAttribute: (name, on) => { if (on) marks.add(name); else marks.delete(name); return on; } });
      return <Tag {...rest} data-measured="" data-over={marks.has("data-over") ? "" : undefined}>{children}</Tag>;
    },
  };
});

import { QuoteChips } from "@/conversation/QuoteChips";
import { PartnerMemories } from "@/components/memory/PartnerMemories";
import { MeetingOutline } from "@/components/meeting/MeetingOutline";

const VERTICAL = /mask-image:\s*linear-gradient\(to bottom/;
const NEW_HOME = ':global(:root:has([data-type-scale="one"]))';
const rules = (file: string) => [...readFileSync(new URL(`../../${file}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
  .matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1].trim().replace(/\s+/g, " "), body: match[2] }));

const render = () => [
  renderToStaticMarkup(<QuoteChips quotes={[{ id: "q", text: "先把清单发给财务" }]} onRemove={() => undefined} />),
  renderToStaticMarkup(<PartnerMemories memory={{ available: true, items: [{ id: "m1", text: "周三前要把验收清单发给财务。", category: "fact", updatedAt: "2026-11-17T02:00:00Z", project: null, tentative: false }] } as never} />),
  renderToStaticMarkup(<MeetingOutline items={[{ key: "a", label: "议题一：验收口径要不要按两种角色拆开" }]} active={{ key: "a", sub: null }} onJump={() => undefined} />),
].join("\n");

describe("共用模块的渐隐（本人 11/18）", () => {
  it("共用模块里一行、两行没超出的字不渐隐", () => {
    // 刚好放得下（一行、两行都一样：内容高等于格子高）：量了，但不挂 data-over。
    Object.assign(box, { scroll: 46, client: 46 });
    const fit = render();
    expect(fit.match(/data-measured=""/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(fit).not.toContain("data-over");
    // 放不下才挂。
    Object.assign(box, { scroll: 90, client: 46 });
    expect(render().match(/data-over=""/g)?.length ?? 0).toBeGreaterThanOrEqual(3);

    // 七个共用模块：往下渐隐的 mask 只挂在新首页前缀加 [data-over] 上。
    for (const file of ["styles/conversation-quotes.module.css", "styles/scope-chip.module.css", "styles/issue-suggest.module.css", "styles/rich-blocks.module.css",
      "styles/meeting-workspace.module.css", "styles/entry-cards.module.css", "components/memory/memory.module.css"]) {
      const fades = rules(file).filter((rule) => VERTICAL.test(rule.body));
      expect(fades.length, file).toBeGreaterThan(0);
      expect(fades.filter((rule) => !rule.selector.split(",").every((part) => part.trim().startsWith(NEW_HOME) && part.includes("[data-over]"))).map((rule) => `${file} ${rule.selector}`)).toEqual([]);
    }
  });
});
