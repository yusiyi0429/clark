"use client";

/**
 * 验收标准逐条：评完是 ✓ 达到、◐ 部分、✗ 未达到加一句理由，没评或评审中是空心圈。
 * 没达到的默认展开「依据 / 怎么补」，达到的点一下再看依据。没达到的条目旁边「我不同意」：写一句为什么，带着这句话重评这一条；
 * 重评以后还是没达到，这一条标「本人有异议」（有异议的条目不能交付）。
 */
import { useState, type FormEvent } from "react";
import { Check, ChevronRight, X } from "lucide-react";
import type { TReviewCriterion } from "@warmap/contracts";
import d from "@/styles/task-deliverable.module.css";

function Mark({ verdict }: { verdict: TReviewCriterion["verdict"] | null }) {
  if (verdict === "met") return <span className={d.mark} data-verdict="met"><Check size={13} strokeWidth={2.6} aria-label="达到" /></span>;
  if (verdict === "unmet") return <span className={d.mark} data-verdict="unmet"><X size={13} strokeWidth={2.6} aria-label="未达到" /></span>;
  if (verdict === "partial") return <span className={d.mark} data-verdict="partial" aria-label="部分达到" />;
  return <span className={d.mark} aria-hidden="true" />;
}

function Dissent({ onSend, onCancel }: { onSend: (reason: string) => Promise<string | null>; onCancel: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!reason.trim() || busy) return;
    setBusy(true);
    setError(await onSend(reason.trim()));
    setBusy(false);
  };
  return (
    <form className={d.dissent} onSubmit={(event) => void submit(event)}>
      <input value={reason} maxLength={200} autoFocus disabled={busy} placeholder="说一句为什么" aria-label="不同意的理由"
        onChange={(event) => setReason(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }} />
      <button type="submit" className={d.plain} disabled={busy || !reason.trim()}>重评</button>
      <button type="button" className={d.quiet} onClick={onCancel} disabled={busy}>取消</button>
      {error ? <p className={d.error} role="alert">{error}</p> : null}
    </form>
  );
}

export function CriteriaList({ title, texts, results, canDissent, onDissent }: {
  /** 「验收标准」，按完成定义评时是「完成定义」。 */
  title: string;
  /** 按哪几条评（评审结果没出来时用它画空心圈）。 */
  texts: string[];
  /** 评完的逐条结果（重评有异议的那一条时也是原来的结果）；第一次评审中、没评完时为 null。 */
  results: TReviewCriterion[] | null;
  canDissent: boolean;
  onDissent: (index: number, reason: string) => Promise<string | null>;
}) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [dissenting, setDissenting] = useState<number | null>(null);
  const rows = results ?? texts.map((text, index) => ({ index: index + 1, text, verdict: null, reason: "", evidence: null, fix: null, dissent: null }));
  return (
    <section className={d.section} aria-label={title}>
      <h3 className={d.label}>{title}</h3>
      <ol className={d.criteria}>
        {rows.map((row) => {
          const expanded = open[row.index] ?? (row.verdict === "partial" || row.verdict === "unmet");
          const details = Boolean(row.evidence || row.fix);
          const pending = row.dissent?.upheld === null;
          return (
            <li key={row.index} className={d.criterion} data-verdict={row.verdict ?? undefined}>
              <Mark verdict={row.verdict} />
              <div className={d.criterionBody}>
                <p className={d.criterionText}>{row.text}</p>
                {row.reason ? <p className={d.reason}>{row.reason}</p> : null}
                {details && expanded ? (
                  <dl className={d.details}>
                    {row.evidence ? <><dt>依据</dt><dd>{row.evidence}</dd></> : null}
                    {row.fix ? <><dt>怎么补</dt><dd>{row.fix}</dd></> : null}
                  </dl>
                ) : null}
                {row.dissent ? (
                  <p className={d.dissentNote} data-pending={pending || undefined}>
                    {pending ? "重评中" : row.dissent.upheld ? "带着异议重评，改判达到" : "本人有异议"}<span>：{row.dissent.reason}</span>
                  </p>
                ) : null}
                {dissenting === row.index ? (
                  <Dissent onCancel={() => setDissenting(null)} onSend={async (reason) => {
                    const error = await onDissent(row.index, reason);
                    if (!error) setDissenting(null);
                    return error;
                  }} />
                ) : null}
              </div>
              <div className={d.criterionTools}>
                {details ? (
                  <button type="button" className={d.toggle} aria-expanded={expanded} aria-label={expanded ? "收起依据" : "看依据"}
                    onClick={() => setOpen((current) => ({ ...current, [row.index]: !expanded }))}>
                    <ChevronRight size={15} aria-hidden="true" />
                  </button>
                ) : null}
                {canDissent && (row.verdict === "partial" || row.verdict === "unmet") && !row.dissent && dissenting !== row.index ? (
                  <button type="button" className={d.quiet} onClick={() => setDissenting(row.index)}>我不同意</button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
