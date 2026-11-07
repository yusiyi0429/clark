"use client";

/**
 * 约定与对表在验收标准里的几样（设计 V1 第 8 节）：
 * - 每条标准下面一行「证明：…　认可：X」，后面小字标来源（本体 / 11 月补充）；能改的人点这一行就地改，没写的是「补约定」。
 * - 对表结果标在每条上（有证据、差、评审中、还没交付物、要 X 确认），「要 X 确认」旁边是「请 X 看」，今天请过就是「今天已请」。
 * - 列表上面是服务端给的提示和结论，列表下面是「这次不包括」和评审给的「下次可以做」（不算进差）。
 */
import { useEffect, useState, type FormEvent } from "react";
import { ChevronRight } from "lucide-react";
import type { TAgreementCriterion, TAgreementSource, TPutTaskAgreementRequest, TTaskAgreementResponse, TTaskCheckCriterion, TTaskCheckResponse } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { listPersonDirectory } from "@/components/meeting/meetingDecisionApi";
import { Select } from "@/components/ui/Select";
import d from "@/styles/task-deliverable.module.css";

type Person = { personId: string; displayName: string };
let directory: Promise<Person[]> | null = null;
/** 人员名册整页只读一次；没读到下次再读。 */
const people = () => (directory ??= listPersonDirectory().catch(() => { directory = null; return []; }));

/** 存的时候整份覆盖：改一条（证明、认可人）或改「这次不包括」，别的原样带上。 */
export function agreementBody(agreement: TTaskAgreementResponse,
  change: { index: number; proof: string | null; acceptorId: string | null } | { exclusions: string[] }): TPutTaskAgreementRequest {
  return {
    criteria: agreement.criteria.map((row) => ("index" in change && change.index === row.index ? change
      : { index: row.index, proof: row.proof, acceptorId: row.acceptor?.personId ?? null })),
    exclusions: "exclusions" in change ? change.exclusions : agreement.exclusions,
  };
}

const SOURCE_LABEL: Record<TAgreementSource, string | null> = { world: "本体", tianshu: "11 月补充", none: null };

export function AgreementLine({ criterion, source, canEdit, onSave }: {
  criterion: TAgreementCriterion;
  source: TAgreementSource;
  canEdit: boolean;
  /** 存这一条的证明和认可人；返回出错的那句话，成功为 null。 */
  onSave: (proof: string | null, acceptorId: string | null) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const filled = criterion.proof !== null || criterion.acceptor !== null;
  if (editing) return <AgreementEditor criterion={criterion} onCancel={() => setEditing(false)} onSave={async (proof, acceptorId) => {
    const error = await onSave(proof, acceptorId);
    if (!error) setEditing(false);
    return error;
  }} />;
  if (!filled) return canEdit ? <HeroButton variant="ghost" size="sm" className={d.agreementAdd} onPress={() => setEditing(true)}>补约定</HeroButton> : null;
  const body = <>
    {criterion.proof !== null ? <span>证明：{criterion.proof}</span> : null}
    {criterion.acceptor ? <span>认可：{criterion.acceptor.name}</span> : null}
    {SOURCE_LABEL[source] ? <small>{SOURCE_LABEL[source]}</small> : null}
  </>;
  return canEdit
    ? <button type="button" className={d.agreement} aria-label={`改第 ${criterion.index} 条的约定`} onClick={() => setEditing(true)}>{body}</button>
    : <p className={d.agreement}>{body}</p>;
}

function AgreementEditor({ criterion, onSave, onCancel }: {
  criterion: TAgreementCriterion;
  onSave: (proof: string | null, acceptorId: string | null) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [proof, setProof] = useState(criterion.proof ?? "");
  const [acceptorId, setAcceptorId] = useState(criterion.acceptor?.personId ?? "");
  const [options, setOptions] = useState<Person[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void people().then((next) => { if (live) setOptions(next); });
    return () => { live = false; };
  }, []);
  // 名册里没有原来那位（离开了、还没读到）时也留着他，免得一存就丢。
  const choices = criterion.acceptor && !options.some((person) => person.personId === criterion.acceptor?.personId)
    ? [{ personId: criterion.acceptor.personId, displayName: criterion.acceptor.name }, ...options] : options;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(await onSave(proof.trim() || null, acceptorId || null));
    setBusy(false);
  };
  return (
    <form className={d.agreementEdit} onSubmit={(event) => void submit(event)} onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}>
      <label htmlFor={`proof-${criterion.index}`}>证明</label>
      <input id={`proof-${criterion.index}`} value={proof} maxLength={500} autoFocus disabled={busy} placeholder="用什么证明" onChange={(event) => setProof(event.target.value)} />
      <span aria-hidden="true">认可</span>
      <Select aria-label={`第 ${criterion.index} 条由谁认可`} size="compact" value={acceptorId} disabled={busy}
        options={[{ value: "", label: "不指定" }, ...choices.map((person) => ({ value: person.personId, label: person.displayName }))]} onChange={setAcceptorId} />
      <div className={d.agreementEditActions}>
        <HeroButton type="submit" variant="tertiary" size="sm" isDisabled={busy}>保存</HeroButton>
        <HeroButton variant="ghost" size="sm" isDisabled={busy} onPress={onCancel}>取消</HeroButton>
      </div>
      {error ? <p className={d.error} role="alert">{error}</p> : null}
    </form>
  );
}

/** 对表结果的小字：有证据带第几版、哪份材料、定位；差带差什么。 */
export function checkText(row: TTaskCheckCriterion): string {
  const evidence = row.evidence ? [`v${row.evidence.versionNumber}`, row.evidence.items.map((item) => item.name).join("、"), row.evidence.locator ?? ""].filter(Boolean).join(" · ") : "";
  if (row.status === "evidenced") return ["有证据", evidence].filter(Boolean).join(" · ");
  if (row.status === "needs_acceptor") return [`要${row.acceptor?.name ?? "认可人"}确认`, evidence].filter(Boolean).join(" · ");
  if (row.status === "gap") return row.gap ? `差：${row.gap}` : "差";
  if (row.status === "reviewing") return "评审中";
  return "还没交付物";
}

export function CheckLine({ row, canNotify, asked, feishuOff, onNotify }: {
  row: TTaskCheckCriterion;
  canNotify: boolean;
  /** 这次打开以后已经请过这一条。 */
  asked: boolean;
  feishuOff: boolean;
  onNotify: (index: number, personId: string) => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const acceptor = row.status === "needs_acceptor" ? row.acceptor : null;
  const notified = row.notifiedToday || asked;
  const ask = async () => {
    if (!acceptor || busy) return;
    setBusy(true);
    setError(await onNotify(row.index, acceptor.personId));
    setBusy(false);
  };
  return (
    <div className={d.checkRow}>
      <p className={d.check} data-status={row.status}>{checkText(row)}</p>
      {acceptor && canNotify ? (notified
        ? <span className={d.asked}>今天已请</span>
        : <HeroButton variant="tertiary" size="sm" isDisabled={busy || feishuOff} title={feishuOff ? "飞书未连接" : undefined} onPress={() => void ask()}>请{acceptor.name}看</HeroButton>) : null}
      {error ? <p className={d.error} role="alert">{error}</p> : null}
    </div>
  );
}

/** 列表上面：提示在前（--warning）、结论在后（600）；只是字，不加底色（新首页设计 5.4.7：不加卡片底、不整块染色）。 */
export function CheckSummary({ check }: { check: TTaskCheckResponse }) {
  return (
    <div className={d.checkSummary} data-verdict={check.verdict} role="status">
      {check.notices.map((notice) => <p key={notice.code} className={d.notice}>{notice.text}</p>)}
      <p className={d.conclusion}>{check.conclusion}</p>
    </div>
  );
}

export function Exclusions({ items, canEdit, onSave }: { items: string[]; canEdit: boolean; onSave: (items: string[]) => Promise<string | null> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!items.length && !canEdit) return null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (draft === null || busy) return;
    setBusy(true);
    const next = draft.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => line.slice(0, 200)).slice(0, 20);
    const problem = await onSave(next);
    setError(problem);
    if (!problem) setDraft(null);
    setBusy(false);
  };
  return (
    <div className={d.exclusions}>
      <div className={d.subHead}>
        <h4 className={d.label}>这次不包括</h4>
        {canEdit && draft === null ? <HeroButton variant="ghost" size="sm" onPress={() => { setDraft(items.join("\n")); setError(null); }}>{items.length ? "改" : "补"}</HeroButton> : null}
      </div>
      {draft !== null ? (
        <form className={d.exclusionsEdit} onSubmit={(event) => void submit(event)} onKeyDown={(event) => { if (event.key === "Escape") setDraft(null); }}>
          <textarea value={draft} rows={Math.max(3, draft.split("\n").length)} autoFocus disabled={busy} placeholder="每行一条" aria-label="这次不包括"
            onChange={(event) => setDraft(event.target.value)} />
          <div className={d.agreementEditActions}>
            <HeroButton type="submit" variant="tertiary" size="sm" isDisabled={busy}>保存</HeroButton>
            <HeroButton variant="ghost" size="sm" isDisabled={busy} onPress={() => setDraft(null)}>取消</HeroButton>
          </div>
          {error ? <p className={d.error} role="alert">{error}</p> : null}
        </form>
      ) : items.length ? <ul className={d.plainList}>{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : null}
    </div>
  );
}

/** 评审给的「下次可以做」：收起时一行小字，不算进差。 */
export function BeyondScope({ items }: { items: string[] }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <div className={d.exclusions}>
      <button type="button" className={d.referenceToggle} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronRight size={16} strokeWidth={1.8} aria-hidden="true" />下次可以做 {items.length}
      </button>
      {open ? <ul className={d.plainList}>{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : null}
    </div>
  );
}
