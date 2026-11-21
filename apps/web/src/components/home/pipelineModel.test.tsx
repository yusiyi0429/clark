import { describe, expect, it } from "vitest";
import type { TConversationModelOption } from "@warmap/contracts";
import { pipelineCurrent, pipelineLabel, pipelinePick, pipelineRows } from "./PipelineModel";

const SOURCE = "TokenHub · 网宿";
const models: TConversationModelOption[] = [
  { source: SOURCE, modelId: "kimi-k3", label: "Kimi K3", efforts: ["off", "low", "medium", "high"], defaultEffort: "medium", isDefault: true },
  { source: SOURCE, modelId: "deepseek-v4", label: "DeepSeek V4", efforts: ["off", "high"], defaultEffort: "off", isDefault: false },
  { source: "DeepSeek", modelId: "deepseek-r2", label: "DeepSeek R2", efforts: ["low", "high"], defaultEffort: "low", isDefault: false },
];
const choice = (modelId: string, effort: TConversationModelOption["defaultEffort"], source = SOURCE) => ({ source, modelId, effort });

describe("项目对话选模型（17.2 第 36、40 条，B 契约 f508dda5）", () => {
  it("胶囊写「来源 · 模型 · 思考」（67 条），来源只写「·」前面那段，思考是自动（这个模型自己的默认档）时不写；没选就是默认那个模型加自动，不再有「默认」那一项", () => {
    expect(pipelineLabel(models, null)).toEqual({ label: "TokenHub · Kimi K3", title: "TokenHub · 网宿 · Kimi K3 · 思考 自动" });
    expect(pipelineCurrent(models, null)).toMatchObject({ model: { modelId: "kimi-k3" }, effort: "medium", auto: true });
    expect(pipelineLabel(models, choice("kimi-k3", "off"))).toEqual({ label: "TokenHub · Kimi K3 · 不思考", title: "TokenHub · 网宿 · Kimi K3 · 思考 不思考" });
    expect(pipelineLabel(models, choice("deepseek-v4", "off"))?.label).toBe("TokenHub · DeepSeek V4");
    expect(pipelineLabel(models, choice("deepseek-r2", "high", "DeepSeek"))?.label).toBe("DeepSeek · DeepSeek R2 · 高");
    expect(pipelineLabel([], null)).toBeNull();
  });

  it("三行：来源、模型、思考；模型只列这个来源的；思考「自动」在前、右边写是哪档，别的几档不重复列它", () => {
    const [source, model, effort] = pipelineRows(models, null);
    expect([source!.name, source!.value, source!.options.map((option) => option.label)]).toEqual(["来源", SOURCE, [SOURCE, "DeepSeek"]]);
    expect([model!.name, model!.value, model!.options.map((option) => option.label)]).toEqual(["模型", "Kimi K3", ["Kimi K3", "DeepSeek V4"]]);
    expect([effort!.name, effort!.value, effort!.selected]).toEqual(["思考", "自动", "auto"]);
    expect(effort!.options.map((option) => [option.label, option.note ?? null])).toEqual([["自动", "中"], ["不思考", null], ["低", null], ["高", null]]);
    expect(pipelineRows(models, choice("kimi-k3", "high"))[2]).toMatchObject({ value: "高", selected: "high" });
    expect(pipelineRows([], null)).toEqual([]);
  });

  it("联动：换来源落到那个来源的默认模型；换模型时选过的思考档它支持就留着，不支持回到自动；默认那个模型加自动存成没选（null）", () => {
    expect(pipelinePick(models, null, "source", "DeepSeek")).toEqual(choice("deepseek-r2", "low", "DeepSeek"));
    expect(pipelinePick(models, null, "model", `${SOURCE}/deepseek-v4`)).toEqual(choice("deepseek-v4", "off"));
    expect(pipelinePick(models, choice("kimi-k3", "high"), "model", `${SOURCE}/deepseek-v4`)).toEqual(choice("deepseek-v4", "high"));
    expect(pipelinePick(models, choice("kimi-k3", "low"), "model", `${SOURCE}/deepseek-v4`)).toEqual(choice("deepseek-v4", "off"));
    expect(pipelinePick(models, null, "effort", "high")).toEqual(choice("kimi-k3", "high"));
    expect(pipelinePick(models, choice("kimi-k3", "high"), "effort", "auto")).toBeNull();
    expect(pipelinePick(models, choice("deepseek-v4", "high"), "effort", "auto")).toEqual(choice("deepseek-v4", "off"));
    expect(pipelinePick(models, choice("deepseek-v4", "off"), "source", SOURCE)).toBeNull();
    expect(pipelinePick(models, null, "model", "nope")).toBeUndefined();
  });
});
