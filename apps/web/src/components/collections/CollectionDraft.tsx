"use client";

/**
 * ③ 信息收集的草稿卡（对话里「发起信息收集」之后挂在回答下面）。参照 Superhuman 的发送前预览：
 * 表头（大家要填的那张表长什么样）、收件人、截止、每周固定在一张卡里，「发送」只在卡底；发出后变成一行「已发给…」和「打开」。
 * 读回历史时按收集任务的最新状态显示。
 */
import { useEffect, useState } from "react";
import { ArrowUp, Check, ChevronRight, Repeat } from "lucide-react";
import { Button } from "ts-design/primitives";
import type { TCollectionView } from "@warmap/contracts";
import { useWorkspace } from "@/components/shell/WorkspaceContext";
import { DateTimePicker } from "@/components/ui/DatePicker";
import { Select } from "@/components/ui/Select";
import { requestError } from "@/components/requests/requestApi";
import r from "@/components/requests/requests.module.css";
import { deadlineText, fromPickerValue, readCollection, requestsBase, runCollectionAction, toPickerValue } from "./collectionApi";
import c from "./collections.module.css";

const initial = (name: string) => name.trim().slice(-1);
const SCENARIO: Record<TCollectionView["scenario"], string> = { expense: "每周开销", method_progress: "每周进展" };

export function CollectionDraftCard({ collectionId }: { collectionId: string }) {
  const { navigate } = useWorkspace();
  const [view, setView] = useState<TCollectionView | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    readCollection(collectionId).then((next) => { if (live) setView(next); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [collectionId]);
  if (failed) return <section className={c.card}><p className={c.muted}>收集任务已不可见</p></section>;
  if (!view) return <section className={c.card}><div className={c.placeholder} aria-busy="true" /></section>;
  if (view.status !== "draft") {
    const names = view.entries.map((entry) => entry.displayName).join("、");
    return (
      <section className={c.card} aria-label="已发出的收集">
        <div className={c.sent}><Check size={14} strokeWidth={2.6} aria-hidden="true" />已发给 <strong>{names}</strong><time>截止 {deadlineText(view.round?.deadlineAt ?? view.deadlineAt)}</time>
          {view.weekly ? <span className={r.tag} data-tone={view.status === "active" ? "wait" : undefined}><Repeat size={12} aria-hidden="true" />&nbsp;{view.status === "active" ? "每周固定" : "已停用"}</span> : null}
        </div>
        <div className={c.sentFoot}>
          <p className={c.quoted}>{view.title}</p>
          {view.round ? <Button variant="ghost" className={r.ghost} onPress={() => navigate(`${requestsBase()}/${view.round!.requestId}`)}>打开<ChevronRight size={16} aria-hidden="true" /></Button> : null}
        </div>
      </section>
    );
  }
  return <DraftPreview view={view} onSent={setView} />;
}

function DraftPreview({ view, onSent }: { view: TCollectionView; onSent: (next: TCollectionView) => void }) {
  const [chosen, setChosen] = useState(() => view.candidates.map((person) => person.personId));
  const [extra, setExtra] = useState<{ personId: string; displayName: string }[]>([]);
  const [deadline, setDeadline] = useState(() => toPickerValue(view.deadlineAt));
  const [weekly, setWeekly] = useState(view.weekly);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const people = [...view.candidates, ...extra.filter((person) => !view.candidates.some((candidate) => candidate.personId === person.personId))];
  const addable = view.directory.filter((person) => !people.some((shown) => shown.personId === person.personId));
  const send = view.actions.find((action) => action.actionType === "collection.send");
  const future = deadline.length === 16 && new Date(fromPickerValue(deadline)).getTime() > Date.now();
  const canSend = Boolean(send) && chosen.length > 0 && future && !busy;
  const toggle = (personId: string) => setChosen((current) => current.includes(personId) ? current.filter((id) => id !== personId) : [...current, personId]);
  const submit = async () => {
    if (!send || !canSend) return;
    setBusy(true); setError("");
    try { onSent(await runCollectionAction(send, { recipientIds: chosen, deadlineAt: fromPickerValue(deadline), weekly })); }
    catch (cause) { setError(requestError(cause, "没有发出去，请重试")); setBusy(false); }
  };

  return (
    <section className={`${r.preview} ${c.draft}`} aria-label="收集草稿">
      <header className={c.draftHead}>
        <span className={c.subject}>{view.title}</span>
        <span className={r.tag}>{SCENARIO[view.scenario]}</span>
      </header>
      <div className={c.tablePreview} role="table" aria-label="表头">
        <div role="row">
          <span role="columnheader">填写人</span>
          {view.fields.map((field) => <span role="columnheader" key={field.key} data-optional={field.required ? undefined : ""}>{field.label}</span>)}
        </div>
      </div>
      <div className={r.toRow}>
        <span className={r.fieldName}>收件人</span>
        <div className={r.chips}>
          {people.map((person) => {
            const on = chosen.includes(person.personId);
            return <button key={person.personId} type="button" className={r.personChip} aria-pressed={on} disabled={busy} onClick={() => toggle(person.personId)}>
              <span className={r.avatar} aria-hidden="true">{on ? <Check size={12} strokeWidth={3} /> : initial(person.displayName)}</span>{person.displayName}
            </button>;
          })}
          {addable.length ? <Select size="compact" className={r.addPerson} aria-label="添加收件人" placeholder="添加" value=""
            options={addable.map((person) => ({ value: person.personId, label: person.displayName }))}
            onChange={(personId) => {
              const person = addable.find((candidate) => candidate.personId === personId);
              if (!person) return;
              setExtra((current) => [...current, person]);
              setChosen((current) => [...current, person.personId]);
            }} /> : null}
        </div>
      </div>
      <div className={`${r.toRow} ${c.optionRow}`}>
        <span className={r.fieldName}>截止</span>
        <div className={c.options}>
          <DateTimePicker label="截止" size="compact" value={deadline} onChange={setDeadline} disabled={busy} />
          <button type="button" className={r.personChip + " " + c.weekly} aria-pressed={weekly} disabled={busy} onClick={() => setWeekly((on) => !on)}>
            <span className={r.avatar} aria-hidden="true">{weekly ? <Check size={12} strokeWidth={3} /> : <Repeat size={12} />}</span>每周固定
          </button>
        </div>
      </div>
      {error ? <p className={`${r.error} ${c.inset}`} role="alert">{error}</p> : null}
      <footer className={r.previewFoot}>
        <span className={r.version}>v{view.version}</span>
        <Button variant="primary" className={r.primary} isDisabled={!canSend} onPress={() => void submit()}>
          <ArrowUp size={16} aria-hidden="true" />{busy ? "发送中" : "发送"}
        </Button>
      </footer>
    </section>
  );
}
