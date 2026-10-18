"use client";

/**
 * 周复盘页（D-01）：沿用个人复盘页的阅读面、壳和组件。五段沿用公司周复盘模板，每句带出处标记；
 * 本人逐段修改（编辑框里出处显示成〔名称〕），重新生成时保留改过的段，确认后提交。
 * 同战场的人和 CEO 只读，提交前看不到正文。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { Button } from "ts-design/primitives";
import type { TWeeklyReviewField, TWeeklyReviewPayload } from "@warmap/contracts";
import { browserApi, type Card } from "@/lib/api/client";
import { monthDayTime } from "@/lib/companyTime";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { requestError, ReviewActionError, type ReviewAction } from "@/components/monthlyReview/reviewApi";
import { GenerationSteps, ReviewText } from "@/components/monthlyReview/ReviewParts";
import { Sources } from "@/components/monthlyReview/Sources";
import { fromEditable, inlineSources, toEditable } from "@/components/monthlyReview/citationText";
import s from "@/components/missionCards/mission-card.module.css";
import r from "@/components/monthlyReview/monthly-review.module.css";
import { runWeeklyReviewAction, WEEKLY_FIELD_HINTS, WEEKLY_FIELD_LABELS, WEEKLY_FIELDS, weekLabel, weeklyStatusText } from "./weeklyReviewApi";

type Drafts = Partial<Record<TWeeklyReviewField, string>>;
const NO_CARDS: Card[] = [];
const REVISION_TEXT = { generate: "生成", edit: "修改", submit: "提交", import: "导入" } as const;

function tone(status: TWeeklyReviewPayload["status"]): "wait" | "warn" | "done" | undefined {
  return status === "submitted" ? "done" : status === "draft_failed" ? "warn" : status === "drafting" ? "wait" : undefined;
}

export function WeeklyReviewScreen({ initialReview }: { initialReview: TWeeklyReviewPayload }) {
  const workspace = useWorkspace();
  const router = useRouter();
  const [review, setReview] = useState(initialReview);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const inFlight = useRef(false);

  const { isSelf } = review.viewer;
  const week = weekLabel(review.weekStart, review.weekEnd);
  const title = isSelf ? `我的周复盘 · ${week}` : `${review.personName} · ${week}`;
  const action = useCallback((type: string): ReviewAction | undefined => review.actions.find((candidate) => candidate.actionType === type), [review.actions]);
  const editable = Boolean(action("weekly-review.update"));
  const savedText = (field: TWeeklyReviewField) => review.body?.[field].text ?? "";
  const draftText = (field: TWeeklyReviewField) => drafts[field] === undefined ? undefined : fromEditable(drafts[field], savedText(field));
  const dirtyFields = WEEKLY_FIELDS.filter((field) => drafts[field] !== undefined && draftText(field) !== savedText(field));

  useRegisterDetail(useMemo(() => ({ scope: "global", label: title, mark: "monthly" as const, cards: NO_CARDS }), [title]));

  const accept = useCallback((next: TWeeklyReviewPayload) => setReview((current) => next.version < current.version ? current : next), []);
  const latest = useCallback(async () => {
    const { data, response } = await browserApi.GET("/api/weekly-reviews/{weeklyReviewId}", { params: { path: { weeklyReviewId: review.weeklyReviewId } } });
    if (response.status === 401) { router.push("/access"); return undefined; }
    if (data?.review) accept(data.review);
    return data?.review;
  }, [review.weeklyReviewId, router, accept]);
  const refresh = useCallback(async () => { try { await latest(); } catch { /* 下一次轮询再取 */ } }, [latest]);

  // 生成中每 3 秒读一次；草稿每 15 秒；回到前台立刻读。
  useEffect(() => {
    if (review.status === "submitted") return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, review.status === "drafting" ? 3_000 : 15_000);
    return () => window.clearInterval(timer);
  }, [review.status, refresh]);
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const perform = async (descriptor: ReviewAction | undefined, input?: unknown, done?: string) => {
    if (!descriptor || inFlight.current) return false;
    inFlight.current = true;
    setPending(true); setError(""); setNotice(""); setFieldErrors({});
    try {
      accept((await runWeeklyReviewAction(descriptor, input)).review);
      if (done) setNotice(done);
      return true;
    } catch (cause) {
      setError(requestError(cause, "暂时无法连接服务器，请稍后重试；输入已保留。"));
      if (cause instanceof ReviewActionError) {
        if (cause.fieldErrors) setFieldErrors(cause.fieldErrors);
        if (cause.status === 409) await refresh();
      }
      return false;
    } finally { inFlight.current = false; setPending(false); }
  };
  const save = async (then?: string) => {
    if (!dirtyFields.length) return true;
    const ok = await perform(action("weekly-review.update"), { fields: dirtyFields.map((field) => ({ field, text: draftText(field) ?? "" })) }, then);
    if (ok) setDrafts({});
    return ok;
  };
  // 先存下没保存的修改（存过的段重新生成时保留，提交时也一并算上），再从最新视图里取动作。
  const afterSave = async (type: string, done?: string) => {
    const unsaved = dirtyFields.length > 0;
    if (unsaved && !(await save())) return;
    const current = unsaved ? await latest().catch(() => undefined) : review;
    if (await perform((current ?? review).actions.find((candidate) => candidate.actionType === type), undefined, done)) setDrafts({});
  };

  const generateAction = action("weekly-review.generate");
  const submitAction = action("weekly-review.submit");
  const drafting = review.status === "drafting";

  return <div className={s.screen}>
    <DetailFrame title={title} onBack={() => workspace.close()}
      actions={<div className={r.headerActions}>
        {generateAction ? <Button variant="ghost" className={r.generate} aria-label={generateAction.label} isDisabled={pending} onPress={() => void afterSave("weekly-review.generate")}><Sparkles size={15} aria-hidden /><span className={r.generateLabel}>{generateAction.label}</span></Button> : null}
        <span className={r.chip} data-tone={tone(review.status)}>{weeklyStatusText(review.status, review.origin, isSelf)}</span>
      </div>}>
      <div className={s.content}>
        <div className={s.document}>
          {error || notice ? <div className={r.messages}>
            {error ? <p className={s.error} role="alert">{error}</p> : null}
            {notice ? <p className={s.notice} role="status">{notice}</p> : null}
          </div> : null}

          {drafting && isSelf ? <div className={`${r.working} ${r.generating}`} role="status">
            {review.generationSteps.length ? <GenerationSteps steps={review.generationSteps} /> : <><span className={r.pulse} aria-hidden />Co-Agent 正在生成…</>}
          </div> : null}
          {review.status === "draft_failed" && isSelf ? <p className={s.error} role="alert">生成没有成功{review.draftError ? `：${review.draftError.message}` : ""}</p> : null}
          {isSelf && review.generationSteps.length > 0 && !drafting ? <details className={r.process}>
            <summary>生成过程 · {review.generationSteps.length} 步</summary>
            <GenerationSteps steps={review.generationSteps} />
          </details> : null}

          {review.body ? <dl className={s.fields} aria-label="周复盘">
            {WEEKLY_FIELDS.map((field) => {
              const saved = review.body![field];
              const editing = editable && (drafts[field] !== undefined || !saved.text);
              const value = drafts[field] ?? toEditable(saved.text);
              const dirty = drafts[field] !== undefined && draftText(field) !== saved.text;
              const shown = inlineSources(saved.text);
              return <div key={field} className={s.field} data-changed={dirty ? "" : undefined}>
                <dt>
                  <label htmlFor={`weekly-${field}`}>{WEEKLY_FIELD_LABELS[field]}</label>
                  {isSelf && review.editedFields.includes(field) ? <span className={r.edited}>你改过</span> : null}
                </dt>
                {editable && saved.text ? <div className={s.fieldActions}>
                  {drafts[field] === undefined
                    ? <Button variant="ghost" className={s.textAction} aria-label={`修改：${WEEKLY_FIELD_LABELS[field]}`} isDisabled={pending} onPress={() => setDrafts((current) => ({ ...current, [field]: toEditable(saved.text) }))}>修改</Button>
                    : <Button variant="ghost" className={s.textAction} aria-label={`不改了：${WEEKLY_FIELD_LABELS[field]}`} isDisabled={pending} onPress={() => setDrafts(({ [field]: _discarded, ...rest }) => rest)}>不改了</Button>}
                </div> : null}
                <dd>
                  {editing
                    ? <textarea id={`weekly-${field}`} className={r.editor} value={value} rows={Math.min(14, Math.max(3, value.split("\n").length + Math.ceil(value.length / 48)))} maxLength={4000} disabled={pending}
                        data-dirty={dirty ? "" : undefined} aria-invalid={fieldErrors[field] ? true : undefined}
                        placeholder={WEEKLY_FIELD_HINTS[field]} onChange={(event) => setDrafts((current) => ({ ...current, [field]: event.target.value }))} />
                    : <div id={`weekly-${field}`}>{saved.text ? <ReviewText text={saved.text} /> : <p className={s.missing}>无</p>}</div>}
                  {fieldErrors[field] ? <p className={s.proposalError}>提交前要写上</p> : null}
                  <Sources sources={saved.sources.filter((source) => !shown.has(source))} />
                </dd>
              </div>;
            })}
          </dl> : !drafting || !isSelf ? <p className={s.missing}>{weeklyStatusText(review.status, review.origin, isSelf)}</p> : null}

          {review.importSource ? <p className={r.sources}>原文：<a href={review.importSource.url} target="_blank" rel="noreferrer">{review.importSource.title}</a></p> : null}

          {editable ? <div className={r.bar}>
            <p className={`${s.hint} ${r.hint}`}>同战场与 CEO 可见</p>
            {dirtyFields.length ? <Button variant="ghost" className={s.secondary} isDisabled={pending} onPress={() => void save("已保存")}>保存</Button> : null}
            {submitAction || dirtyFields.length ? <Button variant="primary" className={s.primary} isDisabled={pending} onPress={() => void afterSave("weekly-review.submit", "已提交")}>{pending ? "正在提交…" : "提交"}</Button> : null}
          </div> : null}

          {review.revisions.length ? <details className={`${r.process} ${r.section}`}>
            <summary>修改记录 · {review.revisions.length}</summary>
            <ul className={r.history}>
              {review.revisions.map((item, index) => <li key={`${item.at}-${index}`}>
                <time dateTime={item.at}>{monthDayTime(item.at)}</time>{item.byName} {REVISION_TEXT[item.kind]}{item.kind === "edit" && item.fields.length ? `：${item.fields.map((field) => WEEKLY_FIELD_LABELS[field]).join("、")}` : ""}
              </li>)}
            </ul>
          </details> : null}
        </div>
      </div>
    </DetailFrame>
  </div>;
}
