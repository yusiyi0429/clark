import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TCardDraftView, TLocalModelProfile } from "@warmap/contracts";
import { LocalContext } from "./LocalRunnerProvider";
import { createMockRunner } from "./mock";
import { chatModelLabel, runLabel } from "./runModel";
import { ModelChip } from "@/components/home/Conversations";
import { PlanDecision } from "@/components/home/PlanDecision";

describe("项目主管线、伙伴台页头的「来源 · 模型」", () => {
  it("写法同子会话：来源写给人看的名字，模型去掉网关前缀、Claude 写成「Opus 5.5」；查不到的原样；没报模型的不出", () => {
    expect(chatModelLabel({ provider: "tokenhub", model: "wangsu/claude-opus-5-5" })).toBe("TokenHub · Opus 5.5");
    expect(chatModelLabel({ provider: "tokenhub", model: "wangsu/qwen3.8-flash" })).toBe("TokenHub · qwen3.8-flash");
    expect(chatModelLabel({ provider: "openrouter", model: "claude-sonnet-4-20250514" })).toBe("openrouter · Sonnet 4");
    expect(renderToStaticMarkup(<ModelChip data={{ model: { provider: "tokenhub", model: "wangsu/claude-opus-5-5" } }} />)).toContain("TokenHub · Opus 5.5");
    expect(renderToStaticMarkup(<ModelChip data={{ model: null }} />)).toBe("");
  });
});

describe("子会话显示「来源 · 模型」", () => {
  it("写成「来源 · 模型」，实际跑的优先；只有来源时只写来源；老版本本机不报来源时为 null", () => {
    expect(runLabel({ sourceLabel: "我的 Claude 订阅", modelName: "Opus", actual: null })).toBe("我的 Claude 订阅 · Opus");
    expect(runLabel({ sourceLabel: "我的 Claude 订阅", modelName: "Opus", actual: { model: "claude-sonnet-5-5", modelName: "Sonnet 5.5", at: "2026-11-08T12:00:00Z" } }))
      .toBe("我的 Claude 订阅 · Sonnet 5.5");
    expect(runLabel({ sourceLabel: "TokenHub", modelName: null })).toBe("TokenHub");
    expect(runLabel({ modelName: "Opus 5.5" })).toBeNull();
    expect(runLabel(null)).toBeNull();
  });

  it("开工前预览：本机回落到哪个来源的哪个模型（actual 为 null）；开工后执行方报了实际的", async () => {
    const runner = createMockRunner({ stepMs: 1 });
    expect(runLabel(await runner.previewRun({ modelProfileId: "tokenhub-deepseek" }))).toBe("TokenHub · DeepSeek · deepseek-v4.1-flash");
    const preview = await runner.previewRun({});
    expect(preview.actual).toBeNull();
    const session = await runner.createSession({ subject: { kind: "card", cardId: "c1" }, title: "卡", cwd: "C:\\work\\tianshu", firstMessage: "交代", modelProfileId: "sub-haiku" });
    expect(runLabel(session.run)).toBe("订阅 · Haiku · Haiku 5.5");
    for (let i = 0; i < 100 && !(await runner.listSessions())[0]!.run?.actual; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect((await runner.listSessions())[0]!.run?.actual?.modelName).toBe("Haiku 5.5");
  });

  it("开工选项框每一步右边：没单独选时写「自动 · …」；本机还没回预览时先写模型配置的名字", () => {
    const models: TLocalModelProfile[] = [{ id: "subscription", label: "我的 Claude 订阅", source: "subscription", agent: "claude-code", baseUrl: null, model: null, smallModel: null, webSearch: true, hasKey: false, isDefault: true }];
    const local = { runner: createMockRunner(), phase: "offline", version: null, status: null, models, folders: [], sessions: [], pairing: null, error: null,
      refresh: vi.fn(), pair: vi.fn(), unpair: vi.fn(), pickFolder: vi.fn(), setIncludePersonal: vi.fn() } as unknown as Parameters<typeof LocalContext.Provider>[0]["value"];
    const draft: TCardDraftView = { id: "00000000-0000-4000-8000-0000000000d1", planId: "00000000-0000-4000-8000-0000000000b1", position: 0, title: "派活单组件", brief: "",
      doneDefinition: "做完", criterionIndex: 1, executor: "claude_code", modelTier: "normal", why: null, role: { id: "00000000-0000-4000-8000-000000000001", name: "开发", kind: "worker" },
      suggestPresetKey: null, sourceWords: [] };
    const html = renderToStaticMarkup(<LocalContext.Provider value={local}>
      <PlanDecision target={{ taskId: "t1" }} name="派活单" drafts={[draft]} roles={[]} handheld={false} onSay={vi.fn()} onChanged={vi.fn()} />
    </LocalContext.Provider>);
    expect(html).toContain("自动 · 我的 Claude 订阅");
  });
});
