import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TCardHandbackView } from "@warmap/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));

import { SessionBlocked } from "./TaskDecisions";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const handback = {
  id: "00000000-0000-4000-8000-0000000000e1", status: "done", outcome: "fail", met: 1, total: 2, overruled: false, overrule: null, error: null, sourceWordIssues: [],
  result: { criteria: [
    { index: 1, text: "列出三个候选名", verdict: "met", reason: null, fix: null },
    { index: 2, text: "每个名字查过商标近似", verdict: "unmet", reason: "只查了一个", fix: "补查另外两个" },
  ] },
} as unknown as TCardHandbackView;
const render = (patch: Partial<Parameters<typeof SessionBlocked>[0]> = {}) => renderToStaticMarkup(
  <SessionBlocked cardId="card-1" handback={handback} blocker={null} canSay onSay={async () => undefined} onStop={async () => undefined} onChanged={() => undefined} onGone={() => undefined} {...patch} />,
);

describe("子会话里受阻的框（第 54 条）", () => {
  it("写清卡在哪：没达到的几条和怎么补；选项是接受现在的结果、不做了，加补一句让它接着做", () => {
    const html = render();
    const page = text(html);
    expect(page).toContain("受阻：验收两次没过");
    expect(page).toContain("每个名字查过商标近似");
    expect(page).toContain("怎么补：补查另外两个");
    expect(page).not.toContain("列出三个候选名");
    expect(page).toContain("接受现在的结果");
    expect(page).toContain("不做了");
    expect(html).toContain('aria-label="补一句让它接着做"');
  });
  it("事项记了卡在哪就写它；不在这台电脑上没有补一句", () => {
    const html = render({ blocker: "商标库连不上", canSay: false });
    expect(text(html)).toContain("受阻：商标库连不上");
    expect(html).not.toContain("补一句让它接着做");
  });
});
