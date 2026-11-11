import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));

import type { TCardDraftView } from "@warmap/contracts";
import { LocalContext, type LocalRunnerState } from "@/lib/local/LocalRunnerProvider";
import { createMockRunner } from "@/lib/local/mock";
import { matchModelWords } from "@/lib/local/modelWords";
import { AUTO_MODEL, PlanDecision, applyEdit, draftPick, modelPickPatch, type Edit } from "./PlanDecision";

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

describe("本人改过的那张以本人的为准（第 69 条）", () => {
  // 派活单里每一步用哪个模型、思考就是 draftPick；本人在模型下拉里选一项，派活单记 applyEdit(…, modelPickPatch(…))，同组件里的一样。
  it("预选之后本人改一张，派活单刷新（草稿换成新对象、原话照旧）后这张不被盖回去，别的卡照预选；选回自动也不被盖回去", async () => {
    const models = await createMockRunner({ stepMs: 1 }).listModels();
    const ids = ["00000000-0000-4000-8000-0000000000d1", "00000000-0000-4000-8000-0000000000d2", "00000000-0000-4000-8000-0000000000d3"];
    const words = "这几件用 Opus，思考开高";
    const matchOf = (text: string) => { const found = matchModelWords(text, models); return found.matched ? found : null; };
    const picks = (edits: Record<string, Edit>, drafts: ReturnType<typeof draft>[]) => {
      const matched = matchOf(drafts.find((entry) => entry.modelWords)!.modelWords!);
      return drafts.map((entry) => draftPick(edits[entry.id], matched));
    };
    let drafts = ids.map((id) => draft(id, words));
    let edits: Record<string, Edit> = {};
    expect(picks(edits, drafts)).toEqual(ids.map(() => ({ modelId: "cc-opus", effort: "high" })));
    // 本人把第一张换成 Haiku 5.5（它也支持「高」，思考留着）。
    const haiku = models.find((model) => model.id === "sub-haiku")!;
    edits = applyEdit(edits, ids[0]!, modelPickPatch(haiku.id, haiku, draftPick(edits[ids[0]!], matchOf(words)).effort));
    // 本人把第三张选回「自动」。
    edits = applyEdit(edits, ids[2]!, modelPickPatch(AUTO_MODEL, models.find((model) => model.isDefault), draftPick(edits[ids[2]!], matchOf(words)).effort));
    // 派活单刷新：草稿是新对象，原话照旧。
    drafts = ids.map((id) => draft(id, words));
    expect(picks(edits, drafts)).toEqual([{ modelId: "sub-haiku", effort: "high" }, { modelId: "cc-opus", effort: "high" }, { modelId: undefined, effort: "high" }]);
    // 只改了名字（没动模型）的那张，模型照旧跟原话走。
    edits = applyEdit(edits, ids[1]!, { title: "改个名" });
    expect(picks(edits, drafts)[1]).toEqual({ modelId: "cc-opus", effort: "high" });
  });
});
