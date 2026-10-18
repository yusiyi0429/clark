"use client";

/**
 * ⑧ 文档变更的二级页（DetailFrame 壳），走送达通道 kind = doc_change：
 * - 作者：新文档一张卡、Agent 的处理步骤、候选旧文档一列（参照 GitHub 的「关联 issue」与 Linear 的关系选择：每行一对开关「修订 / 取代」，
 *   再点一次取消）；勾了取代才出现生效日期、过渡期、已有工作沿用旧版三项；底栏「都不是」「问负责人」「确认」。
 * - 被问的旧文档负责人：只看到他负责的那几份，每份「还有效」一键答，「已被取代」展开同样三项再确认。
 * 确认之后整页只读，步骤停在有结果的那一步。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Check, FileText, UserRoundSearch } from "lucide-react";
import { Button } from "ts-design/primitives";
import type { TDocChangeCandidate, TDocChangeView, TDocRelation, TRequestView } from "@warmap/contracts";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { StepList, type Step } from "@/components/steps/StepList";
import { DatePicker } from "@/components/ui/DatePicker";
import type { Card } from "@/lib/api/client";
import { monthDayTime } from "@/lib/companyTime";
import { answerDocChangeOwner, askDocChangeOwners, confirmDocChange, readDocChange, requestError } from "./requestApi";
import s from "./requests.module.css";
import d from "./docChange.module.css";

const NO_CARDS: Card[] = [];
const RELATION: Record<TDocRelation, string> = { revision: "修订", supersede: "取代" };
const STATUS: Record<TDocChangeView["status"], { label: string; tone: "wait" | "done" | "draft" }> = {
  finding: { label: "查找中", tone: "wait" }, awaiting_author: { label: "待确认", tone: "wait" }, asking_owner: { label: "问负责人", tone: "wait" },
  confirmed: { label: "已确认", tone: "done" }, unrelated: { label: "都不是", tone: "draft" },
};
const dayLabel = (day: string | null) => day ? `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日` : "";

/** 服务端的步骤换成通用 StepList 的样子（当前那一步高亮）。 */
export const docChangeSteps = (view: Pick<TDocChangeView, "steps">): Step[] =>
  view.steps.map((step) => ({ id: step.label, label: step.label, status: step.status === "current" ? "active" : step.status, ...(step.result ? { result: step.result } : {}) }));

type Terms = { effectiveOn: string; transitionUntil: string; keepExisting: boolean };
const NO_TERMS: Terms = { effectiveOn: "", transitionUntil: "", keepExisting: true };
const termsBody = (terms: Terms) => ({ effectiveOn: terms.effectiveOn || null, transitionUntil: terms.transitionUntil || null, keepExisting: terms.keepExisting });

export function DocChangeScreen({ request }: { request: TRequestView }) {
  const workspace = useWorkspace();
  const [view, setView] = useState<TDocChangeView | null>(null);
  const [error, setError] = useState("");
  useRegisterDetail(useMemo(() => ({ scope: "global", label: request.title, mark: null, cards: NO_CARDS }), [request.title]));

  const load = useCallback(async () => {
    try { setView(await readDocChange(request.id)); } catch (cause) { setError(requestError(cause, "没有读到这次文档变更")); }
  }, [request.id]);
  useEffect(() => { void load(); }, [load]);
  // 在问负责人：回到这一页时重读，看谁答了。
  useEffect(() => {
    if (view?.status !== "asking_owner") return;
    const onFocus = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [view?.status, load]);

  const status = view ? STATUS[view.status] : null;
  return (
    <div className={s.screen}>
      <DetailFrame title={request.title} subtitle={`文档变更 · ${request.initiator.displayName} · ${monthDayTime(request.sentAt)}`} onBack={() => workspace.close()}
        actions={status ? <span className={`${s.chip} ${s.headerChip}`} data-tone={status.tone}>{status.label}</span> : undefined}>
        <div className={s.content}>
          <div className={s.stack}>
            {error ? <p className={s.error} role="alert">{error}</p> : null}
            {view ? (
              <>
                <NewDoc view={view} />
                <div className={d.steps} data-tone="light"><StepList steps={docChangeSteps(view)} /></div>
                {view.viewer.role === "owner" ? <OwnerAnswer view={view} onView={setView} /> : <AuthorDecision view={view} onView={setView} />}
              </>
            ) : !error ? <div className={d.skeleton} aria-busy="true" aria-label="读取中" /> : null}
          </div>
        </div>
      </DetailFrame>
    </div>
  );
}

function DocLink({ title, url }: { title: string; url: string | null }) {
  return url
    ? <a className={d.docLink} href={url} target="_blank" rel="noreferrer">{title}<ArrowUpRight size={14} aria-hidden="true" /></a>
    : <span className={d.docLink}>{title}</span>;
}

function NewDoc({ view }: { view: TDocChangeView }) {
  return (
    <article className={d.newDoc} aria-label="新文档">
      <span className={d.docIcon} aria-hidden="true"><FileText size={20} /></span>
      <div className={d.newDocMain}>
        <DocLink title={view.newDoc.title} url={view.newDoc.url} />
        <span className={d.meta}>{[view.authorName, monthDayTime(view.publishedAt)].filter(Boolean).join(" · ")}</span>
      </div>
    </article>
  );
}

function CandidateHead({ item }: { item: TDocChangeCandidate }) {
  return (
    <div className={d.candidateMain}>
      <DocLink title={item.title} url={item.url} />
      <span className={d.chips}>
        {item.sameDoc ? <span className={s.tag} data-tone="wait">同一链接</span> : null}
        {item.ownerName ? <span className={s.tag}>{item.ownerName}</span> : null}
        {item.dependents ? <span className={s.tag}>{item.dependents} 人依据</span> : null}
      </span>
      <p className={d.reason}>{item.reason}</p>
    </div>
  );
}

/** 生效日期、过渡期、已有工作沿用旧版：只有取代时出现。 */
function TermsFields({ terms, onTerms, disabled }: { terms: Terms; onTerms: (terms: Terms) => void; disabled: boolean }) {
  return (
    <fieldset className={d.terms} disabled={disabled}>
      <legend className={d.termsLegend}>取代</legend>
      <label className={d.field}><span className={s.fieldName}>生效日期</span>
        <DatePicker label="生效日期" size="compact" clearable value={terms.effectiveOn} max={terms.transitionUntil || undefined} onChange={(effectiveOn) => onTerms({ ...terms, effectiveOn })} /></label>
      <label className={d.field}><span className={s.fieldName}>过渡期到</span>
        <DatePicker label="过渡期截止" size="compact" clearable value={terms.transitionUntil} min={terms.effectiveOn || undefined} onChange={(transitionUntil) => onTerms({ ...terms, transitionUntil })} /></label>
      <label className={d.check}>
        <input type="checkbox" checked={terms.keepExisting} onChange={(event) => onTerms({ ...terms, keepExisting: event.target.checked })} />
        已有工作沿用旧版
      </label>
    </fieldset>
  );
}

function DecidedTerms({ view }: { view: TDocChangeView }) {
  if (!view.candidates.some((item) => item.relation === "supersede")) return null;
  const rows = [
    view.effectiveOn ? ["生效", dayLabel(view.effectiveOn)] : null,
    view.transitionUntil ? ["过渡期到", dayLabel(view.transitionUntil)] : null,
    view.keepExisting === null ? null : ["已有工作", view.keepExisting ? "沿用旧版" : "换成新版"],
    view.decidedByName && view.decidedByName !== view.authorName ? ["确认", view.decidedByName] : null,
  ].filter((row): row is string[] => row !== null);
  return rows.length ? <dl className={d.facts}>{rows.map(([term, value]) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>)}</dl> : null;
}

function AuthorDecision({ view, onView }: { view: TDocChangeView; onView: (view: TDocChangeView) => void }) {
  const [picked, setPicked] = useState<Record<string, TDocRelation>>({});
  const [terms, setTerms] = useState<Terms>(NO_TERMS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editing = view.viewer.canDecide;
  const chosen = Object.entries(picked);
  const supersedes = chosen.some(([, relation]) => relation === "supersede");
  const toggle = (key: string, relation: TDocRelation) => setPicked((current) => {
    const next = { ...current };
    if (next[key] === relation) delete next[key]; else next[key] = relation;
    return next;
  });
  const run = async (work: () => Promise<TDocChangeView>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { onView(await work()); } catch (cause) { setError(requestError(cause, "没有成功，请重试")); } finally { setBusy(false); }
  };
  const confirm = (links: { key: string; relation: TDocRelation }[]) =>
    run(() => confirmDocChange(view.id, { links, ...(links.some((link) => link.relation === "supersede") ? termsBody(terms) : {}) }));

  return (
    <section className={d.panel} aria-label="候选">
      <ul className={d.candidates}>
        {view.candidates.map((item) => (
          <li key={item.key} className={d.candidate} data-picked={editing ? picked[item.key] : item.relation ?? undefined}>
            <CandidateHead item={item} />
            {editing ? (
              <div className={d.relations} role="group" aria-label={`《${item.title}》和新文档的关系`}>
                {(["revision", "supersede"] as const).map((relation) => (
                  <button key={relation} type="button" className={d.relation} aria-pressed={picked[item.key] === relation} disabled={busy}
                    data-suggested={item.suggested === relation || undefined} onClick={() => toggle(item.key, relation)}>
                    {picked[item.key] === relation ? <Check size={14} strokeWidth={2.6} aria-hidden="true" /> : null}{RELATION[relation]}
                  </button>
                ))}
              </div>
            ) : (
              <span className={d.outcome} data-relation={item.relation ?? undefined}>
                {item.relation ? RELATION[item.relation] : item.ownerAnswer === "valid" ? "还有效" : item.ownerAnswer === "asked" ? "等负责人" : "无关"}
              </span>
            )}
          </li>
        ))}
      </ul>
      {editing && supersedes ? <TermsFields terms={terms} onTerms={setTerms} disabled={busy} /> : null}
      {!editing ? <DecidedTerms view={view} /> : null}
      {error ? <p className={s.error} role="alert">{error}</p> : null}
      {editing ? (
        <footer className={d.bar}>
          <Button variant="ghost" className={s.ghost} isDisabled={busy} onPress={() => void confirm([])}>都不是</Button>
          {view.viewer.canAskOwners ? (
            <Button variant="ghost" className={s.ghost} isDisabled={busy} onPress={() => void run(() => askDocChangeOwners(view.id))}>
              <UserRoundSearch size={15} aria-hidden="true" />问负责人
            </Button>
          ) : null}
          <Button variant="primary" className={`${s.primary} ${d.confirm}`} isDisabled={busy || !chosen.length}
            onPress={() => void confirm(chosen.map(([key, relation]) => ({ key, relation })))}>
            <Check size={16} aria-hidden="true" />确认{chosen.length ? ` ${chosen.length}` : ""}
          </Button>
        </footer>
      ) : null}
    </section>
  );
}

function OwnerAnswer({ view, onView }: { view: TDocChangeView; onView: (view: TDocChangeView) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [terms, setTerms] = useState<Terms>(NO_TERMS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answer = async (key: string, superseded: boolean) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      onView(await answerDocChangeOwner(view.id, { key, answer: superseded ? "superseded" : "valid", ...(superseded ? termsBody(terms) : {}) }));
      setOpen(null);
    } catch (cause) { setError(requestError(cause, "没有成功，请重试")); } finally { setBusy(false); }
  };
  return (
    <section className={d.panel} aria-label="你负责的文档">
      <ul className={d.candidates}>
        {view.candidates.map((item) => {
          const waiting = view.viewer.ownerKeys.includes(item.key);
          return (
            <li key={item.key} className={d.candidate} data-picked={item.relation ?? (open === item.key ? "supersede" : undefined)}>
              <CandidateHead item={item} />
              {waiting ? (
                <div className={d.relations} role="group" aria-label={`《${item.title}》`}>
                  <button type="button" className={d.relation} aria-pressed="false" disabled={busy} onClick={() => void answer(item.key, false)}>还有效</button>
                  <button type="button" className={d.relation} aria-pressed={open === item.key} disabled={busy} onClick={() => setOpen(open === item.key ? null : item.key)}>
                    {open === item.key ? <Check size={14} strokeWidth={2.6} aria-hidden="true" /> : null}已被取代
                  </button>
                </div>
              ) : <span className={d.outcome} data-relation={item.relation ?? undefined}>{item.ownerAnswer === "superseded" ? "已被取代" : "还有效"}</span>}
              {waiting && open === item.key ? (
                <div className={d.inline}>
                  <TermsFields terms={terms} onTerms={setTerms} disabled={busy} />
                  <footer className={d.bar}>
                    <Button variant="primary" className={`${s.primary} ${d.confirm}`} isDisabled={busy} onPress={() => void answer(item.key, true)}>
                      <Check size={16} aria-hidden="true" />确认已被取代
                    </Button>
                  </footer>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {!view.viewer.ownerKeys.length ? <DecidedTerms view={view} /> : null}
      {error ? <p className={s.error} role="alert">{error}</p> : null}
    </section>
  );
}
