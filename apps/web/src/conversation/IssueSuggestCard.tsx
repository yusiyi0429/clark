"use client";

/**
 * 首页对话里的转议题建议卡（已定设计第 2 节，只有一号位看得到）：回答里 ```issue-suggest {"draftId":…} 的块画成这张卡。
 * 参照 Linear「从对话建 issue」、Slack「转成待办」：卡上是初稿的标题和为什么现在要议，三个选项——
 * 开议题 / 接到议题 X（能对上已有议题时它是主选项）/ 不用。开议题先展开初稿就地改、选挂在哪个战场或全局战略，再「建议题」。
 * 建成或接上之后卡变成一行「已转到议题 X」，首页对话随之多一行留痕（重读历史）。
 */
import { useContext, useEffect, useState } from "react";
import { ArrowRight, Check, Flag } from "lucide-react";
import { Button } from "ts-design/primitives";
import type { TIssueDraftContent, TIssueDraftLocation, TIssueDraftView } from "@warmap/contracts";
import { WorkspaceContext } from "@/components/shell/WorkspaceContext";
import { browserApi } from "@/lib/api/client";
import { CONVERSATION_RELOAD } from "./useConversation";
import r from "@/components/requests/requests.module.css";
import e from "@/styles/entry-cards.module.css";
import s from "@/styles/issue-suggest.module.css";
import { FadeText } from "@/lib/home/overflowFade";

/** 块里的 JSON：只认 draftId。 */
export function parseIssueSuggest(source: string): string | null {
  try {
    const value = JSON.parse(source) as { draftId?: unknown };
    return typeof value?.draftId === "string" && /^[0-9a-f-]{36}$/i.test(value.draftId) ? value.draftId : null;
  } catch {
    return null;
  }
}

const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);
/** 方案一行一个：「方案：取舍」。 */
const optionLines = (options: TIssueDraftContent["options"]) => options.map((item) => (item.tradeoff ? `${item.label}：${item.tradeoff}` : item.label)).join("\n");
const parseOptions = (text: string): TIssueDraftContent["options"] => lines(text).slice(0, 5).map((line) => {
  const at = line.search(/[：:]/);
  return at > 0 ? { label: line.slice(0, at).trim().slice(0, 60), tradeoff: line.slice(at + 1).trim().slice(0, 500) } : { label: line.slice(0, 60), tradeoff: "" };
});
const locationKey = (location: TIssueDraftLocation | null) => (location?.level === "battlefield" ? location.battlefieldId : "company");

function useOpen() {
  const workspace = useContext(WorkspaceContext);
  return (href: string) => (workspace ? workspace.navigate(href) : window.location.assign(href));
}

export function IssueSuggestCard({ draftId }: { draftId: string }) {
  const open = useOpen();
  const [view, setView] = useState<TIssueDraftView | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    browserApi.GET("/api/issue-drafts/{id}", { params: { path: { id: draftId } } })
      .then(({ data }) => { if (live) { if (data) setView(data.draft); else setFailed(true); } }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [draftId]);

  if (failed) return null;
  if (!view) return <section className={e.card} aria-busy="true"><div className={e.placeholder} /></section>;
  const settle = (next: TIssueDraftView) => {
    setView(next);
    setEditing(false);
    window.dispatchEvent(new CustomEvent(CONVERSATION_RELOAD, { detail: { scope: "global" } }));
  };
  const run = async (work: () => Promise<{ data?: { draft: TIssueDraftView }; error?: unknown }>) => {
    setBusy(true); setError("");
    try {
      const { data, error: failure } = await work();
      if (data) settle(data.draft);
      else setError((failure as { message?: string } | undefined)?.message ?? "没有成功，请重试");
    } catch { setError("没有成功，请重试"); }
    finally { setBusy(false); }
  };
  const decline = () => run(() => browserApi.POST("/api/issue-drafts/{id}/decline", { params: { path: { id: draftId } } }));
  const join = (issueId: string) => run(() => browserApi.POST("/api/issue-drafts/{id}/accept", { params: { path: { id: draftId } }, body: { mode: "existing", issueId } }));
  const create = (draft: TIssueDraftContent, location: TIssueDraftLocation) =>
    run(() => browserApi.POST("/api/issue-drafts/{id}/accept", { params: { path: { id: draftId } }, body: { mode: "new", draft, location } }));

  if (view.status === "accepted" && view.issue) {
    const issue = view.issue;
    return (
      <section className={`${e.card} ${s.done}`} aria-label="已转到议题" data-testid="issue-suggest" data-status="accepted">
        <a className={s.doneLink} href={issue.href} onClick={(event) => { event.preventDefault(); open(issue.href); }}>
          <Check size={14} strokeWidth={2.6} aria-hidden /><span>已转到议题</span><strong>{issue.title}</strong><ArrowRight size={14} aria-hidden />
        </a>
      </section>
    );
  }
  if (view.status === "declined") {
    return (
      <section className={`${e.card} ${s.done}`} aria-label="议题建议" data-testid="issue-suggest" data-status="declined">
        <div className={s.declined}><span className={s.title}>{view.draft.title}</span><span className={r.chip} data-tone="draft">已忽略</span></div>
      </section>
    );
  }
  const { draft } = view;
  const matched = view.matchedIssue;
  return (
    <section className={e.card} aria-label="议题建议" data-testid="issue-suggest" data-status="proposed">
      <header className={s.head}>
        <Flag size={14} strokeWidth={2} aria-hidden className={s.icon} />
        <h3 className={s.title}>{draft.title}</h3>
      </header>
      {editing ? (
        <DraftEditor view={view} busy={busy} onCancel={() => { setEditing(false); setError(""); }} onSubmit={create} />
      ) : (
        <>
          <FadeText as="p" className={s.why}>{draft.whyNow}</FadeText>
          <p className={s.facts}>
            <span>{view.turns} 轮对话</span>
            {draft.options.length ? <span>{draft.options.length} 个方案</span> : null}
            {draft.openQuestions.length ? <span>{draft.openQuestions.length} 个待定问题</span> : null}
          </p>
          <div className={s.actions}>
            {matched ? (
              <Button variant="primary" className={r.primary} isDisabled={busy} onPress={() => void join(matched.id)}>接到「{matched.title}」继续</Button>
            ) : null}
            <Button variant={matched ? "ghost" : "primary"} className={matched ? r.ghost : r.primary} isDisabled={busy} onPress={() => setEditing(true)}>开议题</Button>
            <Button variant="ghost" className={r.ghost} isDisabled={busy} onPress={() => void decline()}>不用</Button>
          </div>
        </>
      )}
      {error ? <p className={r.error} role="alert">{error}</p> : null}
    </section>
  );
}

/** 初稿就地改：标题、为什么现在要议、已形成的想法、可选方案、未定的问题（列表一行一条），再选挂在哪。 */
function DraftEditor({ view, busy, onCancel, onSubmit }: {
  view: TIssueDraftView; busy: boolean; onCancel: () => void; onSubmit: (draft: TIssueDraftContent, location: TIssueDraftLocation) => void;
}) {
  const [title, setTitle] = useState(view.draft.title);
  const [whyNow, setWhyNow] = useState(view.draft.whyNow);
  const [ideas, setIdeas] = useState(view.draft.formedIdeas.join("\n"));
  const [options, setOptions] = useState(optionLines(view.draft.options));
  const [questions, setQuestions] = useState(view.draft.openQuestions.join("\n"));
  const [where, setWhere] = useState(locationKey(view.suggestedLocation));
  const ready = title.trim().length > 0 && [...title.trim()].length <= 25 && whyNow.trim().length > 0;
  const submit = () => {
    if (!ready) return;
    onSubmit({ title: title.trim(), whyNow: whyNow.trim(), formedIdeas: lines(ideas).slice(0, 8).map((item) => item.slice(0, 500)),
      options: parseOptions(options), openQuestions: lines(questions).slice(0, 8).map((item) => item.slice(0, 300)) },
    where === "company" ? { level: "company" } : { level: "battlefield", battlefieldId: where });
  };
  const field = (label: string, value: string, set: (value: string) => void, rows: number, placeholder?: string) => (
    <label className={s.field}>
      <span>{label}</span>
      <textarea className={s.input} rows={rows} value={value} placeholder={placeholder} onChange={(event) => set(event.target.value)} />
    </label>
  );
  return (
    <form className={s.editor} onSubmit={(event) => { event.preventDefault(); submit(); }} data-testid="issue-draft-editor">
      <label className={s.field}>
        <span>标题</span>
        <input className={s.input} value={title} maxLength={25} onChange={(event) => setTitle(event.target.value)} aria-invalid={!title.trim() || undefined} />
      </label>
      {field("为什么现在要议", whyNow, setWhyNow, 2)}
      {field("已形成的想法", ideas, setIdeas, 2)}
      {field("可选方案", options, setOptions, 2, "方案：取舍")}
      {field("还没定的问题", questions, setQuestions, 2)}
      <div className={s.field} role="radiogroup" aria-label="挂在">
        <span>挂在</span>
        <div className={s.places}>
          <button type="button" role="radio" className={s.place} aria-checked={where === "company"} onClick={() => setWhere("company")}>全局战略</button>
          {view.battlefields.map((field) => (
            <button key={field.id} type="button" role="radio" className={s.place} aria-checked={where === field.id} onClick={() => setWhere(field.id)}>{field.name}</button>
          ))}
        </div>
      </div>
      <div className={s.actions}>
        <Button variant="primary" className={r.primary} type="submit" isDisabled={busy || !ready}>建议题</Button>
        <Button variant="ghost" className={r.ghost} isDisabled={busy} onPress={onCancel}>取消</Button>
      </div>
    </form>
  );
}
