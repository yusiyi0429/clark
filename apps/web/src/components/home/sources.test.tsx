import { describe, expect, it } from "vitest";
import { createMockRunner } from "@/lib/local/mock";
import { LocalRunnerError } from "@/lib/local/runner";
import { localPanelRows, panelLabel } from "@/lib/local/modelPanel";
import { defaultSourceLabel, pillSource, sessionModelText } from "@/lib/local/runModel";
import { latestPerSeries, sourceFailure } from "./AddSourceDialog";

describe("添加来源（17.2 第 52 条）", () => {
  it("勾模型那一步：每个系列最新的默认勾上（同一系列只勾排在前面的那个）", () => {
    expect(latestPerSeries([{ id: "claude-opus-5-5", name: "Opus 5.5" }, { id: "claude-sonnet-5-5", name: "Sonnet 5.5" }, { id: "claude-opus-5-1", name: "Opus 5.1" }, { id: "claude-sonnet-4-5", name: "Sonnet 4.5" }]))
      .toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(latestPerSeries([{ id: "kimi-k2.5", name: "kimi-k2.5" }, { id: "kimi-k2-turbo", name: "kimi-k2-turbo" }, { id: "kimi-k2-0905", name: "kimi-k2-0905" }])).toEqual(["kimi-k2.5", "kimi-k2-turbo"]);
  });

  it("没成写一个词：Key 不对、连不上这一家、没有能用的模型、连不上本机程序；老本机程序（501）写还不支持", () => {
    expect(sourceFailure(new LocalRunnerError("source_key_rejected", "x", 422))).toBe("Key 不对");
    expect(sourceFailure(new LocalRunnerError("source_unreachable", "x", 502), "Kimi")).toBe("连不上Kimi");
    expect(sourceFailure(new LocalRunnerError("source_no_models", "x", 422))).toBe("这个 Key 没有能用的模型");
    expect(sourceFailure(new LocalRunnerError("network", "x"))).toBe("连不上本机程序");
    expect(sourceFailure(new LocalRunnerError("internal", "x", 501))).toBe("本机程序还不支持");
  });

  it("假本机：按 Key 开头认得出的直接回模型；认不出给候选；选了再认；加了每个模型一条 src- 配置、带 sourceId，面板来源里出现；同一家再加是换模型；删了配置跟着没", async () => {
    const runner = createMockRunner({ stepMs: 1 });
    const known = await runner.checkSource({ apiKey: "sk-ant-api03-xxx" });
    expect(known).toMatchObject({ recognized: { presetId: "anthropic", plan: "api", region: null }, verified: true });
    expect(known.models[0]).toEqual({ id: "claude-opus-5-5", name: "Opus 5.5" });
    const unknown = await runner.checkSource({ apiKey: "sk-123" });
    expect(unknown.recognized).toBeNull();
    expect(unknown.candidates).toContain("kimi");
    expect(await runner.checkSource({ apiKey: "sk-123", presetId: "kimi" })).toMatchObject({ recognized: { presetId: "kimi", plan: "api", region: "cn" } });
    await expect(runner.checkSource({ apiKey: "sk-bad", presetId: "deepseek" })).rejects.toMatchObject({ code: "source_key_rejected" });
    const { source, profiles } = await runner.addSource({ apiKey: "sk-ant-api03-xxx", presetId: "anthropic", plan: "api", models: ["claude-opus-5-5", "claude-sonnet-5-5"] });
    expect(source).toMatchObject({ id: "anthropic-api", name: "Anthropic 官方 API", models: [{ name: "Opus 5.5" }, { name: "Sonnet 5.5" }] });
    const added = profiles.filter((profile) => profile.sourceId === "anthropic-api");
    expect(added.map((profile) => profile.id)).toEqual(["src-anthropic-api-claude-opus-5-5", "src-anthropic-api-claude-sonnet-5-5"]);
    const rows = localPanelRows({ models: profiles, modelId: added[0]!.id, effort: null, canAddSource: true });
    expect(rows.map((row) => row.value)).toEqual(["Claude Code", "Anthropic 官方 API", "Opus 5.5", "自动"]);
    expect(rows[1]!.options.map((option) => option.label)).toContain("Anthropic 官方 API");
    await runner.addSource({ apiKey: "sk-ant-api03-yyy", presetId: "anthropic", plan: "api", models: ["claude-opus-5-5"] });
    expect((await runner.listModels()).filter((profile) => profile.sourceId === "anthropic-api")).toHaveLength(1);
    expect((await runner.listSources()).sources.map((entry) => entry.id)).toEqual(["anthropic-api"]);
    await runner.deleteSource("anthropic-api");
    expect((await runner.listModels()).some((profile) => profile.sourceId)).toBe(false);
  });

  it("胶囊：不是默认来源时模型名后面多写来源，「Anthropic 官方 API」写「API」：「Opus 5.5 · API · 最高」；默认来源照旧", async () => {
    const runner = createMockRunner({ stepMs: 1 });
    const { profiles } = await runner.addSource({ apiKey: "sk-ant-x", presetId: "anthropic", plan: "api", models: ["claude-opus-5-5"] });
    const fallback = defaultSourceLabel(profiles);
    expect(fallback).toBe("Claude 订阅");
    expect(pillSource("Anthropic 官方 API")).toBe("API");
    const api = profiles.find((profile) => profile.sourceId === "anthropic-api")!;
    expect(panelLabel({ ...api, efforts: ["low", "max"] }, "max", fallback)).toBe("Opus 5.5 · API · 最高");
    expect(panelLabel(profiles.find((profile) => profile.id === "sub-haiku")!, "high", fallback)).toBe("Haiku 5.5 · 高");
    const run = { origin: { provider: "anthropic", label: "Anthropic 官方 API", via: null }, modelName: "Opus 5.5" };
    expect(sessionModelText({ run, agent: "claude-code", effort: "max" } as never, ["max"], fallback)?.label).toBe("Opus 5.5 · API · 最高");
    expect(sessionModelText({ run: { ...run, origin: { provider: "claude-subscription", label: "Claude 订阅", via: null } }, agent: "claude-code", effort: "max" } as never, ["max"], fallback)?.label).toBe("Opus 5.5 · 最高");
  });
});
