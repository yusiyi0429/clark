import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelPanel } from "@/components/home/ModelPanel";
import { TOOL_STATE } from "@/components/home/BackgroundPanel";
import { usageCells } from "@/lib/home/quota";
import { createMockRunner } from "./mock";
import { ADD_SOURCE, AUTO_EFFORT, agentBlock, localPanelRows, panelLabel, pickLocal, rowOpens } from "./modelPanel";

const NOW = Date.now();
async function panel(codex: "logged_in" | "logged_out", modelId: string, effort: Parameters<typeof localPanelRows>[0]["effort"] = null, agentsAllowed?: Parameters<typeof localPanelRows>[0]["agentsAllowed"]) {
  const runner = createMockRunner({ stepMs: 1, codex });
  const [models, status] = await Promise.all([runner.listModels(), runner.status()]);
  return { models, rows: localPanelRows({ models, modelId, effort, cells: usageCells(status.quota, NOW), agents: status.agents, now: NOW, agentsAllowed }) };
}

describe("选模型的四行（17.2 第 40、52 条）", () => {
  it("执行方、来源、模型、思考四行，右边是现在的值；叫法是「Claude 订阅」「Codex 订阅」「TokenHub」，不写「我的」，同一个东西不出现两次", async () => {
    const { rows } = await panel("logged_in", "subscription");
    expect(rows.map((row) => [row.name, row.value])).toEqual([["执行方", "Claude Code"], ["来源", "Claude 订阅"], ["模型", "自动"], ["思考", "自动"]]);
    const [agent, source, model, effort] = rows;
    expect(agent!.options.map((option) => [option.label, option.disabled])).toEqual([["Claude Code", false], ["Codex", false]]);
    // 别的执行方的来源也列，灰着（先在执行方那一行换）。
    expect(source!.options.map((option) => [option.label, option.disabled])).toEqual([["Claude 订阅", false], ["TokenHub", false], ["Codex 订阅", true]]);
    // 模型那一页：这个来源的几条配置——内置的「自动」、本人配的、Claude 订阅的模型目录。
    expect(model!.options.map((option) => option.label)).toEqual(["自动", "Haiku 5.5", "Opus 5.5", "Sonnet 5.5", "Fable 5.2", "Haiku 4.5"]);
    expect(effort!.options.map((option) => option.label)).toEqual(["自动", "低", "中", "高", "超高", "最高"]);
    expect(JSON.stringify(rows)).not.toContain("我的");
    expect(localPanelRows({ models: [], modelId: null, effort: null })).toEqual([]);
  });

  it("来源那一页右边写剩余用量（和右栏同一套数）；没登录、没装的置灰并写状态词（和右栏同一套词），哪怕它还没有模型", async () => {
    const { rows } = await panel("logged_out", "subscription");
    expect(rows[0]!.options).toEqual([{ id: "claude-code", label: "Claude Code", note: null, disabled: false }, { id: "codex", label: "Codex", note: "没登录", disabled: true }]);
    expect(rows[1]!.options).toEqual([
      { id: "claude-subscription", label: "Claude 订阅", note: "17%", disabled: false },
      { id: "tokenhub", label: "TokenHub", note: "¥12.4", disabled: false },
      { id: "codex", label: "Codex 订阅", note: "没登录", disabled: true },
    ]);
    const words = [agentBlock({ installed: false, loggedIn: false, loginExpiresAt: null }, NOW), agentBlock({ installed: true, loggedIn: false, loginExpiresAt: null }, NOW),
      agentBlock({ installed: true, loggedIn: true, loginExpiresAt: new Date(NOW - 1000).toISOString() }, NOW)];
    expect(words).toEqual([TOOL_STATE.not_installed, TOOL_STATE.not_logged_in, TOOL_STATE.expired]);
    expect(agentBlock({ installed: true, loggedIn: true, loginExpiresAt: null }, NOW)).toBeNull();
  });

  it("只许某个执行方时别的执行方置灰（规划员和验收员），现在选着的那个不灰", async () => {
    const { rows } = await panel("logged_in", "subscription", null, ["claude-code"]);
    expect(rows[0]!.options.map((option) => [option.label, option.disabled])).toEqual([["Claude Code", false], ["Codex", true]]);
    expect(rows[1]!.options.find((option) => option.id === "codex")).toMatchObject({ disabled: true, note: "64%" });
  });

  it("换执行方：来源它能用就不动，不能用换成它能用的第一个来源（落到默认模型）", async () => {
    const { models } = await panel("logged_in", "subscription");
    expect(pickLocal(models, { modelId: "subscription", effort: "high" }, "agent", "codex")).toEqual({ modelId: "codex-gpt-6_1-sol", effort: "high" });
    expect(pickLocal(models, { modelId: "codex-gpt-5_5", effort: null }, "agent", "claude-code")).toEqual({ modelId: "subscription", effort: null });
    const { rows } = await panel("logged_in", "codex-gpt-5_5");
    expect(rows[0]!.value).toBe("Codex");
    expect(rows[1]!.options.map((option) => [option.label, option.disabled])).toEqual([["Claude 订阅", true], ["TokenHub", true], ["Codex 订阅", false]]);
  });

  it("本机有添加来源的接口：来源那一层最底下「+ 添加来源」，选它不换模型", async () => {
    const runner = createMockRunner({ stepMs: 1 });
    const models = await runner.listModels();
    const rows = localPanelRows({ models, modelId: "subscription", effort: null, canAddSource: true });
    expect(rows[1]!.options.at(-1)).toEqual({ id: ADD_SOURCE, label: "+ 添加来源" });
    expect(localPanelRows({ models, modelId: "subscription", effort: null })[1]!.options.some((option) => option.id === ADD_SOURCE)).toBe(false);
    expect(pickLocal(models, { modelId: "subscription", effort: null }, "source", ADD_SOURCE)).toBeNull();
  });

  it("联动：换来源，模型落到那个来源的默认；换模型，原来的思考档它支持就留着，不支持回到自动", async () => {
    const { models } = await panel("logged_in", "subscription");
    expect(pickLocal(models, { modelId: "subscription", effort: "high" }, "source", "codex")).toEqual({ modelId: "codex-gpt-6_1-sol", effort: "high" });
    expect(pickLocal(models, { modelId: "subscription", effort: "max" }, "model", "codex-gpt-5_5")).toEqual({ modelId: "codex-gpt-5_5", effort: null });
    expect(pickLocal(models, { modelId: "sub-haiku", effort: "high" }, "source", "tokenhub")).toEqual({ modelId: "tokenhub-deepseek", effort: null });
    expect(pickLocal(models, { modelId: "tokenhub-deepseek", effort: null }, "source", "claude-subscription")).toEqual({ modelId: "subscription", effort: null });
    expect(pickLocal(models, { modelId: "sub-haiku", effort: "high" }, "effort", AUTO_EFFORT)).toEqual({ modelId: "sub-haiku", effort: null });
    expect(pickLocal(models, { modelId: "sub-haiku", effort: null }, "effort", "xhigh")).toEqual({ modelId: "sub-haiku", effort: "xhigh" });
    expect(pickLocal(models, { modelId: "sub-haiku", effort: null }, "source", "gateway:nope")).toBeNull();
    // 模型目录里不能选思考的（Haiku 4.5）：换过去回到自动，思考那一行点不开。
    expect(pickLocal(models, { modelId: "cc-opus", effort: "max" }, "model", "cc-claude-haiku-4-5")).toEqual({ modelId: "cc-claude-haiku-4-5", effort: null });
    expect(localPanelRows({ models, modelId: "cc-claude-haiku-4-5", effort: null }).map((row) => [row.value, rowOpens(row)])).toEqual([["Claude Code", true], ["Claude 订阅", true], ["Haiku 4.5", true], ["自动", false]]);
    // 老版本本机不带 origin、modelName：订阅按执行方归、模型名自己拼，网关按名字归。
    const old = models.map(({ origin: _origin, modelName: _name, ...rest }) => rest);
    expect(localPanelRows({ models: old, modelId: "sub-haiku", effort: null })[1]!.options.map((option) => option.id)).toEqual(["claude-subscription", "gateway:TokenHub", "codex"]);
    expect(localPanelRows({ models: old, modelId: "sub-haiku", effort: null })[2]).toMatchObject({ value: "Haiku" });
  });

  it("只列得出一项的那一行点不开：网关只有一个模型、不能选思考", async () => {
    const { rows } = await panel("logged_in", "tokenhub-deepseek", "high");
    expect(rows.map((row) => [row.value, rowOpens(row)])).toEqual([["Claude Code", true], ["TokenHub", true], ["deepseek-v4.1-flash", false], ["自动", false]]);
  });

  it("胶囊写「模型名 · 思考档」，思考是自动时只写模型名；订阅默认那个读不到模型名，写来源名", async () => {
    const { models } = await panel("logged_in", "subscription");
    const of = (id: string) => models.find((model) => model.id === id)!;
    expect(panelLabel(of("sub-haiku"), "high")).toBe("Haiku 5.5 · 高");
    expect(panelLabel(of("sub-haiku"), null)).toBe("Haiku 5.5");
    expect(panelLabel(of("cc-claude-fable-5-2"), "xhigh")).toBe("Fable 5.2 · 超高");
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
    expect(html).not.toContain("正在换");
  });
});
