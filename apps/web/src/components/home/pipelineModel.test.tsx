import { describe, expect, it } from "vitest";
import type { TConversationModelOption } from "@warmap/contracts";
import { choiceFor, pipelineCurrent, pipelineLabel } from "./PipelineModel";

const models: TConversationModelOption[] = [
  { source: "TokenHub · 网宿", modelId: "kimi-k3", label: "Kimi K3", efforts: ["off", "low", "medium", "high"], defaultEffort: "medium", isDefault: true },
  { source: "TokenHub · 网宿", modelId: "deepseek-v4", label: "DeepSeek V4", efforts: ["off", "high"], defaultEffort: "off", isDefault: false },
];

describe("项目对话选模型和思考程度（17.2 第 36 条，B 契约 f508dda5）", () => {
  it("没选是「默认 · 模型名」（照 Chat 的默认和它的默认档）；选了写「模型名 · 思考程度」，off 写「不思考」，来源在悬停里", () => {
    expect(pipelineLabel(models, null)).toEqual({ label: "默认 · Kimi K3", title: "默认 · Kimi K3 · TokenHub · 网宿 · 思考程度 中" });
    expect(pipelineCurrent(models, null)).toMatchObject({ model: { modelId: "kimi-k3" }, effort: "medium", isDefault: true });
    expect(pipelineLabel(models, { source: "TokenHub · 网宿", modelId: "deepseek-v4", effort: "off" })?.label).toBe("DeepSeek V4 · 不思考");
    expect(pipelineLabel([], null)).toBeNull();
  });

  it("换模型：原来的思考程度它也支持就留着，不支持用它的默认档", () => {
    expect(choiceFor(models[1]!, "high")).toEqual({ source: "TokenHub · 网宿", modelId: "deepseek-v4", effort: "high" });
    expect(choiceFor(models[1]!, "medium")).toEqual({ source: "TokenHub · 网宿", modelId: "deepseek-v4", effort: "off" });
  });
});
