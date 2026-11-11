"use client";

/**
 * 添加来源的小弹窗（设计 17.2 第 52 条），样子照连 TokenHub、新建项目那一种：
 * 1. 只有一个 Key 框：贴上就交给本机认（POST /v1/sources/check，不存）。认出来直接到第 2 步；认不出列几家候选让选，或「自定义」填名字、地址、模型名。
 * 2. 勾模型：每个系列最新的默认勾上（本机建议先勾的排在前面）；有两种的选「API / 编程套餐」，有国内国际的选地区，换了重新认。
 * 3. 完成：写来源名和几个模型。
 * 换 Key（连接页）：同一个弹窗，厂商、种类、地区不变，模型照原来勾着。Key 只交给本机程序（127.0.0.1），不经过云端。
 */
import { useEffect, useRef, useState } from "react";
import { Modal } from "@heroui/react";
import { Check, Eye, EyeOff } from "lucide-react";
import type { TLocalSource, TLocalSourceCheckResponse, TLocalSourceModel, TLocalSourcePlan, TLocalSourcePreset, TLocalSourceRegion } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { SegmentedSwitch } from "@/components/SegmentedSwitch";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { LocalRunnerError } from "@/lib/local/runner";
import { ICON, StateIcon } from "./StateIcon";
import h from "@/styles/home.module.css";
import p from "@/styles/home-pages.module.css";

const PLAN_LABEL: Record<TLocalSourcePlan, string> = { api: "API", coding_plan: "编程套餐" };
const REGION_LABEL: Record<TLocalSourceRegion, string> = { cn: "国内", intl: "国际" };
/** 贴完多久没再动就去认（手打的时候不一个字一个字地认）。 */
const SETTLE_MS = 500;

/** 没成的原因：本机认、验 Key 的几种照写，别的照本机程序回的。 */
export function sourceFailure(error: unknown, name?: string | null): string {
  if (error instanceof LocalRunnerError) {
    if (error.code === "source_key_rejected") return "Key 不对";
    if (error.code === "source_unreachable") return name ? `连不上${name}` : "连不上";
    if (error.code === "source_no_models") return "这个 Key 没有能用的模型";
    if (error.code === "network") return "连不上本机程序";
    if (error.status === 501 || error.status === 404) return "本机程序还不支持";
  }
  return (error instanceof Error && error.message) || "没成";
}

/** 每个系列最新的一个（本机按建议排好，同系列第一个就是最新的）：名字里的版本号、日期去掉以后一样的算一个系列。 */
export function latestPerSeries(models: readonly TLocalSourceModel[]): string[] {
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const model of models) {
    const series = model.name.toLowerCase().replace(/[-_]\d{4,}$/, "").replace(/\d+(?:\.\d+)*/g, "#");
    if (seen.has(series)) continue;
    seen.add(series);
    picked.push(model.id);
  }
  return picked;
}

type Found = { presetId: string; plan: TLocalSourcePlan; region: TLocalSourceRegion | null; models: TLocalSourceModel[] };
type Step = { kind: "key" } | { kind: "pick"; candidates: string[] } | { kind: "custom" } | { kind: "models"; found: Found } | { kind: "done"; source: TLocalSource };

export function AddSourceDialog({ onClose, source = null }: { onClose: () => void; /** 换 Key：这个来源（厂商、种类、地区不变）。 */ source?: TLocalSource | null }) {
  const local = useLocalRunner();
  const presets = local.sources?.presets ?? [];
  const presetOf = (id: string | null | undefined): TLocalSourcePreset | null => presets.find((entry) => entry.id === id) ?? null;
  const [key, setKey] = useState("");
  const [shown, setShown] = useState(false);
  const [step, setStep] = useState<Step>({ kind: "key" });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [custom, setCustom] = useState({ name: "", baseUrl: "", models: "" });
  const asked = useRef(0);
  const apiKey = key.trim();
  const rekey = !!source;

  /** 认、验一次：认出来到勾模型；认不出列候选；自定义的换 Key 直接到填写那一步。 */
  const check = async (body: { presetId?: string | null; plan?: TLocalSourcePlan; region?: TLocalSourceRegion }) => {
    if (!apiKey) return;
    if (rekey && !source!.presetId) { setCustom({ name: source!.name, baseUrl: source!.baseUrl, models: source!.models.map((model) => model.id).join(", ") }); setStep({ kind: "custom" }); return; }
    const ticket = ++asked.current;
    setBusy(true);
    setFailed(null);
    try {
      const answer: TLocalSourceCheckResponse = await local.runner.checkSource({ apiKey, ...body });
      if (ticket !== asked.current) return;
      if (!answer.recognized) { setStep({ kind: "pick", candidates: answer.candidates }); return; }
      const found = { ...answer.recognized, models: answer.models };
      const before = source?.models.map((model) => model.id).filter((id) => answer.models.some((model) => model.id === id)) ?? [];
      setChecked(before.length ? before : latestPerSeries(answer.models));
      setStep({ kind: "models", found });
    } catch (error) {
      if (ticket === asked.current) setFailed(sourceFailure(error, presetOf(body.presetId)?.name));
    } finally {
      if (ticket === asked.current) setBusy(false);
    }
  };
  const first = () => check(source ? { presetId: source.presetId, plan: source.plan, ...(source.region ? { region: source.region } : {}) } : {});

  // 贴上或打完停一会儿就去认（第 1 步）。
  useEffect(() => {
    if (step.kind !== "key" || !apiKey) return;
    const timer = window.setTimeout(() => void first(), SETTLE_MS);
    return () => window.clearTimeout(timer);
    // first 每次都是新的；只跟着 Key 走。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, step.kind]);

  const add = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const body = step.kind === "models"
        ? { apiKey, presetId: step.found.presetId, plan: step.found.plan, ...(step.found.region ? { region: step.found.region } : {}), models: checked }
        : { apiKey, presetId: null, name: custom.name.trim(), baseUrl: custom.baseUrl.trim(), format: "anthropic" as const, models: custom.models.split(/[\s,，]+/).filter(Boolean) };
      const { source: added } = await local.runner.addSource(body);
      await local.refresh();
      setStep({ kind: "done", source: added });
    } catch (error) {
      setFailed(sourceFailure(error, step.kind === "models" ? presetOf(step.found.presetId)?.name : custom.name));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) => setChecked((list) => (list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id]));
  const customReady = !!custom.name.trim() && /^https?:\/\/.{4,}/.test(custom.baseUrl.trim()) && !!custom.models.trim();
  const title = step.kind === "done" ? "已添加" : rekey ? `换 Key · ${source!.name}` : "添加来源";

  const keyField = (
    <div className={p.keyBlock}>
      <div className={p.keyField}>
        <input className={h.projectName} autoFocus type={shown ? "text" : "password"} aria-label="API Key" placeholder="API Key" maxLength={400}
          autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" value={key} aria-invalid={failed ? true : undefined} data-testid="source-key"
          onChange={(event) => { setKey(event.currentTarget.value); setFailed(null); if (step.kind !== "key") setStep({ kind: "key" }); }}
          onKeyDown={(event) => { if (!event.nativeEvent.isComposing && event.key === "Enter") { event.preventDefault(); void first(); } }} />
        <button type="button" className={`${h.icon} ${p.keyEye}`} aria-label={shown ? "隐藏" : "显示"} aria-pressed={shown} title={shown ? "隐藏" : "显示"}
          onClick={() => setShown((on) => !on)}>{shown ? <EyeOff {...ICON} /> : <Eye {...ICON} />}</button>
      </div>
    </div>
  );

  const body = (() => {
    switch (step.kind) {
      case "key":
        return <>{keyField}{busy ? <p className={p.sourceState}><StateIcon state="running" label="正在认" />正在认</p> : null}</>;
      case "pick": {
        const ids = step.candidates.length ? step.candidates : presets.map((entry) => entry.id);
        return (
          <>{keyField}
            <div className={p.sourceList} role="list" aria-label="是哪一家" data-testid="source-candidates">
              {ids.map((id) => presetOf(id)).filter((entry): entry is TLocalSourcePreset => !!entry).map((preset) => (
                <button key={preset.id} type="button" role="listitem" className={`${h.menuItem} ${p.sourceOption}`} disabled={busy} onClick={() => void check({ presetId: preset.id })}>{preset.name}</button>
              ))}
              <button type="button" role="listitem" className={`${h.menuItem} ${p.sourceOption}`} disabled={busy} onClick={() => setStep({ kind: "custom" })}>自定义</button>
            </div>
          </>
        );
      }
      case "custom":
        return (
          <div className={p.sourceFields}>
            {keyField}
            <input className={h.projectName} aria-label="名字" placeholder="名字" maxLength={60} value={custom.name} onChange={(event) => setCustom({ ...custom, name: event.currentTarget.value })} data-testid="source-name" />
            <input className={h.projectName} aria-label="地址" placeholder="https://" maxLength={300} spellCheck={false} value={custom.baseUrl} onChange={(event) => setCustom({ ...custom, baseUrl: event.currentTarget.value })} data-testid="source-url" />
            <input className={h.projectName} aria-label="模型名" placeholder="模型名" maxLength={600} spellCheck={false} value={custom.models} onChange={(event) => setCustom({ ...custom, models: event.currentTarget.value })} data-testid="source-models-typed" />
          </div>
        );
      case "models": {
        const { found } = step;
        const preset = presetOf(found.presetId);
        return (
          <>
            <div className={p.sourceHead}>
              <b>{preset?.name ?? found.presetId}</b>
              {preset && preset.plans.length > 1 && !rekey ? <SegmentedSwitch label="种类" selected={found.plan} onSelect={(plan) => void check({ presetId: found.presetId, plan, ...(found.region ? { region: found.region } : {}) })}
                segments={preset.plans.map((plan) => ({ id: plan, label: PLAN_LABEL[plan] }))} /> : null}
              {preset && preset.regions.length > 1 && !rekey ? <SegmentedSwitch label="地区" selected={found.region ?? "cn"} onSelect={(region) => void check({ presetId: found.presetId, plan: found.plan, region })}
                segments={preset.regions.map((region) => ({ id: region, label: REGION_LABEL[region] }))} /> : null}
            </div>
            <div className={p.sourceList} role="group" aria-label="模型" data-testid="source-models">
              {found.models.map((model) => {
                const on = checked.includes(model.id);
                return (
                  <button key={model.id} type="button" role="checkbox" aria-checked={on} className={`${h.menuItem} ${p.sourceOption}`} disabled={busy} onClick={() => toggle(model.id)} title={model.id}>
                    <span className={h.grow}>{model.name}</span><span className={h.panelMark}>{on ? <Check {...ICON} aria-hidden /> : null}</span>
                  </button>
                );
              })}
            </div>
          </>
        );
      }
      case "done":
        return <p className={p.sourceDone} data-testid="source-done"><b>{step.source.name}</b><span>{step.source.models.length} 个模型</span></p>;
    }
  })();

  const primary = step.kind === "done" ? <HeroButton variant="primary" onPress={onClose} data-testid="source-finish">完成</HeroButton>
    : step.kind === "models" ? <HeroButton variant="primary" isDisabled={!checked.length || busy} onPress={() => void add()} data-testid="source-add">添加</HeroButton>
    : step.kind === "custom" ? <HeroButton variant="primary" isDisabled={!apiKey || !customReady || busy} onPress={() => void add()} data-testid="source-add">添加</HeroButton>
    : null;

  return (
    <Modal isOpen onOpenChange={(open) => { if (!open) onClose(); }}>
      <Modal.Backdrop className={h.dialogBackdrop} isDismissable>
        <Modal.Container size="sm">
          <Modal.Dialog className={h.dialog} aria-label={title} data-testid="source-dialog">
            <h2 className={h.dialogTitle}>{title}</h2>
            {body}
            {failed ? <p className={p.error} role="alert" data-testid="source-error">{failed}</p> : null}
            <div className={h.dialogActions}>
              {step.kind === "done" ? null : <HeroButton variant="tertiary" onPress={onClose}>取消</HeroButton>}
              {primary}
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
