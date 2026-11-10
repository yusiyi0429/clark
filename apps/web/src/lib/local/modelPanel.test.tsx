import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelPanel } from "@/components/home/ModelPanel";
import { TOOL_STATE } from "@/components/home/BackgroundPanel";
import { usageCells } from "@/lib/home/quota";
import { createMockRunner } from "./mock";
import { AUTO_EFFORT, agentBlock, localPanelRows, panelLabel, pickLocal, rowOpens } from "./modelPanel";

const NOW = Date.now();
async function panel(codex: "logged_in" | "logged_out", modelId: string, effort: Parameters<typeof localPanelRows>[0]["effort"] = null, agentsAllowed?: Parameters<typeof localPanelRows>[0]["agentsAllowed"]) {
  const runner = createMockRunner({ stepMs: 1, codex });
  const [models, status] = await Promise.all([runner.listModels(), runner.status()]);
  return { models, rows: localPanelRows({ models, modelId, effort, cells: usageCells(status.quota, NOW), agents: status.agents, now: NOW, agentsAllowed }) };
}

describe("选模型的三行（17.2 第 40 条）", () => {
  it("来源、模型、思考三行，右边是现在的值；叫法是「Claude 订阅」「Codex 订阅」「TokenHub」，不写「我的」，同一个东西不出现两次", async () => {
    const { rows } = await panel("logged_in", "subscription");
    expect(rows.map((row) => [row.name, row.value])).toEqual([["来源", "Claude 订阅"], ["模型", "默认"], ["思考", "自动"]]);
    const [source, model, effort] = rows;
    expect(source!.options.map((option) => option.label)).toEqual(["Claude 订阅", "TokenHub", "Codex 订阅"]);
    expect(model!.options.map((option) => option.label)).toEqual(["默认", "Haiku"]);
    expect(effort!.options.map((option) => option.label)).toEqual(["自动", "低", "中", "高", "超高", "最高"]);
    expect(JSON.stringify(rows)).not.toContain("我的");
    expect(localPanelRows({ models: [], modelId: null, effort: null })).toEqual([]);
  });

  it("来源那一页右边写剩余用量（和右栏同一套数）；没登录、没装的置灰并写状态词（和右栏同一套词），哪怕它还没有模型", async () => {
    const { rows } = await panel("logged_out", "subscription");
    expect(rows[0]!.options).toEqual([
      { id: "claude", label: "Claude 订阅", note: "17%", disabled: false },
      { id: "gateway:TokenHub", label: "TokenHub", note: "¥12.4", disabled: false },
      { id: "codex", label: "Codex 订阅", note: "没登录", disabled: true },
    ]);
    const words = [agentBlock({ installed: false, loggedIn: false, loginExpiresAt: null }, NOW), agentBlock({ installed: true, loggedIn: false, loginExpiresAt: null }, NOW),
      agentBlock({ installed: true, loggedIn: true, loginExpiresAt: new Date(NOW - 1000).toISOString() }, NOW)];
    expect(words).toEqual([TOOL_STATE.not_installed, TOOL_STATE.not_logged_in, TOOL_STATE.expired]);
    expect(agentBlock({ installed: true, loggedIn: true, loginExpiresAt: null }, NOW)).toBeNull();
  });

  it("只许某个执行方时别的来源置灰（开着的子会话、规划员和验收员），现在选着的那个不灰", async () => {
    const { rows } = await panel("logged_in", "subscription", null, ["claude-code"]);
    expect(rows[0]!.options.map((option) => [option.label, option.disabled])).toEqual([["Claude 订阅", false], ["TokenHub", false], ["Codex 订阅", true]]);
    expect(rows[0]!.options.find((option) => option.id === "codex")?.note).toBe("64%");
  });

  it("联动：换来源，模型落到那个来源的默认；换模型，原来的思考档它支持就留着，不支持回到自动", async () => {
    const { models } = await panel("logged_in", "subscription");
    expect(pickLocal(models, { modelId: "subscription", effort: "high" }, "source", "codex")).toEqual({ modelId: "codex-gpt-6_1-sol", effort: "high" });
    expect(pickLocal(models, { modelId: "subscription", effort: "max" }, "model", "codex-gpt-5_5")).toEqual({ modelId: "codex-gpt-5_5", effort: null });
    expect(pickLocal(models, { modelId: "sub-haiku", effort: "high" }, "source", "gateway:TokenHub")).toEqual({ modelId: "tokenhub-deepseek", effort: null });
    expect(pickLocal(models, { modelId: "tokenhub-deepseek", effort: null }, "source", "claude")).toEqual({ modelId: "subscription", effort: null });
    expect(pickLocal(models, { modelId: "sub-haiku", effort: "high" }, "effort", AUTO_EFFORT)).toEqual({ modelId: "sub-haiku", effort: null });
    expect(pickLocal(models, { modelId: "sub-haiku", effort: null }, "effort", "xhigh")).toEqual({ modelId: "sub-haiku", effort: "xhigh" });
    expect(pickLocal(models, { modelId: "sub-haiku", effort: null }, "source", "gateway:nope")).toBeNull();
  });

  it("只列得出一项的那一行点不开：网关只有一个模型、不能选思考", async () => {
    const { rows } = await panel("logged_in", "tokenhub-deepseek", "high");
    expect(rows.map((row) => [row.value, rowOpens(row)])).toEqual([["TokenHub", true], ["deepseek-v4.1-flash", false], ["自动", false]]);
  });

  it("胶囊写「模型名 · 思考档」，思考是自动时只写模型名；订阅默认那个读不到模型名，写来源名", async () => {
    const { models } = await panel("logged_in", "subscription");
    const of = (id: string) => models.find((model) => model.id === id)!;
    expect(panelLabel(of("sub-haiku"), "high")).toBe("Haiku · 高");
    expect(panelLabel(of("sub-haiku"), null)).toBe("Haiku");
    expect(panelLabel(of("subscription"), null)).toBe("Claude 订阅");
    expect(panelLabel(of("codex-gpt-6_1-sol"), "ultra")).toBe("GPT-6.1-Sol · 极限");
    expect(panelLabel(of("tokenhub-deepseek"), "high")).toBe("deepseek-v4.1-flash");
  });

  it("入口是胶囊：写给它的字，悬停是全称；没点开不画三行", async () => {
    const { rows } = await panel("logged_in", "sub-haiku", "high");
    const html = renderToStaticMarkup(<ModelPanel label="Haiku · 高" title="Claude Code · Haiku · Claude 订阅 · 思考 高" rows={rows} onPick={vi.fn()} testId="session-model" />);
    expect(html).toContain('aria-label="模型：Claude Code · Haiku · Claude 订阅 · 思考 高"');
    expect(html).toMatch(/<b title="[^"]*">Haiku · 高<\/b>/);
    expect(html).not.toContain("来源");
    const sheet = renderToStaticMarkup(<ModelPanel sheet label="Haiku · 高" rows={rows} onPick={vi.fn()} />);
    expect(sheet).toContain('aria-haspopup="dialog"');
    expect(sheet).not.toContain("model-panel-sheet");
  });
});
