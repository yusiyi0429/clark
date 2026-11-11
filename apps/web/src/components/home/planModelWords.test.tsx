import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));

import type { TCardDraftView } from "@warmap/contracts";
import { LocalContext, type LocalRunnerState } from "@/lib/local/LocalRunnerProvider";
import { createMockRunner } from "@/lib/local/mock";
import { PlanDecision } from "./PlanDecision";

const draft = (id: string, modelWords: string | null): TCardDraftView => ({
  id, planId: "00000000-0000-4000-8000-0000000000b1", position: 0, title: `第 ${id.slice(-1)} 步`, brief: "", doneDefinition: "做完", criterionIndex: 1, executor: "claude_code", modelTier: "normal",
  why: null, role: { id: "00000000-0000-4000-8000-000000000001", name: "开发", kind: "worker" }, suggestPresetKey: null, sourceWords: [], modelWords,
});
const render = async (modelWords: string | null) => {
  const runner = createMockRunner({ stepMs: 1 });
  const local = { runner, phase: "offline", version: null, status: null, models: await runner.listModels(), folders: [], sessions: [], pairing: null, error: null,
    refresh: vi.fn(), pair: vi.fn(), unpair: vi.fn(), pickFolder: vi.fn(), setIncludePersonal: vi.fn() } as unknown as LocalRunnerState;
  return renderToStaticMarkup(<LocalContext.Provider value={local}>
    <PlanDecision target={{ taskId: "t1" }} name="派活单" drafts={[draft("00000000-0000-4000-8000-0000000000d1", modelWords), draft("00000000-0000-4000-8000-0000000000d2", modelWords)]}
      roles={[]} handheld={false} onSay={vi.fn()} onChanged={vi.fn()} />
  </LocalContext.Provider>);
};
const picks = (html: string) => [...html.matchAll(/data-testid="model-pick"[^>]*><span title="[^"]*">([^<]*)<\/span>/g)].map((match) => match[1]);

describe("派活单照对话里说的模型要求预选（第 69 条）", () => {
  it("对上了：每张卡的模型照原话预选（不再是「自动 · …」），思考档也照它；不多出任何字", async () => {
    const html = await render("这几件用 Haiku 5.5，思考开高");
    expect(picks(html)).toEqual(["Claude 订阅 · Haiku 5.5", "Claude 订阅 · Haiku 5.5"]);
    expect(html).not.toContain("model-words-missing");
    expect(html).not.toContain("没找到");
    expect(html.match(/<span title="高">高<\/span>/g)).toHaveLength(2);
    expect(await render("这几件用 Haiku 5.5")).not.toContain('<span title="高">高</span>');
    // 没有原话时照旧是自动。
    expect(picks(await render(null)).every((label) => label!.startsWith("自动 · "))).toBe(true);
  });

  it("没对上：单子顶上一行「没找到「原话」」（太长截断、悬停看全），模型用自动", async () => {
    const html = await render("用 Kimi 做");
    expect(html).toMatch(/<p[^>]*title="用 Kimi 做"[^>]*data-testid="model-words-missing"[^>]*>没找到「用 Kimi 做」<\/p>/);
    expect(picks(html).every((label) => label!.startsWith("自动 · "))).toBe(true);
    const long = "这几件都用一个我们还没接进来的新模型来做，思考程度先随便，回头再说具体用哪个";
    expect(await render(long)).toMatch(new RegExp(`title="${long}"[^>]*>没找到「${long.slice(0, 23)}…」`));
  });
});
