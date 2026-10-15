import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySourceContext, issueAnchorId, sectionAnchorId } from "@/cards/meetingSources";
import { citationRoute, openCitation, registerCitationPanel, registerPageCitations, resetCitationBridge, type PageCitations } from "./citationBridge";

// 深度讨论 v2：回答里的来源点下去去哪——页内能定位的交给页面（滚过去、短暂高亮），不在页里的在依据面板打开。
const root = (ids: string[]) => ({ querySelector: (selector: string) => (ids.some((id) => selector === `#${id}`) ? {} : null) }) as unknown as HTMLElement;
const page = (ids: string[] = [], issueIds: string[] = []): PageCitations & { open: ReturnType<typeof vi.fn> } => ({
  context: emptySourceContext({ issueIds }),
  root: () => root(ids),
  open: vi.fn(),
});

beforeEach(() => vi.stubGlobal("CSS", { escape: (value: string) => value }));
afterEach(() => { resetCitationBridge(); vi.unstubAllGlobals(); });

describe("来源点下去去哪", () => {
  it("认不出的 ref 不去任何地方", () => {
    expect(citationRoute("whatever", "rail", page())).toBe("none");
    expect(citationRoute("bogus:1", "sheet", null)).toBe("none");
  });

  it("首页对话层（sheet）一律依据面板；右列没有页面登记也是依据面板", () => {
    expect(citationRoute("memory:kd-strategy.md#s3", "sheet", page())).toBe("panel");
    expect(citationRoute("memory:kd-strategy.md#s3", "rail", null)).toBe("panel");
  });

  it("右列有页面登记：企业知识、群材料、群讨论、历史决定都交给页面（页面自己定位或开依据面板）", () => {
    const current = page();
    for (const ref of ["memory:kd-strategy.md#s3", "material:9b1c3b1e-7c55-4c4c-9a8e-2f1d4b7a6c10@v2#p3", "discussion:42", "decision:r-1", "meeting:m-1"]) {
      expect(citationRoute(ref, "rail", current)).toBe("page");
    }
  });

  it("议题 / 议题研究：页里有那一块就交给页面；没有（页面会跳去议题页）就在依据面板看，不离开对话", () => {
    expect(citationRoute("research:i-1", "rail", page([sectionAnchorId("i-1", "evidence")], ["i-1"]))).toBe("page");
    expect(citationRoute("issue:i-1", "rail", page([issueAnchorId("i-1")], ["i-1"]))).toBe("page");
    expect(citationRoute("research:i-1", "rail", page([], ["i-1"]))).toBe("panel");
    expect(citationRoute("issue:i-2", "rail", page([], ["i-1"]))).toBe("panel");
  });

  it("openCitation：交给最后登记的页面并要短暂高亮；面板收到 ref 与所在那一面；注销后不再交给它", () => {
    const panel = vi.fn();
    const unregisterPanel = registerCitationPanel(panel);
    const first = page();
    const second = page();
    const unregisterFirst = registerPageCitations(first);
    const unregisterSecond = registerPageCitations(second);
    const trigger = {} as HTMLElement;
    expect(openCitation("memory:kd-strategy.md#s3", { surface: "rail", trigger })).toBe("page");
    expect(second.open).toHaveBeenCalledWith("memory:kd-strategy.md#s3", { trigger, flash: "brief" });
    expect(first.open).not.toHaveBeenCalled();
    unregisterSecond();
    unregisterFirst();
    expect(openCitation("memory:kd-strategy.md#s3", { surface: "rail", trigger })).toBe("panel");
    expect(panel).toHaveBeenCalledWith("memory:kd-strategy.md#s3", { surface: "rail", trigger });
    expect(openCitation("memory:kd-strategy.md#s3", { surface: "sheet" })).toBe("panel");
    // 首页那一层在二级页底下是 inert 的：它登记的导航不接，交给面板。
    const hidden = { ...page(), root: () => ({ isConnected: true, closest: () => ({}) }) as unknown as HTMLElement, open: vi.fn() };
    const unregisterHidden = registerPageCitations(hidden);
    expect(openCitation("memory:kd-strategy.md#s3", { surface: "rail" })).toBe("panel");
    expect(hidden.open).not.toHaveBeenCalled();
    unregisterHidden();
    unregisterPanel();
    expect(openCitation("memory:kd-strategy.md#s3", { surface: "sheet" })).toBe("none");
  });
});
