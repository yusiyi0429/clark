"use client";

/**
 * 卡的约定（主循环第 60 条）：交代 + 完成标准，依据只有云端卡上那一份。
 * - 会话详情里本人直接改：完成标准逐条能改、加、删，交代能改，存了就生效（PATCH /api/me/cards/:id 带 brief、standards）。
 * - 「约定改过 N 次」点开看每次：谁、什么时候、改前改后、原因（GET …/agreement-changes，只列不比对）。
 * - 执行方提议改约定（agreement.proposal）：子会话里钉一个框「改成这样（推荐）/ 不改」，框里看得到改前改后。
 */
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import type { TCardAgreement, TCardAgreementChange, TCardAgreementProposalView, TCardAgreementView } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { DecisionBox, FailedLine, failureOf, type Failure } from "@/components/work/DecisionBox";
import { decideProposal, listAgreementChanges, patchCard } from "@/lib/board/cloud";
import { ICON } from "@/components/home/StateIcon";
import { relativeDayTime } from "@/lib/companyTime";
import s from "@/styles/v2-session.module.css";

/** 完成标准的长度（照契约 DONE_DEFINITION_LIMITS 抄的：每条 300 字，整份 2000 字）；交代 4000 字（PatchCardRequest.brief）。 */
export const STANDARD_LIMITS = { line: 300, total: 2000, count: 20, brief: 4000 } as const;

/** 这份完成标准能不能存：至少一条，每条不空、不换行、不超长，合起来不超长。 */
export function standardsOk(lines: readonly string[]): boolean {
  const kept = lines.map((line) => line.trim());
  return kept.length > 0 && kept.length <= STANDARD_LIMITS.count && kept.every((line) => line && line.length <= STANDARD_LIMITS.line && !/[\r\n]/.test(line))
    && kept.join("\n").length <= STANDARD_LIMITS.total;
}

const BY: Record<TCardAgreementChange["by"]["kind"], string> = { person: "本人", pipeline: "管线", worker: "执行方" };

/** 改前或改后的一份约定：交代（有才写）和完成标准。 */
function AgreementText({ label, value, showBrief }: { label: string; value: TCardAgreement; showBrief: boolean }) {
  return (
    <div className={s.agreeSide}>
      <span className={s.faint}>{label}</span>
      {showBrief && value.brief ? <p className={s.text}>{value.brief}</p> : null}
      <ol className={s.goal}>{value.standards.map((line, index) => <li key={index}>{line}</li>)}</ol>
    </div>
  );
}

/**
 * 会话详情里的「完成标准」：平时是一列；「改」以后交代和每条都能改、能加、能删，存了就生效。editing 由外面开（受阻、等你补的「改完成标准」，项目对话带 #agreement 跳来）。
 * onSaved：存好以后（重读卡的详情；这台电脑上跑着这张卡时，马上把云端登记的那句说给执行方）。
 */
export function AgreementSection({ cardId, version, brief, standards, agreement, canEdit, editing, onEditing, onSaved }: {
  cardId: string; version: number; brief: string | null; standards: readonly string[]; agreement: TCardAgreementView | null;
  canEdit: boolean; editing: boolean; onEditing: (editing: boolean) => void; onSaved: () => Promise<unknown>;
}) {
  const fresh = () => ({ brief: brief ?? "", standards: standards.length ? [...standards] : [""] });
  const [draft, setDraft] = useState<{ brief: string; standards: string[] } | null>(() => (editing ? fresh() : null));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<Failure | null>(null);
  useEffect(() => {
    if (editing) setDraft((current) => current ?? fresh());
    else { setDraft(null); setFailed(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fresh 只读当下的 brief、standards
  }, [editing, brief, standards]);
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setFailed(null);
    try {
      const nextBrief = draft.brief.trim();
      await patchCard(cardId, { version, standards: draft.standards.map((line) => line.trim()), ...(nextBrief !== (brief ?? "").trim() ? { brief: nextBrief || null } : {}) });
      onEditing(false);
      await onSaved();
    } catch (error) { setFailed(failureOf(error, () => void save())); }
    finally { setBusy(false); }
  };

  if (editing && draft) {
    const set = (index: number, value: string) => setDraft({ ...draft, standards: draft.standards.map((line, at) => (at === index ? value.replace(/[\r\n]+/g, " ") : line)) });
    const ok = standardsOk(draft.standards) && draft.brief.length <= STANDARD_LIMITS.brief;
    return (
      <div className={s.sec} data-testid="agreement-edit">
        <p className={s.lab}>交代</p>
        <textarea className={s.agreeField} rows={3} value={draft.brief} maxLength={STANDARD_LIMITS.brief} aria-label="交代" onChange={(event) => setDraft({ ...draft, brief: event.target.value })} />
        <p className={s.lab}>完成标准</p>
        <ol className={s.agreeList}>
          {draft.standards.map((line, index) => (
            <li key={index}>
              <input className={s.agreeField} value={line} maxLength={STANDARD_LIMITS.line} aria-label={`第 ${index + 1} 条`} autoFocus={index === 0}
                onChange={(event) => set(index, event.target.value)} data-testid="agreement-line" />
              <HeroButton variant="ghost" size="sm" isIconOnly aria-label="删除" title="删除" isDisabled={draft.standards.length <= 1}
                onPress={() => setDraft({ ...draft, standards: draft.standards.filter((_, at) => at !== index) })}><X {...ICON} aria-hidden /></HeroButton>
            </li>
          ))}
        </ol>
        <div className={s.actions}>
          <HeroButton variant="ghost" size="sm" isDisabled={draft.standards.length >= STANDARD_LIMITS.count} onPress={() => setDraft({ ...draft, standards: [...draft.standards, ""] })}><Plus {...ICON} aria-hidden />添加</HeroButton>
          <span className={s.agreeGrow} />
          <HeroButton variant="ghost" size="sm" onPress={() => onEditing(false)}>取消</HeroButton>
          <HeroButton variant="primary" size="sm" isDisabled={busy || !ok} onPress={() => void save()} data-testid="agreement-save">保存</HeroButton>
          {failed && !busy ? <FailedLine inline {...failed} /> : null}
        </div>
      </div>
    );
  }
  if (!standards.length && !canEdit) return null;
  return (
    <div className={s.sec} id="agreement">
      <p className={s.lab}>完成标准{canEdit ? <HeroButton variant="ghost" size="sm" onPress={() => onEditing(true)} data-testid="agreement-edit-open">改</HeroButton> : null}</p>
      {standards.length ? <ol className={s.goal}>{standards.map((line, index) => <li key={index}>{line}</li>)}</ol> : null}
      {agreement?.changes ? <AgreementChanges cardId={cardId} count={agreement.changes} revision={agreement.revision} /> : null}
    </div>
  );
}

/** 「约定改过 N 次」：点开读修改记录（新的在前），每次一块：谁 · 什么时候、原因、改前、改后。 */
function AgreementChanges({ cardId, count, revision }: { cardId: string; count: number; revision: number }) {
  const [open, setOpen] = useState(false);
  const [changes, setChanges] = useState<TCardAgreementChange[] | null>(null);
  const [failed, setFailed] = useState<Failure | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = () => { setFailed(null); listAgreementChanges(cardId).then((list) => { if (alive) setChanges(list); }, (error: unknown) => { if (alive) setFailed(failureOf(error, load)); }); };
    load();
    return () => { alive = false; };
  }, [open, cardId, revision]);
  return (
    <>
      <button type="button" className={s.filesHead} aria-expanded={open} onClick={() => setOpen(!open)} data-testid="agreement-changes">
        {open ? <ChevronDown {...ICON} /> : <ChevronRight {...ICON} />}约定改过 {count} 次
      </button>
      {open && failed ? <FailedLine inline {...failed} /> : null}
      {open && changes ? <ol className={s.agreeChanges}>{changes.map((change) => <ChangeItem key={change.id} change={change} />)}</ol> : null}
    </>
  );
}

export function ChangeItem({ change }: { change: TCardAgreementChange }) {
  const briefChanged = (change.before.brief ?? "") !== (change.after.brief ?? "");
  return (
    <li data-testid="agreement-change">
      <span className={s.faint}>{change.by.name ?? BY[change.by.kind]} · {relativeDayTime(change.at)}</span>
      {change.reason ? <p className={s.text}>{change.reason}</p> : null}
      <AgreementText label="改前" value={change.before} showBrief={briefChanged} />
      <AgreementText label="改后" value={change.after} showBrief={briefChanged} />
    </li>
  );
}

/**
 * 执行方提议改约定（钉在子会话输入框上方，手机上也能答）：头部写「提议改完成标准」，下面执行方的原因、改前、改后；「改成这样（推荐）/ 不改」。
 * onDecided：定了以后（重读卡的详情；这台电脑上跑着这张卡时马上把结果说给执行方）。
 */
export function ProposalDecision({ cardId, proposal, current, onDecided }: {
  cardId: string; proposal: TCardAgreementProposalView; current: TCardAgreement; onDecided: () => Promise<unknown>;
}) {
  const showBrief = proposal.brief !== null && proposal.brief !== (current.brief ?? "");
  return (
    <DecisionBox kind="question" testId="agreement-proposal" title="提议改完成标准"
      body={<>
        <p className={s.text}>{proposal.reason}</p>
        <AgreementText label="改前" value={current} showBrief={showBrief} />
        <AgreementText label="改后" value={{ brief: proposal.brief, standards: proposal.standards }} showBrief={showBrief} />
      </>}
      options={[{ label: "改成这样", recommended: true }, { label: "不改" }]}
      onPick={async ([index]) => { await decideProposal(cardId, proposal.id, index === 0 ? "accept" : "reject"); await onDecided(); }} />
  );
}
