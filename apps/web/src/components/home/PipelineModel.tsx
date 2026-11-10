"use client";

/**
 * 项目对话输入框下面右边的模型（17.2 第 36、40 条，B 契约 f508dda5；天枢伙伴的对话没有）：
 * 胶囊写「模型名 · 思考档」（思考是自动时只写模型名），点开是三行——来源、模型、思考（components/home/ModelPanel）。
 * 思考那一页「自动」是这个模型自己的默认档（右边淡色写是哪档），别的几档列在下面，off 写「不思考」。
 * 选了交给云端（PUT /api/me/projects/:projectId/pipeline/model），下一轮起生效；选回默认那个模型加自动就是「没选」（choice = null，照 Chat 配的）。
 * 没改成在旁边写「没改成」加「重试」。能选的为空（没接 Chat）时不出选择。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { TConversationModelChoice, TConversationModelOption, TModelEffort } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { listConversationModels, readPipelineModel, setPipelineModel } from "@/lib/board/cloud";
import { AUTO_EFFORT, ROW_NAME, type PanelRow, type PanelRowKey } from "@/lib/local/modelPanel";
import { effortText } from "@/lib/local/runModel";
import { FootText } from "./InputFooter";
import { ModelPanel } from "./ModelPanel";

const keyOf = (model: Pick<TConversationModelOption, "source" | "modelId">) => `${model.source}/${model.modelId}`;
const fallbackOf = (models: readonly TConversationModelOption[]) => models.find((model) => model.isDefault) ?? models[0] ?? null;

/** 现在用的模型和思考程度：没选时是默认那个和它的默认档。auto：思考是不是这个模型自己的默认档。 */
export function pipelineCurrent(models: readonly TConversationModelOption[], choice: TConversationModelChoice | null) {
  const model = (choice && models.find((entry) => keyOf(entry) === keyOf(choice))) || fallbackOf(models);
  const effort = choice?.effort ?? model?.defaultEffort ?? null;
  return { model, effort, auto: !model || effort === model.defaultEffort };
}

/** 胶囊上写的：「模型名 · 思考档」，思考是自动时只写模型名；悬停写来源和思考。 */
export function pipelineLabel(models: readonly TConversationModelOption[], choice: TConversationModelChoice | null): { label: string; title: string } | null {
  const { model, effort, auto } = pipelineCurrent(models, choice);
  if (!model) return null;
  const level = effortText(auto ? null : effort);
  return { label: auto ? model.label : `${model.label} · ${level}`, title: [model.label, model.source, `思考 ${level}`].join(" · ") };
}

/** 三行：来源、模型、思考。 */
export function pipelineRows(models: readonly TConversationModelOption[], choice: TConversationModelChoice | null): PanelRow[] {
  const { model, effort, auto } = pipelineCurrent(models, choice);
  if (!model) return [];
  const sources = [...new Set(models.map((entry) => entry.source))];
  return [
    { key: "source", name: ROW_NAME.source, value: model.source, selected: model.source, options: sources.map((source) => ({ id: source, label: source })) },
    { key: "model", name: ROW_NAME.model, value: model.label, selected: keyOf(model), options: models.filter((entry) => entry.source === model.source).map((entry) => ({ id: keyOf(entry), label: entry.label })) },
    { key: "effort", name: ROW_NAME.effort, value: effortText(auto ? null : effort), selected: auto || !effort ? AUTO_EFFORT : effort,
      options: [{ id: AUTO_EFFORT, label: effortText(null), note: effortText(model.defaultEffort) },
        ...model.efforts.filter((entry) => entry !== model.defaultEffort).map((entry) => ({ id: entry, label: effortText(entry) }))] },
  ];
}

/**
 * 在某一行选了一项以后存什么：换来源落到那个来源的默认模型；换模型时原来选的思考档它支持就留着，不然自动（它的默认档）。
 * 默认那个模型加自动是「没选」，存 null。
 */
export function pipelinePick(models: readonly TConversationModelOption[], choice: TConversationModelChoice | null, row: PanelRowKey, id: string): TConversationModelChoice | null | undefined {
  const { model, effort, auto } = pipelineCurrent(models, choice);
  if (!model) return undefined;
  const next = row === "effort" ? model
    : row === "source" ? models.find((entry) => entry.source === id && entry.isDefault) ?? models.find((entry) => entry.source === id)
    : models.find((entry) => keyOf(entry) === id);
  if (!next) return undefined;
  const level = row === "effort" ? (id === AUTO_EFFORT ? next.defaultEffort : id as TModelEffort)
    : !auto && effort && next.efforts.includes(effort) ? effort : next.defaultEffort;
  const fallback = fallbackOf(models);
  return fallback && keyOf(next) === keyOf(fallback) && level === next.defaultEffort ? null : { source: next.source, modelId: next.modelId, effort: level };
}

export function PipelineModelMenu({ projectId, fallback, sheet = false }: { projectId: string; fallback: ReactNode; /** 手持：从底部升起。 */ sheet?: boolean }) {
  const [models, setModels] = useState<TConversationModelOption[]>([]);
  const [choice, setChoice] = useState<TConversationModelChoice | null>(null);
  const [failed, setFailed] = useState<TConversationModelChoice | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void Promise.all([listConversationModels(), readPipelineModel(projectId)]).then(([list, current]) => {
      if (!alive) return;
      setModels(list.models);
      setChoice(current.choice);
    }, () => undefined);
    return () => { alive = false; };
  }, [projectId]);
  const save = useCallback(async (next: TConversationModelChoice | null) => {
    setFailed(undefined);
    try { setChoice((await setPipelineModel(projectId, next)).choice); }
    catch { setFailed(next); }
  }, [projectId]);
  const shown = pipelineLabel(models, choice);
  if (!models.length || !shown) return <>{fallback}</>;
  const pick = (row: PanelRowKey, id: string) => {
    const next = pipelinePick(models, choice, row, id);
    if (next !== undefined) void save(next);
  };
  return (
    <>
      {failed !== undefined ? <FootText testId="pipeline-model-failed">没改成<HeroButton variant="ghost" size="sm" onPress={() => void save(failed)}>重试</HeroButton></FootText> : null}
      <ModelPanel label={shown.label} title={shown.title} rows={pipelineRows(models, choice)} onPick={pick} sheet={sheet} testId="pipeline-model" />
    </>
  );
}
