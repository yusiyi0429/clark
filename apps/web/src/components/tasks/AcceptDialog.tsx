"use client";

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
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

const KIND: Record<TMaterialView["format"], string> = { markdown: "Markdown", docx: "Word", pdf: "PDF", html: "HTML", link: "链接" };
const kindOf = (material: TMaterialView) => material.format === "link" ? linkHost(material.url ?? "") : KIND[material.format];
const hasDraft = (draft: Draft | null | undefined): draft is Draft => !!draft && (!!draft.verdict || draft.standards.length > 0 || draft.deliverableMaterialIds.length > 0);
const checksOf = (draft: Draft | null, count: number) => new Map((draft?.standards ?? []).filter((check) => check.index < count).map((check) => [check.index, check]));

/**
 * 验收（design-12 §4）：对照完成标准逐条打勾、选交付结果、写一句结论，推进人点「验收完成」这件事才算完成。
 * 外部工具提交时带了草稿就直接预填；没有就请我的 Agent 起草（只读，30 秒内没回就留空，手填照样能验收）。
 * 草稿只是预填，不替人点「验收完成」。右上角关闭和 Esc 只关弹窗；「还要继续做」才清掉这次提交。
 * quick（首页卡片上的「验收」）：同一个弹窗的简化版——完成标准和交付结果照样列出来对照，勾不勾都行；
 * 不请 Agent 起草、不写结论（外部工具提交时写的结论照带），没有「还要继续做」，多一个「完整验收」去二级页。
 */
export function AcceptDialog({ detail, materials, onClose, onDone, onStale, onOpenMaterial, quick }: {
  detail: Detail;
  materials: TMaterialView[];
  onClose: () => void;
  /** 验收完成（accepted）或「还要继续做」之后：页面换上最新的事项再关弹窗（等它换好，免得封面先闪一下半新不旧的样子）。 */
  onDone: (task: Task, accepted: boolean) => Promise<void>;
  /** 这件事刚被别处改过：重读一遍再让人核对。 */
  onStale: () => void;
  /** 首页上点开时没有材料阅读区：依据里的材料只写名字。 */
  onOpenMaterial?: (id: string) => void;
  quick?: { onFull: () => void };
}) {
  const task = detail.task;
  const standards = detail.standards;
  const submission = detail.submission;
  /** 外部工具提交时带来的草稿：一打开就是预填好的样子。 */
  const submitted = hasDraft(submission) ? submission : null;
  const [checks, setChecks] = useState<Map<number, StandardCheck>>(() => checksOf(submitted, standards.length));
  // 交付结果按 id 记：从通知直接打开时材料可能还没读到，显示和提交时再对照现有材料。
  const [deliverables, setDeliverables] = useState<Set<string>>(() => new Set(submitted?.deliverableMaterialIds ?? []));
  const [verdict, setVerdict] = useState(submitted?.verdict ?? "");
  const [drafting, setDrafting] = useState<"loading" | "agent" | "none">(submitted ? "agent" : quick ? "none" : "loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** 人已经动过了：草稿晚到也不覆盖人的选择。 */
  const touched = useRef(false);
  useEffect(() => {
    if (submitted || quick) return;
    const controller = new AbortController();
    void browserApi.POST("/api/me/tasks/{id}/acceptance-draft", { params: { path: { id: task.id } }, signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return;
        if (!data || !hasDraft(data) || touched.current) { setDrafting("none"); return; }
        setChecks(checksOf(data, standards.length));
        setDeliverables(new Set(data.deliverableMaterialIds));
        setVerdict(data.verdict ?? "");
        setDrafting("agent");
      })
      .catch(() => { if (!controller.signal.aborted) setDrafting("none"); });
    return () => controller.abort();
    // 只在打开时起草一次；之后的改动都是人的。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const mark = (index: number, met: boolean) => {
    touched.current = true;
    setChecks((current) => new Map(current).set(index, { index, met, evidence: current.get(index)?.evidence ?? null, materialId: current.get(index)?.materialId ?? null }));
  };
  const pick = (id: string, selected: boolean) => {
    touched.current = true;
    setDeliverables((current) => { const next = new Set(current); if (selected) next.add(id); else next.delete(id); return next; });
  };
  const met = standards.filter((_, index) => checks.get(index)?.met).length;
  const accept = async () => {
    setBusy(true); setError("");
    try {
      const { data, error: failure, response } = await browserApi.POST("/api/me/tasks/{id}/accept", { params: { path: { id: task.id } }, body: {
        version: task.version, verdict: verdict.trim() || null, deliverableMaterialIds: materials.filter((material) => deliverables.has(material.id)).map((material) => material.id),
        standards: [...checks.values()].map(({ index, met: reached, evidence, materialId }) => ({ index, met: reached, evidence: evidence ?? null,
          materialId: materialId && materials.some((material) => material.id === materialId) ? materialId : null })),
      } });
      if (data) { window.dispatchEvent(new Event("member-tasks-changed")); await onDone(data, true); return; }
      if (response.status === 409 && (failure as { latestTask?: Task } | undefined)?.latestTask) {
        setError("这件事刚被改过，已换成最新的样子，请核对后再验收。");
        onStale();
      } else setError(failure?.message ?? "没验收成，请重试。");
    } catch { setError("没验收成，网络断了，请重试。"); }
    finally { setBusy(false); }
  };
  const keepGoing = async () => {
    setBusy(true); setError("");
    try {
      const { data, error: failure } = await browserApi.DELETE("/api/me/tasks/{id}/submission", { params: { path: { id: task.id }, query: { version: task.version } } });
      if (data) { window.dispatchEvent(new Event("member-tasks-changed")); await onDone(data, false); return; }
      setError(failure?.message ?? "没成功，请重试。");
      onStale();
    } catch { setError("没成功，网络断了，请重试。"); }
    finally { setBusy(false); }
  };
  const agentWrote = drafting === "agent";
  return <MenuDialog title={`验收「${task.title}」`} wide onClose={onClose}>
    <div className={a.body}>
      {drafting === "loading" ? <p className={a.thinking} role="status"><span className={a.pulse} aria-hidden />我的 Agent 在对照完成标准</p> : null}

      <section className={a.block} aria-label="对照完成标准">
        <div className={a.head}><h3>对照完成标准</h3>{standards.length ? <span className={a.count} data-all={met === standards.length}>{met} / {standards.length} 达到</span> : null}</div>
        {standards.length ? <div className={a.checks}>{standards.map((text, index) => {
          const check = checks.get(index);
          const material = check?.materialId ? materials.find((item) => item.id === check.materialId) : undefined;
          return <div key={index} className={a.check}>
            <Checkbox className={a.checkbox} isSelected={!!check?.met} onChange={(selected) => mark(index, selected)}>
              <Checkbox.Content className={a.checkContent}>
                <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
                <Label className={a.checkLabel}>{text}</Label>
              </Checkbox.Content>
            </Checkbox>
            {material || check?.evidence ? <p className={a.evidence}>依据：{material ? onOpenMaterial
              ? <button type="button" onClick={() => { onClose(); onOpenMaterial(material.id); }}>{material.fileName}</button> : material.fileName : null}
              {material && check?.evidence ? "，" : ""}{check?.evidence}</p> : null}
          </div>;
        })}</div> : <p className={a.muted}>没写完成标准</p>}
      </section>

      {materials.length ? <section className={a.block} aria-label="交付结果">
        <div className={a.head}><h3>交付结果</h3></div>
        <div className={a.deliverables}>{materials.map((material) => <Checkbox key={material.id} className={a.deliverable}
          isSelected={deliverables.has(material.id)} onChange={(selected) => pick(material.id, selected)}>
          <Checkbox.Content className={a.deliverableText}>
            <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
            <Label className={a.deliverableName}>{material.fileName}</Label><span className={a.kind}>{kindOf(material)}</span>
          </Checkbox.Content>
        </Checkbox>)}</div>
      </section> : null}

      {quick ? (verdict ? <p className={a.submittedVerdict}>{verdict}</p> : null) : <TextField className={a.verdict} value={verdict} onChange={(value) => { touched.current = true; setVerdict(value); }} maxLength={200}>
        <div className={a.head}><Label className={a.verdictLabel}>一句结论</Label><span className={a.note}>{agentWrote && verdict ? "Agent 起草" : "可不填"}</span></div>
        <TextArea rows={2} placeholder="这件事交付了什么" />
      </TextField>}

      {error ? <p className={a.error} role="alert">{error}</p> : null}
      <div className={a.actions}>
        {quick ? <Button variant="ghost" className={a.full} isDisabled={busy} onPress={quick.onFull}>完整验收</Button> : null}
        {submission && !quick ? <Button variant="secondary" isDisabled={busy} onPress={() => void keepGoing()}>还要继续做</Button> : null}
        <Button variant="primary" isDisabled={busy} onPress={() => void accept()}><Check size={15} strokeWidth={2.4} aria-hidden />{busy ? "保存中…" : "验收完成"}</Button>
      </div>
    </div>
  </MenuDialog>;
}
