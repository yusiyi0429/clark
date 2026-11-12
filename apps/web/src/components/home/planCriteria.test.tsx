import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));

import type { TCardDraftView } from "@warmap/contracts";
import { LocalContext, type LocalRunnerState } from "@/lib/local/LocalRunnerProvider";
import { createMockRunner } from "@/lib/local/mock";
import { PlanDecision } from "./PlanDecision";

const draft = (id: string, doneDefinition: string, sourceWords: string[] = []): TCardDraftView => ({
  id, planId: "00000000-0000-4000-8000-0000000000b1", position: 0, title: `第 ${id.slice(-1)} 步`, brief: "", doneDefinition, criterionIndex: 1, executor: "claude_code", modelTier: "normal",
  why: null, role: { id: "00000000-0000-4000-8000-000000000001", name: "开发", kind: "worker" }, suggestPresetKey: null, sourceWords, modelWords: null,
});
const render = async (drafts: TCardDraftView[]) => {
  const runner = createMockRunner({ stepMs: 1 });
  const local = { runner, phase: "offline", version: null, status: null, models: await runner.listModels(), folders: [], sessions: [], pairing: null, error: null,
    refresh: vi.fn(), pair: vi.fn(), unpair: vi.fn(), pickFolder: vi.fn(), setIncludePersonal: vi.fn() } as unknown as LocalRunnerState;
  return renderToStaticMarkup(<LocalContext.Provider value={local}>
    <PlanDecision target={{ taskId: "t1" }} name="派活单" drafts={drafts} roles={[]} handheld={false} onSay={vi.fn()} onChanged={vi.fn()} />
  </LocalContext.Provider>);
};
const lists = (html: string) => [...html.matchAll(/<ul[^>]*data-testid="plan-criteria"[^>]*>(.*?)<\/ul>/g)].map((match) => [...match[1]!.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((item) => item[1]!.replace(/<[^>]+>/g, "")));

describe("派活单每一步列出完成标准（11/12 验收第 13 条）", () => {
  it("原话下面一行一条（去掉空行和首尾空白）；不超过 3 条全露、没有「还有」", async () => {
    const html = await render([draft("00000000-0000-4000-8000-0000000000d1", "首页能看到派活单\n\n  每步列出完成标准  ", ["派活单上看不到完成标准"])]);
    expect(lists(html)).toEqual([["首页能看到派活单", "每步列出完成标准"]]);
    expect(html.indexOf('data-testid="source-words"')).toBeLessThan(html.indexOf('data-testid="plan-criteria"'));
    expect(html).not.toContain("还有");
  });

  it("超过 3 条先露 3 条，末尾一行「还有 N 条」是按钮（键盘能点）；每一步各算各的", async () => {
    const html = await render([
      draft("00000000-0000-4000-8000-0000000000d1", "一\n二\n三\n四\n五"),
      draft("00000000-0000-4000-8000-0000000000d2", "甲\n乙\n丙\n丁"),
    ]);
    expect(lists(html)).toEqual([["一", "二", "三", "还有 2 条"], ["甲", "乙", "丙", "还有 1 条"]]);
    expect(html).toMatch(/<button type="button"[^>]*>还有 2 条<\/button>/);
  });
});
