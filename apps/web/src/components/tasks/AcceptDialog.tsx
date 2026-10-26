"use client";

import { useEffect, useRef, useState } from "react";
import { Check, CornerUpLeft } from "lucide-react";
import { Button, Checkbox, Label, TextArea, TextField } from "ts-design/primitives";
import type { components } from "@/lib/api/schema";
import type { TMaterialView } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { MenuDialog } from "@/components/AccountMenu";
import { linkHost } from "@/components/materials/ObjectMaterialArea";
import a from "./accept-dialog.module.css";

type Detail = components["schemas"]["TaskDetailResponse"];
type Task = Detail["task"];
type StandardCheck = components["schemas"]["TaskStandardCheck"];
type Draft = components["schemas"]["TaskAcceptanceDraft"];
type Source = NonNullable<Detail["submission"]>["via"];
/** 本人对一条完成标准的确认：达到，或没达到并写原因。 */
type Decision = { met: boolean; reason: string };

const KIND: Record<TMaterialView["format"], string> = { markdown: "Markdown", docx: "Word", pdf: "PDF", html: "HTML", link: "链接" };
const SOURCE: Record<Source, string> = { web: "网页", codex: "Codex", claude: "Claude Code", github: "GitHub", other: "外部工具" };
const kindOf = (material: TMaterialView) => material.format === "link" ? linkHost(material.url ?? "") : KIND[material.format];
const hasDraft = (draft: Draft | null | undefined): draft is Draft => !!draft && (!!draft.verdict || draft.standards.length > 0 || draft.deliverableMaterialIds.length > 0);
const checksOf = (draft: Draft | null, count: number) => new Map((draft?.standards ?? []).filter((check) => check.index < count).map((check) => [check.index, check]));

/**
 * 验收（design-12 §4，10/26 改成逐条对标准）：每条完成标准下面是外部工具或我的 Agent 写的「是否达到 + 依据」，
 * 本人逐条确认——达到，或没达到并写原因；每条都确认了才能点按钮：全部达到是「验收完成」，有一条没达到就是「退回」（写明哪几条、为什么，接着做）。
 * 没写完成标准的先写完成标准再验收。交付结果、一句结论照旧（结论可不填）。右上角关闭和 Esc 只关弹窗。
 */
export function AcceptDialog({ detail, materials, onClose, onDone, onStale, onOpenMaterial, onEditStandards }: {
  detail: Detail;
  materials: TMaterialView[];
  onClose: () => void;
  /** 验收完成（accepted）或退回之后：页面换上最新的事项再关弹窗（等它换好，免得封面先闪一下半新不旧的样子）。 */
  onDone: (task: Task, accepted: boolean) => Promise<void>;
  /** 这件事刚被别处改过：重读一遍再让人核对。 */
  onStale: () => void;
  /** 首页上点开时没有材料阅读区：依据里的材料只写名字。 */
  onOpenMaterial?: (id: string) => void;
  /** 没写完成标准时「写完成标准」去哪儿。 */
  onEditStandards: () => void;
}) {
  const task = detail.task;
  const standards = detail.standards;
  const submission = detail.submission;
  /** 外部工具提交时带来的判断：一打开就列在每条标准下面。 */
  const submitted = hasDraft(submission) ? submission : null;
  const [agent, setAgent] = useState<Map<number, StandardCheck>>(() => checksOf(submitted, standards.length));
  const [agentName, setAgentName] = useState(submission ? SOURCE[submission.via] : "我的 Agent");
  const [decisions, setDecisions] = useState<Map<number, Decision>>(() => new Map());
  // 交付结果按 id 记：从通知直接打开时材料可能还没读到，显示和提交时再对照现有材料。
  const [deliverables, setDeliverables] = useState<Set<string>>(() => new Set(submitted?.deliverableMaterialIds ?? []));
  const [verdict, setVerdict] = useState(submitted?.verdict ?? "");
  const [drafting, setDrafting] = useState<"loading" | "agent" | "none">(submitted ? "agent" : standards.length ? "loading" : "none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** 人已经动过交付结果或结论：草稿晚到也不覆盖。 */
  const touched = useRef(false);
  useEffect(() => {
    if (submitted || !standards.length) return;
    const controller = new AbortController();
    void browserApi.POST("/api/me/tasks/{id}/acceptance-draft", { params: { path: { id: task.id } }, signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return;
        if (!data || !hasDraft(data)) { setDrafting("none"); return; }
        setAgent(checksOf(data, standards.length));
        setAgentName("我的 Agent");
        if (!touched.current) {
          setDeliverables(new Set(data.deliverableMaterialIds));
          setVerdict(data.verdict ?? "");
        }
        setDrafting("agent");
      })
      .catch(() => { if (!controller.signal.aborted) setDrafting("none"); });
    return () => controller.abort();
    // 只在打开时起草一次；之后的改动都是人的。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const decide = (index: number, met: boolean) =>
    setDecisions((current) => new Map(current).set(index, { met, reason: current.get(index)?.reason ?? "" }));
  const explain = (index: number, reason: string) =>
    setDecisions((current) => new Map(current).set(index, { met: false, reason }));
  const pick = (id: string, selected: boolean) => {
    touched.current = true;
    setDeliverables((current) => { const next = new Set(current); if (selected) next.add(id); else next.delete(id); return next; });
  };
  const decided = standards.filter((_, index) => decisions.has(index)).length;
  const missed = [...decisions.values()].some((decision) => !decision.met);
  const ready = standards.length > 0 && standards.every((_, index) => {
    const decision = decisions.get(index);
    return decision && (decision.met || decision.reason.trim());
  });
  /** 达到的那条带上工具写的依据（材料还在才带）；没达到的写本人的原因。 */
  const checks = () => standards.map((_, index) => {
    const decision = decisions.get(index)!;
    const said = agent.get(index);
    return decision.met
      ? { index, met: true, evidence: said?.met ? said.evidence ?? null : null,
        materialId: said?.met && said.materialId && materials.some((material) => material.id === said.materialId) ? said.materialId : null }
      : { index, met: false, evidence: decision.reason.trim(), materialId: null };
  });
  const finish = async () => {
    setBusy(true); setError("");
    try {
      const { data, error: failure, response } = missed
        ? await browserApi.POST("/api/me/tasks/{id}/acceptance-return", { params: { path: { id: task.id } }, body: { version: task.version, standards: checks() } })
        : await browserApi.POST("/api/me/tasks/{id}/accept", { params: { path: { id: task.id } }, body: {
          version: task.version, verdict: verdict.trim() || null, standards: checks(),
          deliverableMaterialIds: materials.filter((material) => deliverables.has(material.id)).map((material) => material.id),
        } });
      if (data) { window.dispatchEvent(new Event("member-tasks-changed")); await onDone(data, !missed); return; }
      if (response.status === 409 && (failure as { latestTask?: Task } | undefined)?.latestTask) {
        setError("这件事刚被改过，已换成最新的样子，请核对后再验收。");
        onStale();
      } else setError(failure?.message ?? "没成功，请重试。");
    } catch { setError("没成功，网络断了，请重试。"); }
    finally { setBusy(false); }
  };
  return <MenuDialog title={`验收「${task.title}」`} wide onClose={onClose}>
    <div className={a.body}>
      {drafting === "loading" ? <p className={a.thinking} role="status"><span className={a.pulse} aria-hidden />我的 Agent 在对照完成标准</p> : null}

      <section className={a.block} aria-label="对照完成标准">
        <div className={a.head}><h3>对照完成标准</h3>{standards.length ? <span className={a.count} data-all={decided === standards.length}>{decided} / {standards.length} 已确认</span> : null}</div>
        {standards.length ? <ol className={a.checks}>{standards.map((text, index) => {
          const said = agent.get(index);
          const decision = decisions.get(index);
          const material = said?.materialId ? materials.find((item) => item.id === said.materialId) : undefined;
          return <li key={index} className={a.check} data-standard={index}>
            <p className={a.standard}><span className={a.order}>{index + 1}</span>{text}</p>
            {said ? <p className={a.evidence} data-agent-met={said.met}>
              <span className={a.agentName}>{agentName}</span>{said.met ? "达到" : "没达到"}
              {material || said.evidence ? " · " : ""}
              {material ? onOpenMaterial
                ? <button type="button" onClick={() => { onClose(); onOpenMaterial(material.id); }}>{material.fileName}</button> : material.fileName : null}
              {material && said.evidence ? "，" : ""}{said.evidence}
            </p> : null}
            <div className={a.decide} role="group" aria-label={`第 ${index + 1} 条`}>
              <button type="button" aria-pressed={decision?.met === true} onClick={() => decide(index, true)}>达到</button>
              <button type="button" aria-pressed={decision?.met === false} onClick={() => decide(index, false)}>没达到</button>
            </div>
            {decision && !decision.met ? <TextField className={a.reason} value={decision.reason} onChange={(value) => explain(index, value)} maxLength={300} aria-label={`第 ${index + 1} 条没达到的原因`}>
              <TextArea rows={1} placeholder="没达到的原因" />
            </TextField> : null}
          </li>;
        })}</ol> : <p className={a.muted}>没写完成标准</p>}
      </section>

      {standards.length && materials.length ? <section className={a.block} aria-label="交付结果">
        <div className={a.head}><h3>交付结果</h3></div>
        <div className={a.deliverables}>{materials.map((material) => <Checkbox key={material.id} className={a.deliverable}
          isSelected={deliverables.has(material.id)} onChange={(selected) => pick(material.id, selected)}>
          <Checkbox.Content className={a.deliverableText}>
            <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
            <Label className={a.deliverableName}>{material.fileName}</Label><span className={a.kind}>{kindOf(material)}</span>
          </Checkbox.Content>
        </Checkbox>)}</div>
      </section> : null}

      {standards.length && !missed ? <TextField className={a.verdict} value={verdict} onChange={(value) => { touched.current = true; setVerdict(value); }} maxLength={200}>
        <div className={a.head}><Label className={a.verdictLabel}>一句结论</Label><span className={a.note}>{drafting === "agent" && verdict ? `${agentName} 起草` : "可不填"}</span></div>
        <TextArea rows={2} placeholder="这件事交付了什么" />
      </TextField> : null}

      {error ? <p className={a.error} role="alert">{error}</p> : null}
      <div className={a.actions}>
        {standards.length
          ? <Button variant="primary" className={a.solid} isDisabled={busy || !ready} onPress={() => void finish()}>
            {missed ? <CornerUpLeft size={15} strokeWidth={2.2} aria-hidden /> : <Check size={15} strokeWidth={2.4} aria-hidden />}
            {busy ? "保存中…" : missed ? "退回" : "验收完成"}
          </Button>
          : <Button variant="primary" className={a.solid} onPress={() => { onClose(); onEditStandards(); }}>写完成标准</Button>}
      </div>
    </div>
  </MenuDialog>;
}
