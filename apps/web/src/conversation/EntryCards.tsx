"use client";

/**
 * 回答后面挂的卡（对话里的一句话入口，apps/api/src/conversationEntries.ts）：卡里只带对象 id，状态按 id 读最新的；
 * 发出、提交都走对象自己的 Action，本人点了才发。
 * - review：复盘草稿摘要与「打开修改」（参照 Notion AI / Linear 生成内容后的「打开」卡）；
 * - todo_pick：对上几件待办，点一件再查有没有人问过、整理问题（参照 Slack 的消息内选择）；
 * - todo_ask：「问巨杰（备案信息表，昨天 16:20）：……　[发送]」，问题可以改（参照 Superhuman 发送前预览）；
 * - todo_answer：已有人问过的答案原文与出处，仍可以问；
 * - request_draft：本人发起的请求草稿，与请求页同一套收件人、要你定和发送；
 * - questions：Agent 的提问与「开始回答」（AskPanel，一题一页作答）。
 * - collection_draft：本人发起的信息收集草稿（表头、收件人、截止、每周固定和发送）。
 * 已经发过的（读回历史时）按对象的最新状态显示成「已问」「已发出」。
 */
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, ChevronRight } from "lucide-react";
import { Button } from "ts-design/primitives";
import type { TConversationCard, TPersonalReviewPayload, TRequestStep, TRequestView, TWeeklyReviewPayload } from "@warmap/contracts";
import { StepList, type Step } from "@/components/steps/StepList";
import { AskCard } from "./AskPanel";
import { useWorkspace } from "@/components/shell/WorkspaceContext";
import { DraftRequest } from "@/components/requests/RequestScreen";
import { CollectionDraftCard } from "@/components/collections/CollectionDraft";
import { prepareQuestion, readRequest, requestError, runRequestAction } from "@/components/requests/requestApi";
import { browserApi } from "@/lib/api/client";
import { relativeDayTime } from "@/lib/companyTime";
import r from "@/components/requests/requests.module.css";
import s from "@/styles/entry-cards.module.css";

type Answer = { text: string; source: "body" | "question"; questionId: string | null };
/** 头像上的字：三个字的名字取名（「斯一」），两个字的取全名，和飞书一样。 */
const initial = (name: string) => { const chars = [...name.trim()]; return chars.length >= 3 ? chars.slice(-2).join("") : chars.join(""); };
const toSteps = (steps: TRequestStep[]): Step[] =>
  steps.map((step) => ({ id: step.label, label: step.label, status: step.status === "current" ? "active" : step.status, ...(step.result ? { result: step.result } : {}) }));
/** 读回历史时判断「这张卡之后本人已经问过」：本人在这条请求上、在卡出现之后提的问题。 */
const askedAfter = (request: TRequestView, since?: string) => {
  const me = request.actions.find((action) => action.actionType === "request.ask")?.itemId;
  const from = since ? Date.parse(since) - 1000 : 0;
  return [...request.questions].reverse().find((question) => (me ? question.askerId === me : false) && Date.parse(question.createdAt) >= from) ?? null;
};

export function EntryCards({ cards, createdAt }: { cards: TConversationCard[]; createdAt?: string }) {
  if (!cards.length) return null;
  return (
    <div className={s.cards} data-testid="entry-cards">
      {cards.map((card, index) => <EntryCard key={`${card.kind}-${index}`} card={card} createdAt={createdAt} />)}
    </div>
  );
}

function EntryCard({ card, createdAt }: { card: TConversationCard; createdAt?: string }) {
  switch (card.kind) {
    case "review": return <ReviewCard id={card.personalReviewId} href={card.href} />;
    case "weekly_review": return <WeeklyReviewCard id={card.weeklyReviewId} href={card.href} />;
    case "todo_pick": return <PickCard card={card} createdAt={createdAt} />;
    case "todo_ask": return <section className={s.card} aria-label="提问预览"><AskFlow requestId={card.requestId} href={card.href} question={card.question} createdAt={createdAt} /></section>;
    case "todo_answer": return (
      <section className={s.card} aria-label="已有答案">
        <AskFlow requestId={card.requestId} href={card.href} question={card.question} createdAt={createdAt}
          answer={{ text: card.answer, source: card.source, questionId: card.questionId }} />
      </section>
    );
    case "request_draft": return <RequestDraftCard requestId={card.requestId} href={card.href} />;
    case "questions": return <AskCard card={card} />;
    case "collection_draft": return <section className={`${s.card} ${s.bare}`}><CollectionDraftCard collectionId={card.collectionId} /></section>;
  }
}

/* ---------- 帮我问问 ---------- */

/** 查完以后的样子：有答案先给答案（可以仍要问）；没有就是可改的问题预览和「发送」；发过了是「已问」。 */
function AskFlow({ requestId, href, question, answer, createdAt }: { requestId: string; href: string; question: string; answer?: Answer | null; createdAt?: string }) {
  const { navigate } = useWorkspace();
  const [request, setRequest] = useState<TRequestView | null>(null);
  const [failed, setFailed] = useState(false);
  const [phase, setPhase] = useState<"found" | "preview" | "sending">(answer ? "found" : "preview");
  const [text, setText] = useState(question);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    readRequest(requestId).then((view) => { if (live) setRequest(view); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [requestId]);

  if (failed) return <p className={s.muted}>待办已不可见</p>;
  if (!request) return <div className={s.placeholder} aria-busy="true" />;
  const asked = askedAfter(request, createdAt);
  const ask = request.actions.find((action) => action.actionType === "request.ask");
  const to = (
    <div className={r.askTo}>问 <strong>{request.initiator.displayName}</strong><span>（{request.title}，{relativeDayTime(request.sentAt)}）</span></div>
  );
  const open = <Button variant="ghost" className={r.ghost} onPress={() => navigate(href)}>打开待办</Button>;

  if (asked) {
    return (
      <div className={s.flow}>
        <div className={s.done}><Check size={14} strokeWidth={2.6} aria-hidden="true" />已问 <strong>{request.initiator.displayName}</strong><time>{relativeDayTime(asked.createdAt)}</time></div>
        <p className={s.quoted}>{asked.question}</p>
        {asked.answer ? <blockquote className={s.reply}><span>{request.initiator.displayName}</span>{asked.answer}</blockquote> : null}
        <div className={r.replyBar}>{open}</div>
      </div>
    );
  }
  if (phase === "found" && answer) {
    const replied = answer.questionId ? request.questions.find((item) => item.id === answer.questionId) : undefined;
    return (
      <div className={s.flow}>
        <div className={r.found}><blockquote>{answer.text}</blockquote></div>
        <div className={s.source}>
          {answer.source === "question" ? <>{request.initiator.displayName}答过{replied?.answeredAt ? ` · ${relativeDayTime(replied.answeredAt)}` : ""}</> : "说明里写了"}
          <span>{request.title}</span>
        </div>
        <div className={r.replyBar}>
          {open}
          {ask ? <Button variant="ghost" className={r.ghost} onPress={() => setPhase("preview")}>仍要问</Button> : null}
        </div>
      </div>
    );
  }
  if (!ask) {
    return <div className={s.flow}>{to}<p className={s.muted}>{request.viewer.myStatus === "done" ? "已完成" : "不能提问"}</p><div className={r.replyBar}>{open}</div></div>;
  }
  const send = async () => {
    if (!text.trim()) return;
    setPhase("sending"); setError("");
    try { setRequest(await runRequestAction(ask, { question: text.trim() })); }
    catch (cause) { setError(requestError(cause, "没有发出去，请重试")); }
    finally { setPhase("preview"); }
  };
  return (
    <div className={s.flow}>
      {to}
      <textarea className={s.question} aria-label="要问的问题" rows={2} maxLength={1000} value={text} disabled={phase === "sending"} onChange={(event) => setText(event.target.value)} />
      {error ? <p className={r.error} role="alert">{error}</p> : null}
      <div className={r.replyBar}>
        {open}
        <Button variant="primary" className={r.primary} isDisabled={phase === "sending" || !text.trim()} onPress={() => void send()}>
          <ArrowUp size={16} aria-hidden="true" />{phase === "sending" ? "发送中" : "发送"}
        </Button>
      </div>
    </div>
  );
}

/** 对上几件：点一件，就在卡里接着查有没有人问过、整理问题。读回历史时本人已经问过的那件直接显示「已问」。 */
function PickCard({ card, createdAt }: { card: Extract<TConversationCard, { kind: "todo_pick" }>; createdAt?: string }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [prepared, setPrepared] = useState<{ question: string; answer: Answer | null } | null>(null);
  const [error, setError] = useState("");
  const checked = useRef(false);
  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    void Promise.all(card.candidates.map((candidate) => readRequest(candidate.requestId).catch(() => null))).then((views) => {
      const index = views.findIndex((view) => view && askedAfter(view, createdAt));
      if (index >= 0) setChosen((current) => current ?? card.candidates[index].requestId);
    });
  }, [card.candidates, createdAt]);

  const choose = async (candidate: (typeof card.candidates)[number]) => {
    setChosen(candidate.requestId); setError(""); setPrepared(null);
    setSteps([
      { id: "定位待办", label: "定位待办", status: "done", result: `${candidate.initiatorName}：${candidate.title}` },
      { id: "查有没有人问过", label: "查有没有人问过", status: "active" },
      { id: "整理问题", label: "整理问题", status: "pending" },
      { id: "等你确认", label: "等你确认", status: "pending" },
    ]);
    try {
      const result = await prepareQuestion(candidate.requestId, card.question);
      setSteps(toSteps(result.steps));
      setPrepared({ question: result.question, answer: result.answer });
    } catch (cause) {
      setSteps(null); setChosen(null);
      setError(requestError(cause, "没有查成，请重试"));
    }
  };
  const picked = card.candidates.find((candidate) => candidate.requestId === chosen);
  return (
    <section className={s.card} aria-label="选一件待办">
      <ul className={s.picks} role="list">
        {(picked ? [picked] : card.candidates).map((candidate) => (
          <li key={candidate.requestId}>
            <button type="button" className={s.pick} aria-pressed={candidate.requestId === chosen} disabled={chosen !== null} onClick={() => void choose(candidate)}>
              <span className={r.avatar} aria-hidden="true">{initial(candidate.initiatorName)}</span>
              <span className={s.pickText}><strong>{candidate.title}</strong><small>{candidate.initiatorName} · {relativeDayTime(candidate.sentAt)}</small></span>
              {chosen ? null : <ChevronRight size={16} aria-hidden="true" className={s.chevron} />}
            </button>
          </li>
        ))}
      </ul>
      {error ? <p className={r.error} role="alert">{error}</p> : null}
      {steps ? <StepList steps={steps} className={s.steps} /> : null}
      {picked && (prepared || !steps) ? (
        <AskFlow key={picked.requestId} requestId={picked.requestId} href={picked.href} question={prepared?.question ?? card.question} answer={prepared?.answer ?? null} createdAt={createdAt} />
      ) : null}
    </section>
  );
}

/* ---------- 请同事帮忙 ---------- */

function RequestDraftCard({ requestId, href }: { requestId: string; href: string }) {
  const { navigate } = useWorkspace();
  const [request, setRequest] = useState<TRequestView | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    readRequest(requestId).then((view) => { if (live) setRequest(view); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [requestId]);
  if (failed) return <section className={s.card}><p className={s.muted}>请求已不可见</p></section>;
  if (!request) return <section className={s.card}><div className={s.placeholder} aria-busy="true" /></section>;
  if (request.status !== "draft") {
    return (
      <section className={s.card} aria-label="已发出的请求">
        <div className={s.done}><Check size={14} strokeWidth={2.6} aria-hidden="true" />已发给 <strong>{request.recipients.map((person) => person.displayName).join("、")}</strong><time>{relativeDayTime(request.sentAt)}</time></div>
        <p className={s.quoted}>{request.title}</p>
        <div className={r.replyBar}><Button variant="ghost" className={r.ghost} onPress={() => navigate(href)}>打开</Button></div>
      </section>
    );
  }
  return (
    <section className={`${s.card} ${s.bare}`} aria-label="请求草稿">
      <DraftRequest request={request} onChange={setRequest} onSent={setRequest} compact />
    </section>
  );
}

/* ---------- 生成复盘 ---------- */

const REVIEW_STATUS: Partial<Record<TPersonalReviewPayload["status"], { label: string; tone: "wait" | "done" | "draft" | "error" }>> = {
  drafting: { label: "生成中", tone: "wait" }, draft: { label: "草稿", tone: "draft" }, draft_failed: { label: "没生成成", tone: "error" },
  submitted: { label: "已提交", tone: "done" }, skipped: { label: "已跳过", tone: "draft" }, waiting: { label: "未生成", tone: "draft" },
};
const LINK = /\[([^\]\n]+)\]\(([^()\s]+)\)/g;
/** 摘要：总体结果的前几行，出处标记去掉（卡上不展开出处，打开复盘页再看）。 */
const leadLines = (text: string) => text.replace(LINK, "").replace(/[ \t]+([。，；])/g, "$1")
  .split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 3);
const summaryOf = (review: TPersonalReviewPayload) => leadLines(review.selfReview?.overall.text ?? "");

const WEEKLY_STATUS: Record<TWeeklyReviewPayload["status"], { label: string; tone: "wait" | "done" | "draft" | "error" }> = {
  drafting: { label: "生成中", tone: "wait" }, draft: { label: "草稿", tone: "draft" }, draft_failed: { label: "没生成成", tone: "error" }, submitted: { label: "已提交", tone: "done" },
};
const day = (value: string) => `${Number(value.slice(5, 7))}/${Number(value.slice(8))}`;

/** 周复盘草稿：本周总体判断的前几行与「打开修改」；生成中按步骤显示（别处点了重新生成时每几秒读一次）。 */
function WeeklyReviewCard({ id, href }: { id: string; href: string }) {
  const { navigate } = useWorkspace();
  const [review, setReview] = useState<TWeeklyReviewPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const drafting = review?.status === "drafting";
  useEffect(() => {
    let live = true;
    const load = async () => {
      const { data } = await browserApi.GET("/api/weekly-reviews/{weeklyReviewId}", { params: { path: { weeklyReviewId: id } } });
      if (!live) return;
      if (data) setReview(data.review); else setFailed(true);
    };
    void load().catch(() => { if (live) setFailed(true); });
    const timer = drafting ? window.setInterval(() => void load().catch(() => undefined), 3000) : undefined;
    return () => { live = false; if (timer) window.clearInterval(timer); };
  }, [id, drafting]);
  if (failed) return <section className={s.card}><p className={s.muted}>周复盘已不可见</p></section>;
  if (!review) return <section className={s.card}><div className={s.placeholder} aria-busy="true" /></section>;
  const status = WEEKLY_STATUS[review.status];
  const lines = leadLines(review.body?.overall.text ?? "");
  const kept = review.generationSteps.find((step) => step.id === "draft")?.result;
  const editable = review.status === "draft" || review.status === "draft_failed";
  return (
    <section className={s.card} aria-label="周复盘草稿" data-testid="weekly-review-card">
      <header className={s.head}>
        <h3>{day(review.weekStart)}–{day(review.weekEnd)} 周复盘</h3>
        <span className={r.chip} data-tone={status.tone === "error" ? undefined : status.tone} data-error={status.tone === "error" ? "" : undefined}>{status.label}</span>
      </header>
      {drafting ? <StepList className={s.steps} steps={review.generationSteps.map((step) => ({ id: step.id, label: step.label,
        status: step.status === "running" ? "active" : step.status === "failed" ? "stopped" : step.status, ...(step.result ? { result: step.result } : {}) }))} /> : null}
      {!drafting && lines.length ? <div className={s.summary}>{lines.map((line, index) => <p key={index}>{line}</p>)}</div> : null}
      {review.status === "draft_failed" && review.draftError ? <p className={r.error}>{review.draftError.message}</p> : null}
      <footer className={s.foot}>
        {kept && !drafting ? <span className={r.tag} data-tone="done">{kept}</span> : <span />}
        <Button variant="primary" className={r.primary} onPress={() => navigate(href)}>{editable ? "打开修改" : "打开"}<ChevronRight size={16} aria-hidden="true" /></Button>
      </footer>
    </section>
  );
}

function ReviewCard({ id, href }: { id: string; href: string }) {
  const { navigate } = useWorkspace();
  const [review, setReview] = useState<TPersonalReviewPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const drafting = review?.status === "drafting";
  useEffect(() => {
    let live = true;
    const load = async () => {
      const { data } = await browserApi.GET("/api/personal-reviews/{personalReviewId}", { params: { path: { personalReviewId: id } } });
      if (!live) return;
      if (data) setReview(data.review); else setFailed(true);
    };
    void load().catch(() => { if (live) setFailed(true); });
    // 生成中（别处点了重新生成）：每几秒读一次，直到出稿。
    const timer = drafting ? window.setInterval(() => void load().catch(() => undefined), 3000) : undefined;
    return () => { live = false; if (timer) window.clearInterval(timer); };
  }, [id, drafting]);
  if (failed) return <section className={s.card}><p className={s.muted}>复盘已不可见</p></section>;
  if (!review) return <section className={s.card}><div className={s.placeholder} aria-busy="true" /></section>;
  const status = REVIEW_STATUS[review.status];
  const kept = review.generationSteps.find((step) => step.id === "draft")?.result;
  const lines = summaryOf(review);
  const editable = review.status === "draft" || review.status === "draft_failed" || review.status === "waiting";
  return (
    <section className={s.card} aria-label="复盘草稿" data-testid="review-card">
      <header className={s.head}>
        <h3>{Number(review.period.slice(5))} 月复盘</h3>
        {status ? <span className={r.chip} data-tone={status.tone === "error" ? undefined : status.tone} data-error={status.tone === "error" ? "" : undefined}>{status.label}</span> : null}
      </header>
      {drafting ? <StepList className={s.steps} steps={review.generationSteps.map((step) => ({ id: step.id, label: step.label,
        status: step.status === "running" ? "active" : step.status === "failed" ? "stopped" : step.status, ...(step.result ? { result: step.result } : {}) }))} /> : null}
      {!drafting && lines.length ? <div className={s.summary}>{lines.map((line, index) => <p key={index}>{line}</p>)}</div> : null}
      {review.status === "draft_failed" && review.draftError ? <p className={r.error}>{review.draftError.message}</p> : null}
      <footer className={s.foot}>
        {kept && !drafting ? <span className={r.tag} data-tone="done">{kept}</span> : <span />}
        <Button variant="primary" className={r.primary} onPress={() => navigate(href)}>{editable ? "打开修改" : "打开"}<ChevronRight size={16} aria-hidden="true" /></Button>
      </footer>
    </section>
  );
}
