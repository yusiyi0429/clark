"use client";

/**
 * 项目对话输入框下面右边的模型（17.2 第 36 条，B 契约 f508dda5；天枢伙伴的对话没有）：
 * 点开先是模型——「默认 · 模型名」在前（不选，照 Chat 配的），再是能选的几个（「名字 · 来源」）；下面一组是这个模型支持的思考程度（off 写「不思考」）。
 * 选了交给云端（PUT /api/me/projects/:projectId/pipeline/model），下一轮起生效；没改成在旁边写「没改成」加「重试」。能选的为空（没接 Chat）时不出选择。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Dropdown, Header } from "@heroui/react";
import { Check, ChevronDown } from "lucide-react";
import type { TConversationModelChoice, TConversationModelOption, TModelEffort } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { listConversationModels, readPipelineModel, setPipelineModel } from "@/lib/board/cloud";
import { effortText } from "@/lib/local/runModel";
import { ICON } from "./StateIcon";
import { FootText } from "./InputFooter";
import h from "@/styles/home.module.css";

const DEFAULT_KEY = "default";
const EFFORT_KEY = "effort:";
const keyOf = (model: Pick<TConversationModelOption, "source" | "modelId">) => `${model.source}/${model.modelId}`;

/** 现在用的模型和思考程度：没选时是默认那个和它的默认档。 */
export function pipelineCurrent(models: readonly TConversationModelOption[], choice: TConversationModelChoice | null) {
  const fallback = models.find((model) => model.isDefault) ?? models[0] ?? null;
  const model = (choice && models.find((entry) => keyOf(entry) === keyOf(choice))) || fallback;
  return { model, effort: choice?.effort ?? model?.defaultEffort ?? null, isDefault: !choice };
}

/** 胶囊上写的：没选「默认 · 模型名」，选了「模型名 · 思考程度」；悬停写来源和思考程度。 */
export function pipelineLabel(models: readonly TConversationModelOption[], choice: TConversationModelChoice | null): { label: string; title: string } | null {
  const { model, effort, isDefault } = pipelineCurrent(models, choice);
  if (!model) return null;
  const level = effort ? effortText(effort) : null;
  return {
    label: isDefault ? `默认 · ${model.label}` : `${model.label}${level ? ` · ${level}` : ""}`,
    title: [isDefault ? "默认" : null, model.label, model.source, level ? `思考程度 ${level}` : null].filter(Boolean).join(" · "),
  };
}

/** 选了一个模型：原来的思考程度它也支持就留着，不然用它的默认档。 */
export function choiceFor(model: TConversationModelOption, effort: TModelEffort | null): TConversationModelChoice {
  return { source: model.source, modelId: model.modelId, effort: effort && model.efforts.includes(effort) ? effort : model.defaultEffort };
}

export function PipelineModelMenu({ projectId, fallback }: { projectId: string; fallback: ReactNode }) {
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
  const { model: current, effort, isDefault } = pipelineCurrent(models, choice);
  const pick = (key: string) => {
    if (key === DEFAULT_KEY) { if (!isDefault) void save(null); return; }
    if (key.startsWith(EFFORT_KEY)) {
      const next = key.slice(EFFORT_KEY.length) as TModelEffort;
      if (current && (isDefault || next !== effort)) void save({ source: current.source, modelId: current.modelId, effort: next });
      return;
    }
    const model = models.find((entry) => keyOf(entry) === key);
    if (model && (isDefault || key !== keyOf(choice!))) void save(choiceFor(model, effort));
  };
  const fallbackModel = models.find((model) => model.isDefault) ?? models[0]!;
  return (
    <>
      {failed !== undefined ? <FootText testId="pipeline-model-failed">没改成<HeroButton variant="ghost" size="sm" onPress={() => void save(failed)}>重试</HeroButton></FootText> : null}
      <Dropdown>
        <Dropdown.Trigger className={h.sendTo} aria-label={`模型：${shown.title}`} data-testid="pipeline-model"><b title={shown.title}>{shown.label}</b><ChevronDown {...ICON} /></Dropdown.Trigger>
        <Dropdown.Popover placement="top end" offset={8} className={h.pop}>
          <Dropdown.Menu aria-label="模型" className={h.menuList} onAction={(key) => pick(String(key))}>
            <Dropdown.Section className={h.menuSection}>
              <Dropdown.Item id={DEFAULT_KEY} textValue={`默认 ${fallbackModel.label}`} className={h.menuItem}>
                <span className={h.grow}>默认<span className={h.menuFaint}> · {fallbackModel.label}</span></span>{isDefault ? <Check {...ICON} /> : null}
              </Dropdown.Item>
              {models.map((model) => (
                <Dropdown.Item key={keyOf(model)} id={keyOf(model)} textValue={`${model.label} ${model.source}`} className={h.menuItem} data-testid="pipeline-model-option">
                  <span className={h.grow}>{model.label}<span className={h.menuFaint}> · {model.source}</span></span>{!isDefault && current && keyOf(current) === keyOf(model) ? <Check {...ICON} /> : null}
                </Dropdown.Item>
              ))}
            </Dropdown.Section>
            {current && current.efforts.length ? (
              <Dropdown.Section className={h.menuSection}>
                <Header className={h.menuHeader}>思考程度</Header>
                {current.efforts.map((entry) => (
                  <Dropdown.Item key={entry} id={`${EFFORT_KEY}${entry}`} textValue={effortText(entry)} className={h.menuItem} data-testid="pipeline-effort-option">
                    <span className={h.grow}>{effortText(entry)}</span>{entry === effort ? <Check {...ICON} /> : null}
                  </Dropdown.Item>
                ))}
              </Dropdown.Section>
            ) : null}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </>
  );
}
